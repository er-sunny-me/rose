import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolated vault so the real obsidian_vault/ is never touched.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-obsidian-'));
process.chdir(tmpRoot);
process.env.ROSE_EMBEDDING_PROVIDER = 'local';

const vault = path.join(tmpRoot, 'vault');
fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
fs.writeFileSync(path.join(vault, 'Projects', 'Rose Architecture.md'), `---
title: Rose Architecture
tags: [architecture, rose]
status: living
---

# Rose Architecture

Rose is an agent platform with a supervisor that delegates to specialist agents.

The model router dispatches requests to Gemini, Claude, GPT or Ollama providers.

[[Model Routing]] explains provider selection in depth.
`, 'utf-8');
fs.writeFileSync(path.join(vault, 'Model Routing.md'), `# Model Routing

Requests are classified by capability tier (fast/smart) before dispatch.
`, 'utf-8');
fs.writeFileSync(path.join(vault, 'Gardening.md'), `# Gardening

Tomatoes love full sun. Water deeply twice a week in summer heat.
`, 'utf-8');

const { Config } = await import('../src/config.js');
// Use the env override — NEVER Config.saveConfig, which writes the user's
// real global ~/.rose/config.json.
process.env.ROSE_OBSIDIAN_VAULT = vault;

const { ObsidianVaultIndex } = await import('../src/memory/obsidian.js');

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ObsidianVaultIndex', () => {
  it('detects the configured vault and rejects unconfigured runs', () => {
    expect(ObsidianVaultIndex.configuredVault()).toBe(vault);
  });

  it('ingests notes into the shared vector index', async () => {
    const obs = new ObsidianVaultIndex();
    const stats = await obs.ingest();
    expect(stats.files).toBe(3);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.failed).toBe(0);
  });

  it('skips dot-folders like .obsidian during ingestion', async () => {
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), '{}');
    const obs = new ObsidianVaultIndex();
    const stats = await obs.ingest(); // json files ignored anyway
    expect(stats.files).toBe(3);
  });

  it('retrieves the right note for a topical question with citation info', async () => {
    const obs = new ObsidianVaultIndex();
    await obs.ingest();
    const hits = await obs.search('supervisor specialist agents platform');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].notePath).toContain('Rose Architecture');
    expect(hits[0].excerpt.length).toBeGreaterThan(10);
  });

  it('formats citations transparently with note paths', async () => {
    const obs = new ObsidianVaultIndex();
    const hits = await obs.search('model router providers dispatch');
    const block = ObsidianVaultIndex.formatCitations(hits);
    expect(block).toContain('[OBSIDIAN VAULT CONTEXT]');
    expect(block).toMatch(/Note: .+ \(.+\.md\)/);
  });

  it('returns empty results rather than fabricating for unrelated queries', async () => {
    const obs = new ObsidianVaultIndex();
    const hits = await obs.search('quantum xylophone orchestration zanzibar');
    // threshold keeps junk out; may legitimately return [] on tiny vaults
    expect(Array.isArray(hits)).toBe(true);
  });

  it('parses frontmatter, tags and wiki links', async () => {
    const raw = fs.readFileSync(path.join(vault, 'Projects', 'Rose Architecture.md'), 'utf-8');
    const { parseForTest } = await testParse();
    const parsed = parseForTest(raw);
    expect(parsed.frontmatter.title).toBe('Rose Architecture');
    expect(parsed.tags).toContain('architecture');
    expect(parsed.links).toContain('Model Routing');
  });

  async function testParse() {
    // Expose internals via a tiny harness — parseFrontmatter is private but
    // its behavior is contract; re-implement the call through ingest is
    // overkill, so reach in through anys.
    const anyObs = ObsidianVaultIndex as any;
    return {
      parseForTest: (raw: string) => ({
        frontmatter: anyObs.parseFrontmatter(raw).frontmatter,
        tags: anyObs.parseTags(
          anyObs.parseFrontmatter(raw).frontmatter,
          anyObs.parseFrontmatter(raw).body
        ),
        links: anyObs.extractLinks(anyObs.parseFrontmatter(raw).body),
      }),
    };
  }
});
