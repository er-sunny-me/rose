import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dataDir } from './pairing.js';

/**
 * Phase 38 — Agent-to-Agent LINK registry (§5-9, §55).
 *
 * A "link" is an explicit, user-approved peer relationship between two
 * registered agents:  Agent A ↔ Agent B  via THIS server only.
 *
 * - Default is RESTRICTIVE (§8): nothing is linked until requested AND accepted.
 * - Trust states are NOT duplicated here — a link can only exist between
 *   devices DeviceRegistry already trusts; revocation tears links down.
 * - Durable in agent-links.json next to devices.json.
 */
export type LinkState = 'pending' | 'linked' | 'rejected';

export interface AgentLink {
    linkId: string;
    a: string;              // requester agentId
    b: string;              // target agentId
    state: LinkState;
    requestedBy: string;    // agentId | 'server'
    createdAt: number;
    updatedAt: number;
}

function file(): string { return path.join(dataDir(), 'agent-links.json'); }

export class AgentLinkRegistry {
    private static links: Map<string, AgentLink> | null = null;

    private static load(): Map<string, AgentLink> {
        if (this.links) return this.links;
        try {
            const f = file();
            if (fs.existsSync(f)) {
                this.links = new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))));
                return this.links;
            }
        } catch { /* corrupt → fresh */ }
        this.links = new Map();
        return this.links;
    }

    private static save(): void {
        try { fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(this.load()), null, 2), { mode: 0o600 }); } catch { /* ignore */ }
    }

    static request(from: string, to: string, requestedBy?: string): { ok: boolean; link?: AgentLink; reason?: string } {
        if (!from || !to) return { ok: false, reason: 'INVALID' };
        if (from === to) return { ok: false, reason: 'SELF_LINK' };
        const existing = this.findBetween(from, to);
        if (existing && existing.state === 'linked') return { ok: false, reason: 'ALREADY_LINKED', link: existing };
        if (existing && existing.state === 'pending') return { ok: false, reason: 'PENDING', link: existing };
        const link: AgentLink = {
            linkId: `link-${crypto.randomBytes(6).toString('hex')}`,
            a: from,
            b: to,
            state: 'pending',
            requestedBy: requestedBy ?? from,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.load().set(link.linkId, link);
        this.save();
        return { ok: true, link };
    }

    /** Normalize direction so lookups are order-independent. */
    private static keyOf(a: string, b: string): [string, string] { return a < b ? [a, b] : [b, a]; }

    static findBetween(a: string, b: string): AgentLink | undefined {
        const [x, y] = this.keyOf(a, b);
        for (const l of this.load().values()) {
            if ((l.a === x && l.b === y) || (l.a === y && l.b === x)) return l;
        }
        return undefined;
    }

    static get(linkId: string): AgentLink | undefined { return this.load().get(linkId); }

    static setState(linkId: string, state: LinkState): AgentLink | undefined {
        const l = this.load().get(linkId);
        if (!l) return undefined;
        l.state = state;
        l.updatedAt = Date.now();
        this.save();
        return l;
    }

    static removeBetween(a: string, b: string): boolean {
        const l = this.findBetween(a, b);
        if (!l) return false;
        this.load().delete(l.linkId);
        this.save();
        return true;
    }

    static list(): AgentLink[] { return [...this.load().values()]; }

    static listFor(agentId: string): AgentLink[] {
        return this.list().filter(l => l.a === agentId || l.b === agentId);
    }

    static isLinked(a: string, b: string): boolean {
        const l = this.findBetween(a, b);
        return !!l && l.state === 'linked';
    }

    /** Linked peer ids for an agent (only state==='linked'). */
    static peersOf(agentId: string): string[] {
        return this.listFor(agentId).filter(l => l.state === 'linked').map(l => (l.a === agentId ? l.b : l.a));
    }

    /** Drop every link touching revoked/blocked agents — called after trust changes. */
    static purgeFor(agentId: string): number {
        let n = 0;
        for (const l of this.listFor(agentId)) {
            this.load().delete(l.linkId);
            n++;
        }
        if (n) this.save();
        return n;
    }
}
