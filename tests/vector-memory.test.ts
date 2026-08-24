import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// MemoryService + VectorIndex resolve paths from process.cwd() at load time.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-vector-'));
process.chdir(tmpRoot);
process.env.ROSE_EMBEDDING_PROVIDER = 'local'; // deterministic, offline

const { MemoryService } = await import('../src/memory.js');
const { VectorIndex } = await import('../src/memory/vector-index.js');
const { chunkMarkdown } = await import('../src/memory/indexer.js');
const { LocalHashEmbeddingProvider, cosineSimilarity, contentHash } =
  await import('../src/memory/embedding.js');

beforeAll(async () => {
  await MemoryService.init();
});

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('chunking', () => {
  it('splits markdown on headings and paragraphs without breaking words', () => {
    const md = [
      '# Alpha',
      '',
      'Alpha paragraph one about databases.',
      '',
      'Alpha paragraph two about caching.',
      '',
      '# Beta',
      '',
      'Beta section discusses the model router.',
    ].join('\n');

    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some(c => c.includes('# Alpha') && c.includes('databases'))).toBe(true);
    expect(chunks.some(c => c.includes('# Beta') && c.includes('model router'))).toBe(true);
  });

  it('caps very long chunks near the size limit', () => {
    const longText = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with filler content.`.repeat(2)).join('\n\n');
    const chunks = chunkMarkdown(longText);
    for (const c of chunks) expect(c.length).toBeLessThan(1200);
  });
});

describe('embeddings', () => {
  it('hash provider produces normalized deterministic vectors', async () => {
    const p = new LocalHashEmbeddingProvider();
    const a = await p.embed('the quick brown fox jumps over the lazy dog');
    const b = await p.embed('the quick brown fox jumps over the lazy dog');
    const c = await p.embed('completely unrelated quantum xylophone music');
    expect(a).toEqual(b);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.5);
  });

  it('similar texts score higher than dissimilar ones', async () => {
    const p = new LocalHashEmbeddingProvider();
    const base = await p.embed('Rose uses a model router to dispatch requests to Gemini providers.');
    const similar = await p.embed('The model router dispatches Gemini requests through providers.');
    const unlike = await p.embed('Gardening tips for growing roses in clay soil during spring.');
    const simScore = cosineSimilarity(base, similar);
    const disScore = cosineSimilarity(base, unlike);
    expect(simScore).toBeGreaterThan(disScore);
  });

  it('contentHash is stable and short', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
    expect(contentHash('abc')).toHaveLength(32);
  });
});

describe('VectorIndex', () => {
  it('caches embeddings by content hash (no re-embed of unchanged chunks)', async () => {
    const vault = path.join(tmpRoot, 'cache-test-vault');
    fs.mkdirSync(vault, { recursive: true });
    const idx = new VectorIndex(vault);

    const first = await idx.upsertChunk({
      chunkId: 'm1:0', sourceId: 'm1', sourceFile: 'a.md',
      content: 'Stable content for cache testing purposes.',
    });
    idx.persist();

    const idx2 = new VectorIndex(vault); // reload from disk
    const second = await idx2.upsertChunk({
      chunkId: 'm1:0', sourceId: 'm1', sourceFile: 'a.md',
      content: 'Stable content for cache testing purposes.',
    });
    expect(first).toBe('embedded');
    expect(second).toBe('cached');
  });

  it('treats a different embedding model version as invalidation (fresh index)', async () => {
    const vault = path.join(tmpRoot, 'version-vault');
    fs.mkdirSync(vault, { recursive: true });
    const v1 = new VectorIndex(vault);
    await v1.upsertChunk({ chunkId: 'x:0', sourceId: 'x', sourceFile: 'x.md', content: 'hello world' });
    v1.persist();
    expect(v1.size).toBe(1);

    // Simulate an upgraded embedding model by swapping the stored id.
    const file = path.join(vault, '.vector-index.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.embeddingModel = 'gemini:some-future-model';
    fs.writeFileSync(file, JSON.stringify(parsed));

    const v2 = new VectorIndex(vault);
    expect(v2.size).toBe(0); // old vectors discarded
  });

  it('recovers from a corrupt index file instead of crashing', async () => {
    const vault = path.join(tmpRoot, 'corrupt-vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, '.vector-index.json'), '{ not valid json !!', 'utf-8');
    const idx = new VectorIndex(vault);
    expect(idx.size).toBe(0);
    await idx.upsertChunk({ chunkId: 'y:0', sourceId: 'y', sourceFile: 'y.md', content: 'recovery check' });
    expect(idx.size).toBe(1);
  });

  it('enforces project isolation in search results', async () => {
    const vault = path.join(tmpRoot, 'isolation-vault');
    fs.mkdirSync(vault, { recursive: true });
    const idx = new VectorIndex(vault);
    await idx.upsertChunk({ chunkId: 'p1:0', sourceId: 'p1', sourceFile: 'p1.md', project: 'alpha', content: 'alpha deployment pipeline uses vercel' });
    await idx.upsertChunk({ chunkId: 'p2:0', sourceId: 'p2', sourceFile: 'p2.md', project: 'beta', content: 'beta deployment pipeline uses flyio' });

    const q = await idx.embedQuery('deployment pipeline');
    const alphaOnly = idx.search(q, { project: 'alpha' });
    const betaOnly = idx.search(q, { project: 'beta' });

    expect(alphaOnly.length).toBeGreaterThan(0);
    expect(betaOnly.length).toBeGreaterThan(0);
    expect(alphaOnly.every(r => r.project === 'alpha')).toBe(true);
    expect(betaOnly.every(r => r.project === 'beta')).toBe(true);
  });

  it('removes vectors when the owning memory is deleted', async () => {
    const vault = path.join(tmpRoot, 'deletion-vault');
    fs.mkdirSync(vault, { recursive: true });
    const idx = new VectorIndex(vault);
    await idx.upsertChunk({ chunkId: 'z:0', sourceId: 'z', sourceFile: 'z.md', content: 'temporary memory for deletion test' });
    expect(idx.hasSource('z')).toBe(true);
    idx.removeSource('z');
    expect(idx.hasSource('z')).toBe(false);
    expect(idx.size).toBe(0);
  });
});

describe('hybrid retrieval via MemoryService', () => {
  it('fuses keyword and semantic hits; falls back cleanly on empty query', async () => {
    await MemoryService.save({
      type: 'knowledge',
      name: 'vector-db-choice',
      content: 'Rose selected sqlite-vec alternative: custom JSON vector index with hashed embeddings.',
    });
    await MemoryService.save({
      type: 'knowledge',
      name: 'gardening-notes',
      content: 'Tomatoes need full sun and weekly watering in summer.',
    });

    const semanticish = await MemoryService.searchHybrid({ query: 'vector index embeddings selection' });
    expect(semanticish.length).toBeGreaterThan(0);
    expect(semanticish.some(e => e.name === 'vector-db-choice')).toBe(true);

    const empty = await MemoryService.searchHybrid({ query: '' });
    expect(Array.isArray(empty)).toBe(true);
  });

  it('never leaks other projects under scoped queries', async () => {
    await MemoryService.save({ type: 'projects', name: 'secret-alpha', content: 'alpha secret sauce ingredient list', project: 'alpha' });
    const scoped = await MemoryService.searchHybrid({ query: 'secret sauce ingredient', project: 'unrelated-project' });
    // Keyword layer allows globals only when no exact project match exists;
    // the vector layer must never surface alpha's private note here.
    for (const r of scoped) {
      if (r.name === 'secret-alpha') throw new Error('project isolation violated');
    }
  });
});
