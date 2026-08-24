import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// MemoryService resolves its vault directory from process.cwd() at module
// load time — chdir into an isolated temp dir BEFORE importing the module.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-memory-'));
process.chdir(tmpRoot);

let MemoryService: typeof import('../src/memory.js').MemoryService;

beforeAll(async () => {
  ({ MemoryService } = await import('../src/memory.js'));
  await MemoryService.init();
});

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MemoryService', () => {
  it('starts with an empty index and creates the vault structure', async () => {
    const entries = await MemoryService.list();
    expect(entries).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpRoot, 'memory', 'vault', 'projects'))).toBe(true);
  });

  it('saves and lists memories with generated ids', async () => {
    const entry = await MemoryService.save({
      type: 'preferences',
      name: 'prefers-vitest',
      content: 'The user prefers Vitest for unit testing TypeScript projects.',
      tags: ['testing'],
    });
    expect(entry.id).toBeTruthy();
    const list = await MemoryService.list();
    expect(list.some(e => e.id === entry.id)).toBe(true);
  });

  it('finds memories by exact keyword', async () => {
    await MemoryService.save({
      type: 'knowledge',
      name: 'rose-router',
      content: 'Rose ModelRouter dispatches to GeminiProvider first when configured.',
    });
    const results = await MemoryService.search({ query: 'ModelRouter' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('finds memories by partial keyword (case-insensitive)', async () => {
    const results = await MemoryService.search({ query: 'vitest' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns no results for unrelated queries', async () => {
    const results = await MemoryService.search({ query: 'quantum-xylophone-nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('returns no results for empty queries without throwing', async () => {
    const results = await MemoryService.search({ query: '' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('scopes searches by project when project filter is provided', async () => {
    await MemoryService.save({
      type: 'projects',
      name: 'alpha-note',
      content: 'Alpha project uses port 4000.',
      project: 'alpha',
    });
    await MemoryService.save({
      type: 'projects',
      name: 'beta-note',
      content: 'Beta project uses port 5000.',
      project: 'beta',
    });

    const alphaOnly = await MemoryService.search({ query: 'port', project: 'alpha' });
    expect(alphaOnly.length).toBeGreaterThan(0);
    for (const r of alphaOnly) {
      expect(r.project).toBe('alpha');
    }
  });

  it('updates existing memories', async () => {
    const entry = await MemoryService.save({
      type: 'tasks',
      name: 'deploy-step',
      content: 'Deploy step one.',
    });
    const updated = await MemoryService.update(entry.id, { content: 'Deploy step one completed.' });
    expect(updated.content).toContain('completed');
  });

  it('deletes memories and they disappear from search', async () => {
    const entry = await MemoryService.save({
      type: 'knowledge',
      name: 'ephemeral-fact',
      content: 'Zebra unicorns graze in Zanzibar.',
    });
    await MemoryService.delete(entry.id);
    const results = await MemoryService.search({ query: 'Zanzibar' });
    expect(results.find(r => r.id === entry.id)).toBeUndefined();
  });

  it('formatContextBlock renders readable context', async () => {
    const entry = await MemoryService.save({
      type: 'knowledge',
      name: 'context-block-demo',
      content: 'Context block content.',
    });
    const block = MemoryService.formatContextBlock([entry]);
    expect(block).toContain('Context block content.');
  });
});
