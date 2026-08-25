import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-p36b-'));
process.chdir(tmpRoot);
process.env.ROSE_EMBEDDING_PROVIDER = 'local';

const { MemoryService } = await import('../src/memory.js');
const { MemoryConsolidation } = await import('../src/memory/consolidation.js');
const { VectorIndex } = await import('../src/memory/vector-index.js');
const { openRepository } = await import('../src/memory/vector-repository.js');

beforeAll(async () => {
  await MemoryService.init();
});

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function backdate(entryId: string) {
  // rewrite the file's updated field to 10 days ago so age gate passes
  const vault = path.join(tmpRoot, 'memory', 'vault');
  const find = (dir: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { const r = find(full); if (r) return r; }
      else if (d.name === `${entryId}.md`) return full;
    }
    return null;
  };
  const file = find(vault)!;
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const content = fs.readFileSync(file, 'utf-8')
    .replace(/^updated: .*$/m, `updated: ${old}`);
  fs.writeFileSync(file, content, 'utf-8');
  MemoryService.reloadIndex(); // index must reflect the backdated timestamp
}

describe('Phase 36 â€” memory consolidation', () => {
  it('collapses exact duplicates into one summary and ARCHIVES originals', async () => {
    const a = await MemoryService.save({ type: 'knowledge', name: 'dup-note', content: 'The deploy pipeline uses GitHub Actions on main.' });
    const b = await MemoryService.save({ type: 'knowledge', name: 'dup-note-copy', content: 'The deploy pipeline uses GitHub Actions on main.' });
    backdate(a.id);
    backdate(b.id);

    const result = await MemoryConsolidation.run();
    expect(result.clustersFound).toBeGreaterThanOrEqual(1);
    expect(result.archived).toBeGreaterThanOrEqual(2);

    // Originals are gone from active searchâ€¦
    const stillThere = await MemoryService.search({ query: 'deploy pipeline' });
    for (const s of stillThere) expect(s.name.startsWith('Consolidated')).toBe(true);

    // â€¦but preserved in _archived with evidence.
    const archiveDir = path.join(tmpRoot, 'memory', 'vault', '_archived');
    const archivedFiles = fs.readdirSync(archiveDir);
    expect(archivedFiles.length).toBeGreaterThanOrEqual(2);
    const sample = fs.readFileSync(path.join(archiveDir, archivedFiles[0]), 'utf-8');
    expect(sample).toContain('consolidated_into:');
    expect(sample).toContain('original_id:');
    expect(sample).toContain('reversible');
  });

  it('never touches protected types (preferences/research)', async () => {
    const pref = await MemoryService.save({ type: 'preferences', name: 'old-pref', content: 'user likes concise answers user likes concise answers' });
    backdate(pref.id);
    const before = await MemoryService.get(pref.id);
    await MemoryConsolidation.run();
    const after = await MemoryService.get(pref.id);
    expect(after).not.toBeNull();
    expect(before?.content).toBe(after?.content);
  });

  it('rollback is possible by restoring archived files', async () => {
    const archiveDir = path.join(tmpRoot, 'memory', 'vault', '_archived');
    const archived = fs.readdirSync(archiveDir);
    expect(archived.length).toBeGreaterThan(0);
    // Simulated rollback: copy an archived file's content back as a live memory
    const raw = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf-8');
    const body = raw.split('---').slice(2).join('---').trim();
    expect(body.length).toBeGreaterThan(5); // original content recoverable
    await MemoryService.save({ type: 'knowledge', name: 'restrolled-back', content: body });
    expect((await MemoryService.search({ query: 'restrolled-back' })).length).toBe(1);
  });

  it('runs cleanly and reports errors array even when nothing to do', async () => {
    const r = await MemoryConsolidation.run();
    expect(Array.isArray(r.errors)).toBe(true);
  });
});

describe('Phase 36 â€” SQLite vector backend', () => {
  it('opens a sqlite repository when better-sqlite3 works here', () => {
    const vault = path.join(tmpRoot, 'sqlite-vault');
    const { repo } = openRepository(vault, 'sqlite');
    // Either backend is acceptable â€” but the chosen one must WORK.
    repo.upsert({
      chunkId: 't:0', sourceId: 't', sourceFile: 't.md',
      content: 'sqlite roundtrip probe', contentHash: 'h1',
      project: undefined, scope: 'memory', createdAt: Date.now(),
      vector: new Array(16).fill(0.25),
    });
    expect(repo.count()).toBe(1);
    const hits = repo.search(new Array(16).fill(0.25), { topK: 3, threshold: 0.9 });
    expect(hits.length).toBe(1);
    repo.removeSource('t');
    expect(repo.count()).toBe(0);
  });

  it('project isolation holds in both backends', async () => {
    for (const backend of ['json', 'sqlite'] as const) {
      const vault = path.join(tmpRoot, `iso-${backend}`);
      const { repo } = openRepository(vault, backend);
      repo.upsert({ chunkId: 'a:0', sourceId: 'a', sourceFile: 'a.md', content: 'alpha secret sauce', contentHash: 'ha', project: 'alpha', scope: 'memory', createdAt: 1, vector: [1, 0, 0] });
      repo.upsert({ chunkId: 'b:0', sourceId: 'b', sourceFile: 'b.md', content: 'beta secret sauce', contentHash: 'hb', project: 'beta', scope: 'memory', createdAt: 1, vector: [0.99, 0.01, 0] });
      const hits = repo.search([1, 0, 0], { project: 'alpha', threshold: 0.1 });
      expect(hits.every(h => h.project === 'alpha')).toBe(true);
    }
  });

  it('VectorIndex facade works over whichever backend resolves', async () => {
    const vault = path.join(tmpRoot, 'facade-vault');
    const idx = new VectorIndex(vault);
    const first = await idx.upsertChunk({ chunkId: 'f:0', sourceId: 'f', sourceFile: 'f.md', content: 'cache me if you can' });
    idx.persist();
    const second = await new (idx.constructor as any)(vault)
      .upsertChunk({ chunkId: 'f:0', sourceId: 'f', sourceFile: 'f.md', content: 'cache me if you can' });
    expect(first).toBe('embedded');
    expect(second).toBe('cached');
  });
});




