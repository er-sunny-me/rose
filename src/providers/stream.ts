/**
 * Phase 36 Part E: shared streaming plumbing.
 *
 * A single StreamChunk contract flows Provider → ModelRouter → Agent Runtime
 * → API/CLI/Web so every surface renders the same stream (§50, §123).
 * No private chain-of-thought is ever emitted — only text deltas and
 * operational events (§53).
 */

export type StreamChunkType =
    | 'status'        // e.g. "routing to gemini-2.0-flash"
    | 'text.delta'    // incremental model text
    | 'tool.started'
    | 'tool.completed'
    | 'error'
    | 'done';

export interface StreamChunk {
    type: StreamChunkType;
    content?: string;
}

/** Bounded queue so slow clients cannot grow memory without limit (§56). */
export class BoundedAsyncQueue<T> implements AsyncIterableIterator<T> {
    private queue: T[] = [];
    private pending: ((r: IteratorResult<T>) => void) | null = null;
    private closed = false;
    private failure: Error | null = null;

    constructor(private readonly maxBuffered: number = 256) {}

    push(item: T): void {
        if (this.closed) return;
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            p({ value: item, done: false });
            return;
        }
        if (this.queue.length >= this.maxBuffered) {
            // Drop oldest rather than growing unbounded.
            this.queue.shift();
        }
        this.queue.push(item);
    }

    fail(err: Error): void {
        this.failure = err;
        this.closed = true;
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            p({ value: undefined as any, done: true });
        }
    }

    close(): void {
        this.closed = true;
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            p({ value: undefined as any, done: true });
        }
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }

    next(): Promise<IteratorResult<T>> {
        if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise(resolve => { this.pending = resolve; });
    }

    // Required by AsyncIterableIterator but cancellation is handled via close().
    return?(): Promise<IteratorResult<T>> {
        this.close();
        return Promise.resolve({ value: undefined as any, done: true });
    }
}

/**
 * Parse an SSE byte stream into data payloads. Handles multi-line events,
 * [DONE] sentinels are passed through for the caller to filter.
 */
export async function* sseLines(body: any): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line.startsWith('data:')) {
                yield line.slice(5).trim();
            }
        }
    }
}

/** Parse newline-delimited JSON (Ollama streaming shape). */
export async function* jsonLines(body: any): AsyncGenerator<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try { yield JSON.parse(line); } catch { /* skip malformed */ }
        }
    }
}
