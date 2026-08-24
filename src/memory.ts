import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { MemoryIndexer, type IndexStatus } from './memory/indexer.js';
import type { ResearchTask } from './research.js';
import { Config } from './config.js';

export interface MemoryEntry {
  id: string;
  type: string;
  name: string;
  created: string;
  updated: string;
  tags?: string[];
  project?: string;
  confidence?: number;
  importance?: number;
  content: string;
}

export interface MemorySearchOptions {
  query?: string;
  project?: string;
  type?: string;
  limit?: number;
}

export interface MemoryListOptions {
  project?: string;
  type?: string;
}

export class MemoryService {
  private static VAULT_DIR = path.join(process.cwd(), 'memory', 'vault');
  private static MEMORY_TYPES = ['projects', 'preferences', 'knowledge', 'tasks', 'conversations', 'research'];
  private static index: Map<string, MemoryEntry> = new Map();

  public static async init(): Promise<void> {
    this.ensureDirs();
    this.reloadIndex();
  }

  private static ensureDirs() {
    if (!fs.existsSync(this.VAULT_DIR)) {
      fs.mkdirSync(this.VAULT_DIR, { recursive: true });
    }
    for (const type of this.MEMORY_TYPES) {
      const dir = path.join(this.VAULT_DIR, type);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  public static reloadIndex() {
    this.index.clear();
    const files = this.getAllFiles(this.VAULT_DIR);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const entry = this.parseFile(file);
        if (entry) {
          this.index.set(entry.id, entry);
        }
      }
    }
    console.log(`[MEMORY] Index rebuilt. ${this.index.size} entries loaded.`);
  }

