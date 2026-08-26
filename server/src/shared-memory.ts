import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dataDir } from './pairing.js';

/**
 * Shared project memory (Phase 37 §30-38, 94-95).
 *
 * - NOTHING is shared by default; scope is explicit on every share
 *   (private never reaches the server)
 * - vectors are computed by the SENDING agent via its own embedding provider —
 *   this server stays AI-free and only stores/returns what it is given
 * - conflict rule: re-sharing a memoryId requires an INCREASED version;
 *   equal/lower versions return CONFLICT instead of overwriting
 */
export type ShareScope = 'shared-project' | 'shared-task' | 'shared-goal';

export interface SharedMemoryEntry {
    memoryId: string;
    ownerAgent: string;
    scope: ShareScope;
    project?: string;
    taskId?: string;
    goalId?: string;
    title: string;
    content: string;
    tags: string[];
    version: number;
    updatedAt: number;
    vector?: number[];
}

export type ShareOutcome =
    | { ok: true; entry: SharedMemoryEntry }
    | { ok: false; reason: 'CONFLICT'; currentVersion: number }
    | { ok: false; reason: 'PRIVATE_SCOPE' | 'INVALID' };

const MAX_VECTOR_DIM = 4096;

function file(): string { return path.join(dataDir(), 'shared-memory.json'); }

export class SharedMemoryStore {
    private static entries: Map<string, SharedMemoryEntry> | null = null;

    private static load(): Map<string, SharedMemoryEntry> {
        if (this.entries) return this.entries;
        try {
            const f = file();
            if (fs.existsSync(f)) {
                this.entries = new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))));
                return this.entries;
            }
        } catch { /* corrupt → fresh */ }
        this.entries = new Map();
        return this.entries;
    }

    private static save(): void {
        try { fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(this.load()), null, 2), { mode: 0o600 }); } catch { /* ignore */ }
    }

    static share(input: {
        ownerAgent: string; memoryId: string; scope: ShareScope | 'private';
        title?: string; content?: string; project?: string; taskId?: string; goalId?: string;
        tags?: string[]; version?: number; vector?: number[];
    }): ShareOutcome {
        if (!input.ownerAgent || !input.memoryId || input.scope === 'private') {
            return { ok: false, reason: input.scope === 'private' ? 'PRIVATE_SCOPE' : 'INVALID' };
        }
        const key = `${input.ownerAgent}:${input.memoryId}`;
        const cur = this.load().get(key);
        const version = Math.max(1, Math.floor(Number(input.version ?? 1)));
        if (cur && version <= cur.version) {
            return { ok: false, reason: 'CONFLICT', currentVersion: cur.version };
        }
        const vector = Array.isArray(input.vector) && input.vector.length > 0 && input.vector.length <= MAX_VECTOR_DIM
            ? input.vector.map(Number).slice(0, MAX_VECTOR_DIM)
            : undefined;

        const entry: SharedMemoryEntry = {
            memoryId: String(input.memoryId),
            ownerAgent: input.ownerAgent,
            scope: input.scope,
            project: input.project ? String(input.project) : undefined,
            taskId: input.taskId ? String(input.taskId) : undefined,
            goalId: input.goalId ? String(input.goalId) : undefined,
            title: String(input.title ?? input.memoryId).slice(0, 200),
            content: String(input.content ?? '').slice(0, 64_000),
            tags: (input.tags ?? []).map(String).slice(0, 20),
            version,
            updatedAt: Date.now(),
            vector,
        };
        this.load().set(key, entry);
        this.save();
        return { ok: true, entry };
    }

    static visibleTo(agentId: string, opts: { project?: string; q?: string } = {}): SharedMemoryEntry[] {
        let out = [...this.load().values()].filter(e =>
            e.ownerAgent === agentId ||
            e.scope === 'shared-project' || e.scope === 'shared-task' || e.scope === 'shared-goal');
        if (opts.project) out = out.filter(e => e.project === opts.project);
        if (opts.q) {
            const q = opts.q.toLowerCase();
            out = out.filter(e =>
                e.title.toLowerCase().includes(q) ||
                e.content.toLowerCase().includes(q) ||
                e.tags.some(t => t.toLowerCase().includes(q)));
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    static searchVector(agentId: string, vector: number[], limit = 5): Array<{ entry: SharedMemoryEntry; score: number }> {
        return this.visibleTo(agentId)
            .filter(e => Array.isArray(e.vector))
            .map(e => ({ entry: e, score: cosine(vector, e.vector!) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    static count(): number { return this.load().size; }
}

function cosine(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Convenience for tests/tools. */
export function hashOf(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}
