import { WebSocket } from 'ws';
import crypto from 'crypto';

/**
 * Live connection registry — in-memory ONLY (Phase 37 §70, extended Phase 38 §3).
 * Durable identity/trust lives in pairing.ts (devices.json); this map holds
 * just the live sockets + per-connection replay nonces + the runtime manifest.
 */
export interface AgentInfo {
    agentId: string;
    deviceId: string;
    displayName: string;
    platform: string;
    capabilities: string[];
    protocolVersion: number;
    runtimeVersion: string;
    status: 'online' | 'busy' | 'degraded';
    lastSeen: number;
    lastHeartbeat: number;
    ws: WebSocket;
    /** Replay protection: every inbound nonce is remembered per connection. */
    nonces: Set<string>;
    /** Phase 38 — generic agent identity (never hardcode device kinds). */
    agentType?: string;              // desktop-agent | android-agent | linux-agent | macos-agent | server-agent | docker-agent
    connectionId?: string;           // per-socket id, stamped by the server
    userScope?: string;              // account scope where applicable (§3)
    /** Phase 38 — dynamic capability manifest details (§10). */
    tools?: string[];
    skills?: string[];
    providers?: string[];
    memoryCapabilities?: string[];   // e.g. ['vector','obsidian']
    browser?: boolean;
    mcp?: boolean;
}

export interface MeshMetrics {
    startedAt: number;
    wsConnections: number;
    reconnects: number;
    messagesIn: number;
    delegations: number;
    delegationRejects: number;
    memoryShares: number;
    linkRequests: number;
    rejectedReplays: number;
    errors: number;
}

/** Simple process-lifetime counters surfaced via /api/mesh → metrics (§53). */
export const meshMetrics: MeshMetrics = {
    startedAt: Date.now(),
    wsConnections: 0,
    reconnects: 0,
    messagesIn: 0,
    delegations: 0,
    delegationRejects: 0,
    memoryShares: 0,
    linkRequests: 0,
    rejectedReplays: 0,
    errors: 0,
};

export class AgentRegistry {
    private agents = new Map<string, AgentInfo>();

    public register(agentId: string, info: Omit<AgentInfo, 'lastSeen' | 'lastHeartbeat'>) {
        // Supersede any older socket for the same agent.
        const prev = this.agents.get(agentId);
        if (prev && prev.ws.readyState === 1) {
            try { prev.ws.close(4000, 'superseded'); meshMetrics.reconnects++; } catch { /* ignore */ }
        }
        this.agents.set(agentId, { ...info, lastSeen: Date.now(), lastHeartbeat: Date.now() });
    }

    public updateHeartbeat(agentId: string, status?: AgentInfo['status']) {
        const agent = this.agents.get(agentId);
        if (!agent) return;
        agent.lastSeen = Date.now();
        agent.lastHeartbeat = Date.now();
        if (status && ['online', 'busy', 'degraded'].includes(status)) agent.status = status;
    }

    public remove(agentId: string) { this.agents.delete(agentId); }

    public get(agentId: string): AgentInfo | undefined { return this.agents.get(agentId); }

    public getAll(): AgentInfo[] { return Array.from(this.agents.values()); }

    public findByCapability(capability: string): AgentInfo[] {
        return this.getAll().filter(a => a.capabilities.includes(capability));
    }

    /** Agents whose heartbeats stopped are degraded but NOT forgotten (§15). */
    public sweepStale(timeoutMs: number): number {
        const now = Date.now();
        let changed = 0;
        for (const a of this.agents.values()) {
            if (now - a.lastHeartbeat > timeoutMs && a.status !== 'degraded') {
                a.status = 'degraded';
                changed++;
            }
        }
        return changed;
    }

    /** True when `nonce` is fresh for this agent; records it either way. */
    public consumeNonce(agentId: string, nonce: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent || !nonce || agent.nonces.has(nonce)) return false;
        agent.nonces.add(nonce);
        if (agent.nonces.size > 4096) {
            const it = agent.nonces.values();
            for (let i = 0; i < 512; i++) {
                const old = it.next();
                if (old.done) break;
                agent.nonces.delete(old.value);
            }
        }
        return true;
    }
}

/** sha256 helper shared with clients (Kotlin mirrors this exact formula). */
export function sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export const globalRegistry = new AgentRegistry();