  private static getAllFiles(dir: string): string[] {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        results = results.concat(this.getAllFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    });
    return results;
  }

  private static parseFile(filePath: string): MemoryEntry | null {
    try {
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;
      
      const yaml = frontmatterMatch[1];
      const content = rawContent.substring(frontmatterMatch[0].length).trim();
      const id = path.basename(filePath, '.md');

      const extractValue = (key: string) => {
        const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return match ? match[1].trim() : undefined;
      };

      const extractList = (key: string) => {
        const match = yaml.match(new RegExp(`^${key}:\\s*\\n(?:\\s+-\\s+.+\\n?)+`, 'm'));
        if (match) {
            return match[0].split('\n')
                .filter(l => l.trim().startsWith('-'))
                .map(l => l.replace(/^\s*-\s*/, '').trim());
        }
        return [];
      };

      const type = extractValue('type') || 'knowledge';
      const name = extractValue('name') || 'Untitled';
      const created = extractValue('created') || new Date().toISOString();
      const updated = extractValue('updated') || new Date().toISOString();
      const project = extractValue('project');
      const confidence = extractValue('confidence') ? parseFloat(extractValue('confidence')!) : undefined;
      const importance = extractValue('importance') ? parseInt(extractValue('importance')!, 10) : undefined;
      const tags = extractList('tags');

      return {
        id,
        type,
        name,
        created,
        updated,
        project,
        confidence,
        importance,
        tags,
        content
      };
    } catch (err) {
      console.error(`[MEMORY] Error parsing ${filePath}:`, err);
      return null;
    }
  }

  private static generateMarkdown(entry: MemoryEntry): string {
    let yaml = `---\n`;
    yaml += `type: ${entry.type}\n`;
    yaml += `name: ${entry.name}\n`;
    yaml += `created: ${entry.created}\n`;
    yaml += `updated: ${entry.updated}\n`;
    if (entry.project) yaml += `project: ${entry.project}\n`;
    if (entry.confidence !== undefined) yaml += `confidence: ${entry.confidence}\n`;
    if (entry.importance !== undefined) yaml += `importance: ${entry.importance}\n`;
    if (entry.tags && entry.tags.length > 0) {
      yaml += `tags:\n${entry.tags.map(t => `  - ${t}`).join('\n')}\n`;
    }
    yaml += `---\n\n`;
    yaml += `${entry.content}\n`;
    return yaml;
  }

  private static getFilePath(type: string, id: string): string {
    const typeDir = this.MEMORY_TYPES.includes(type) ? type : 'knowledge';
    return path.join(this.VAULT_DIR, typeDir, `${id}.md`);
  }

  public static async save(entry: Partial<MemoryEntry>): Promise<MemoryEntry> {
    const id = entry.id || crypto.randomBytes(4).toString('hex');
    const type = entry.type || 'knowledge';
    
    // Deduplication check
    if (!entry.id) {
       const existing = await this.search({ query: entry.name, project: entry.project, limit: 10 });
       for (const ext of existing) {
         if (ext.name.toLowerCase() === (entry.name || '').toLowerCase() && ext.type === type) {
           return this.update(ext.id, { content: ext.content + '\n\n## Update\n' + entry.content, updated: new Date().toISOString() });
         }
       }
    }

    const newEntry: MemoryEntry = {
      id,
      type,
      name: entry.name || 'Untitled',
      created: entry.created || new Date().toISOString(),
      updated: new Date().toISOString(),
      project: entry.project,
      confidence: entry.confidence,
      importance: entry.importance,
      tags: entry.tags || [],
      content: entry.content || ''
    };

    const filePath = this.getFilePath(type, id);
    fs.writeFileSync(filePath, this.generateMarkdown(newEntry), 'utf8');
    this.index.set(id, newEntry);
    void this.indexEntry(newEntry);
    this.mirrorToObsidian(filePath, newEntry);
    this.enforceRetention(type);
    console.log(`[MEMORY] Saved entry ${id} (${newEntry.name})`);
    return newEntry;
  }

  /**
   * Phase 33: when an Obsidian vault is configured, saved entries are mirrored
   * into `<vault>/Rose Memory/` so they appear in the user's vault.
   */
  private static mirrorToObsidian(sourcePath: string, entry: MemoryEntry): void {
    try {
      const vault = Config.get().memory?.obsidianVaultPath;
      if (!vault) return;
      if (!fs.existsSync(vault)) return; // honest no-op: never fabricate folders silently
      const targetDir = path.join(vault, 'Rose Memory');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(targetDir, `${entry.id}.md`));
    } catch (err) {
      // Mirroring must never break saving.
      console.error('[MEMORY] Obsidian mirror failed:', err);
    }
  }

  /** Phase 33: retention â€” keep at most maxEntriesPerType entries per type. */
  private static enforceRetention(type: string): void {
    try {
      const max = Config.get().memory?.maxEntriesPerType;
      if (!max || max < 10) return;
      const ofSameType = Array.from(this.index.values())
        .filter(e => e.type === type)
        .sort((a, b) => b.updated.localeCompare(a.updated));
      for (const stale of ofSameType.slice(max)) {
        const p = this.getFilePath(stale.type, stale.id);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        this.index.delete(stale.id);
      }
    } catch (err) {
      console.error('[MEMORY] Retention enforcement failed:', err);
    }
  }

  public static async update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry> {
    const existing = this.index.get(id);
    if (!existing) throw new Error(`Memory entry ${id} not found`);

    const updatedEntry: MemoryEntry = {
      ...existing,
      ...patch,
      updated: new Date().toISOString()
    };

    // If type changed, we might need to move the file
    if (patch.type && patch.type !== existing.type) {
      const oldPath = this.getFilePath(existing.type, existing.id);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const filePath = this.getFilePath(updatedEntry.type, id);
    fs.writeFileSync(filePath, this.generateMarkdown(updatedEntry), 'utf8');
    this.index.set(id, updatedEntry);
    void this.indexEntry(updatedEntry);
    console.log(`[MEMORY] Updated entry ${id}`);
    return updatedEntry;
  }

  public static async delete(id: string): Promise<void> {
    const existing = this.index.get(id);
    if (!existing) throw new Error(`Memory entry ${id} not found`);

    const filePath = this.getFilePath(existing.type, id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.index.delete(id);
    try { this.getIndexer().removeMemory(id); } catch { /* non-fatal */ }
    console.log(`[MEMORY] Deleted entry ${id}`);
  }

  public static async clear(): Promise<void> {
     for (const [id, entry] of this.index.entries()) {
        const filePath = this.getFilePath(entry.type, id);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
     }
     this.index.clear();
     console.log(`[MEMORY] Cleared all memory entries`);
  }

  public static async get(id: string): Promise<MemoryEntry | null> {
    return this.index.get(id) || null;
  }

  public static async list(options?: MemoryListOptions): Promise<MemoryEntry[]> {
    let results = Array.from(this.index.values());
    if (options?.project) {
      results = results.filter(r => r.project === options.project);
    }
    if (options?.type) {
      results = results.filter(r => r.type === options.type);
    }
    return results.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  public static async search(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    let results = Array.from(this.index.values());

    if (options.project) {
      // Prioritize project specific, but include globals (no project)
      results = results.filter(r => r.project === options.project || !r.project);
    }

    if (options.type) {
      results = results.filter(r => r.type === options.type);
    }

    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter(r => 
        r.name.toLowerCase().includes(q) || 
        r.content.toLowerCase().includes(q) ||
        (r.tags && r.tags.some(t => t.toLowerCase().includes(q)))
      );
    }

    // Sort by importance, then recency
    results.sort((a, b) => {
      const impA = a.importance || 0;
      const impB = b.importance || 0;
      if (impA !== impB) return impB - impA;
      return b.updated.localeCompare(a.updated);
    });

    const limit = options.limit || 5;
    return results.slice(0, limit);
  }

  public static formatContextBlock(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';
    let block = '\n\n[ACTIVE MEMORY CONTEXT]\nThe following durable memories and preferences are relevant to this request:\n\n';
    for (const entry of entries) {
      block += `--- Memory: ${entry.name} (${entry.type}) ---\n`;
      block += `${entry.content}\n\n`;
    }
    return block;
  }

  // â”€â”€â”€ Phase 34: semantic (vector) layer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private static vectorIndexer: MemoryIndexer | null = null;

  /** Lazily build the indexer over this vault (local-first embedding). */
  public static getIndexer(): MemoryIndexer {
    if (!this.vectorIndexer) {
      this.vectorIndexer = new MemoryIndexer(this.VAULT_DIR);
    }
    return this.vectorIndexer;
  }

  /**
   * Hybrid retrieval: keyword matching fused with vector similarity.
   * Falls back to pure keyword results when the embedding provider is
   * unavailable, so the agent never loses memory access.
   */
  public static async searchHybrid(options: MemorySearchOptions & { threshold?: number }): Promise<MemoryEntry[]> {
    const keyword = await this.search({ ...options, limit: options.limit || 10 });
    try {
      const hybrid = await this.getIndexer().searchHybrid(options.query || '', {
        keywordResults: keyword,
        limit: options.limit || 5,
        threshold: options.threshold,
        project: options.project,
        type: options.type,
      });
      // Semantic-only hits arrive as IndexableEntry; promote to full entries.
      return hybrid.map((e) => ({
        created: '',
        updated: '',
        ...e,
      }) as MemoryEntry);
    } catch {
      return keyword;
    }
  }

  /** Index one entry after it is written. */
  public static async indexEntry(entry: MemoryEntry): Promise<void> {
    try { await this.getIndexer().indexMemory(entry); } catch { /* non-fatal */ }
  }

  /** Rebuild the whole semantic index from disk. */
  public static async reindex(): Promise<IndexStatus> {
    this.vectorIndexer = null;
    return this.getIndexer().reindexAll();
  }

  /** Current index statistics. */
  public static indexStatus(): IndexStatus {
    return this.getIndexer().status();
  }

  public static async saveResearchTask(task: ResearchTask): Promise<void> {
    const yaml = `---
type: research
name: ${task.question}
created: ${new Date(task.createdAt).toISOString()}
updated: ${new Date(task.updatedAt).toISOString()}
status: ${task.status}
---`;
    const content = `${yaml}\n\n# Question\n${task.question}\n\n# Findings\n${task.findings.map(f => `- [${f.status}] ${f.claim}`).join('\n')}\n\n# Sources\n${task.sources.map(s => `- [${s.type}] ${s.title || s.uri || s.id}`).join('\n')}\n`;
    const filePath = path.join(this.VAULT_DIR, 'research', `${task.id}.md`);
    fs.writeFileSync(filePath, content, 'utf8');
    this.reloadIndex();
  }
}



