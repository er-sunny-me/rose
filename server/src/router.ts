import { globalRegistry, sha256Hex } from './registry.js';
import { DeviceRegistry } from './pairing.js';
import { WebSocket } from 'ws';

/**
 * Task coordination router (Phase 37 §19-26).
 *
 * - requiredCapabilities are a HARD filter: a task never lands on an agent
 *   lacking them, even if that agent is the only one online
 * - ownership is preserved end-to-end: originatingAgent / ownerAgent stay the
 *   delegating agent; executingAgent is stamped by the server
 */
export interface DelegationMessage {
    type: 'agent.task.delegate';
    taskId: string;
    goal: string;
    from: string;                       // stamped = owner/origin
    originAgent?: string;
    ownerAgent?: string;
    delegatedAgent?: string;
    requiredCapabilities?: string[];
    policy?: Record<string, unknown>;
    /** Phase 38 §8: agent-initiated routing may only consider these linked peers. */
    candidateFilter?: string[];
}

export interface RouteResult {
    ok: boolean;
    delegatedAgent?: string;
    reason?: string;
}

export function routeDelegation(msg: DelegationMessage): RouteResult {
    const required = Array.isArray(msg.requiredCapabilities) ? msg.requiredCapabilities.map(String) : [];
    const filter = Array.isArray(msg.candidateFilter) ? msg.candidateFilter.map(String) : null;

    let best: { agentId?: string; score: number } = { score: -1 };
    for (const c of globalRegistry.getAll()) {
        if (!c.agentId || c.agentId === msg.from) continue;

        // Phase 38 §8: agent-initiated routing is restricted to linked peers
        // when a filter is supplied (server-initiated passes no filter).
        if (filter && !filter.includes(c.agentId)) continue;

        // Trust gate: only devices the registry still trusts may execute.
        const dev = DeviceRegistry.get(c.agentId);
        if (!dev || !(dev.trust === 'trusted')) continue;

        const hasAll = required.every(rc => c.capabilities.includes(rc));
        if (required.length > 0 && !hasAll) continue; // hard requirement

        const score = required.length * 2 + (c.status === 'online' ? 1 : 0);
        if (score > best.score) best = { agentId: c.agentId, score };
    }

    if (!best.agentId) {
        return { ok: false, reason: 'no capable trusted agent online for required capabilities' };
    }

    const target = globalRegistry.get(best.agentId)!;
    const delegated: DelegationMessage & Record<string, unknown> = {
        ...msg,
        delegatedAgent: best.agentId,
        originAgent: msg.originAgent ?? msg.from,
        ownerAgent: msg.ownerAgent ?? msg.from,
    };
    try {
        target.ws.send(JSON.stringify(delegated));
        return { ok: true, delegatedAgent: best.agentId };
    } catch (e) {
        return { ok: false, reason: `send failed to ${best.agentId}` };
    }
}

/** Relay any message to a specific connected agent (results, approvals…). */
export function relayTo(agentId: string, payload: object): boolean {
    const target = globalRegistry.get(agentId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return false;
    try {
        target.ws.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

export { sha256Hex };
