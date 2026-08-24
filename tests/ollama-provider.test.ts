import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-ollama-'));
process.chdir(tmpRoot);

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('OllamaProvider', () => {
  it('listModels returns [] when the daemon is offline (no crash)', async () => {
    const { OllamaProvider } = await import('../src/providers/ollama.js');
    // Nothing listens on this port.
    const models = await OllamaProvider.listModels('http://127.0.0.1:59998');
    expect(models).toEqual([]);
  });

  it('execute() throws a clear unreachable error when offline', async () => {
    const { OllamaProvider } = await import('../src/providers/ollama.js');
    const p = new (await import('../src/providers/ollama.js')).OllamaProvider('llama3', 'Local', undefined, 'http://127.0.0.1:59998');
    await expect(p.execute([{ role: 'user', content: 'hi' }])).rejects.toThrow(/unreachable/i);
    expect(p.health).toBe('DEGRADED');
  });

  it('chat round-trips against a mocked daemon and returns OpenAI-shaped replies', async () => {
    const fakeFetch = vi.fn(async (url: any, init?: any) => {
      void url; void init;
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'local hello' } }),
      } as any;
    });
    const g: any = globalThis;
    const original = g.fetch;
    g.fetch = fakeFetch;

    try {
      const { OllamaProvider } = await import('../src/providers/ollama.js');
      const p = new OllamaProvider('llama3', 'Local', undefined, 'http://127.0.0.1:59998');
      const res = await p.execute(
        [{ role: 'user', content: 'say hi' }],
        'be brief',
        64
      );
      expect(res.choices[0].message.content).toBe('local hello');
      expect(p.health).toBe('HEALTHY');

      const [calledUrl, calledInit] = fakeFetch.mock.calls[0];
      expect(String(calledUrl)).toContain('/api/chat');
      const body = JSON.parse(calledInit.body);
      expect(body.model).toBe('llama3');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].content).toBe('say hi');
      expect(body.options.num_predict).toBe(64);
    } finally {
      g.fetch = original;
    }
  });

  it('circuit opens after repeated failures', async () => {
    const { OllamaProvider } = await import('../src/providers/ollama.js');
    const p = new (await import('../src/providers/ollama.js')).OllamaProvider('m', 'Local', undefined, 'http://127.0.0.1:59998');
    for (let i = 0; i < 4; i++) {
      await p.execute([{ role: 'user', content: 'x' }]).catch(() => {});
    }
    expect(p.health).toBe('OPEN');
  });
});
