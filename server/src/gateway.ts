import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import chalk from 'chalk';
import { DeviceRegistry, PROTOCOL_VERSION, CLOCK_SKEW_MS } from './pairing.js';
import { globalRegistry, sha256Hex, meshMetrics } from './registry.js';
import { routeDelegation, relayTo } from './router.js';
import { SharedMemoryStore } from './shared-memory.js';
import { AgentLinkRegistry } from './links.js';

/**
 * Mesh WebSocket gateway — Phase 37 lifecycle EXTENDED by Phase 38 (§30):
 *
 *   discovery → auth → capability exchange → presence → task coordination
 *   → AGENT↔AGENT LINKS → shared memory → config status → approvals
 *
 * Invariants:
 *  - clients never self-assign agentId/from/to (server stamps them)
 *  - replay: per-connection nonce cache; stale ts rejected (±30s)
 *  - heartbeat sweep marks silent agents degraded — registry state is KEPT
 *  - memory.* messages never trigger any AI/embedding call on this server
 *  - Phase 38: A→B delegation requires an explicit LINKED relationship;
 *    server-initiated delegation (REST, ownerAgent='server') is unchanged so
 *    the existing Mobile → AWS → PC flow keeps working byte-for-byte.
 */

export type TaskState = 'queued' | 'accepted' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';

interface TaskCoord {
    state: TaskState;
    ownerAgent?: string;
    originatingAgent?: string;
    executingAgent?: string;
    updatedAt: number;
}

const MAX_CHAIN_DEPTH = 6;

function dbg(...a: unknown[]): void {
    if (process.env.ROSE_MESH_DEBUG) console.error('[MESH-DBG]', ...a);
}

function newId(bytes = 6): string {
    return crypto.randomBytes(bytes).toString('hex');
}

function strArr(v: unknown, max: number): string[] {
    return Array.isArray(v) ? v.map(String).slice(0, max) : [];
}

/** Generic agent-type naming (§4) — never hardcode PC/Android/Mobile. */
function deriveAgentType(explicit: unknown, platform: string): string {
    const allowed = ['desktop-agent', 'android-agent', 'linux-agent', 'macos-agent', 'server-agent', 'docker-agent'];
    const e = String(explicit ?? '');
    if (allowed.includes(e)) return e;
    switch (platform) {
        case 'windows': case 'macos': return `${platform === 'windows' ? 'windows' : 'macos'}-desktop-agent`;
        case 'android': return 'android-agent';
        case 'linux': return 'linux-agent';
        default: return `${platform || 'unknown'}-agent`;
    }
}

export class MeshGateway {
    private wss = new WebSocketServer({ noServer: true });

    /** Recent mesh events for reconnect sync (§39): capped ring buffer. */
    private events: Array<{ ts: number; type: string; taskId?: string }> = [];
    /** Coordination state per delegated task (§21). */
    private tasks = new Map<string, TaskCoord>();
    /** Heartbeat timeout (ms) — overridable for tests. */
    public heartbeatTimeoutMs = 90_000;

    constructor() {
        this.wss.on('connection', this.handleConnection.bind(this));

        // Silent agents degrade; their durable state stays for reconciliation.
        const sweep = setInterval(() => {
            if (globalRegistry.sweepStale(this.heartbeatTimeoutMs) > 0) this.broadcastPresence();
        }, 30_000);
        sweep.unref?.();
    }

    public upgrade(request: IncomingMessage, socket: any, head: Buffer): void {
        const url = new URL(request.url ?? '/mesh/ws', `http://${request.headers.host || 'localhost'}`);
        if (!url.pathname.startsWith('/mesh/ws')) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }
        // Prefer Authorization: query strings can be retained in proxy logs.
        const authorization = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
        const knownToken = authorization || url.searchParams.get('token')?.trim() || '';
        const secretToken = (process.env.ROSE_API_TOKEN ?? '').trim();
        const supplied = Buffer.from(knownToken);
        const expected = Buffer.from(secretToken);
        const authenticated = supplied.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
        if (!authenticated) {
            console.warn('[MESH] rejected unauthenticated WebSocket upgrade');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(request, socket, head, ws => this.handleConnection(ws));
    }

    // ─── Public surface for REST routes ─────────────────────────

    public summary() {
        const agents = DeviceRegistry.list().map(d => {
            const live = globalRegistry.get(d.agentId);
            const status = d.trust === 'revoked' || d.trust === 'blocked'
                ? 'offline'
                : live ? live.status : 'offline';
            return {
                agentId: d.agentId,
                deviceId: d.deviceId,
                displayName: d.displayName,
                platform: d.platform,
                agentType: live?.agentType ?? d.resourceState?.agentType ?? undefined,
                connectionId: live?.connectionId,
                userScope: live?.userScope,
                trust: d.trust,
                capabilities: live?.capabilities ?? d.capabilities,
                tools: live?.tools ?? [],
                skills: live?.skills ?? [],
                providers: live?.providers ?? [],
                memoryCapabilities: live?.memoryCapabilities ?? [],
                browser: live?.browser ?? false,
                mcp: live?.mcp ?? false,
                runtimeVersion: d.runtimeVersion,
                protocolVersion: d.protocolVersion,
                status,
                lastSeen: live ? Date.now() : d.lastSeen,
            };
        });
        const activeTasks = [...this.tasks.values()].filter(t => !['completed', 'failed'].includes(t.state)).length;
        const links = AgentLinkRegistry.list().map(l => ({ ...l }));
        return {
            protocolVersion: PROTOCOL_VERSION,
            total: agents.length,
            online: agents.filter(a => a.status === 'online').length,
            degraded: agents.filter(a => a.status === 'degraded').length,
            offline: agents.filter(a => a.status === 'offline').length,
            activeTasks,
            activeLinks: links.filter(l => l.state === 'linked').length,
            links,
            sharedMemories: SharedMemoryStore.count(),
            tasks: this.taskList(),
            metrics: { ...meshMetrics, uptimeSec: Math.round((Date.now() - meshMetrics.startedAt) / 1000) },
            agents,
        };
    }

    /** Server-initiated delegation (CLI/Web "run on agent X") — unchanged by Phase 38. */
    public delegateTo(agentId: string, goal: string, requiredCapabilities: string[] = []): { ok: boolean; taskId?: string; error?: string } {        const target = globalRegistry.get(agentId);
        if (!target || target.ws.readyState !== WebSocket.OPEN) return { ok: false, error: 'Agent is offline.' };
        const taskId = `task-${newId(5)}`;
        this.tasks.set(taskId, { state: 'queued', ownerAgent: 'server', originatingAgent: 'server', executingAgent: agentId, updatedAt: Date.now() });
        this.pushEvent({ ts: Date.now(), type: 'agent.task.delegate', taskId });
        target.ws.send(JSON.stringify({
            type: 'agent.task.delegate', v: 1, nonce: newId(8), ts: Date.now(),
            from: 'server', to: agentId, taskId, goal, requiredCapabilities,
            originAgent: 'server', ownerAgent: 'server', originatingAgent: 'server', delegatedAgent: agentId,
            policy: { scope: 'delegated' },
        }));
        meshMetrics.delegations++;
        return { ok: true, taskId };
    }

    /** Notify both sides when a pending link is approved/rejected via REST (§7). */
    public notifyLinkStateChange(linkId: string, state: 'linked' | 'rejected'): void {
        const link = AgentLinkRegistry.get(linkId);
        if (!link) return;
        const accepted = state === 'linked';
        const notice = {
            type: accepted ? 'agent.link.accepted' : 'agent.link.rejected',
            v: 1, nonce: newId(6), ts: Date.now(),
            linkId: link.linkId, from: link.b, to: link.a,
            peer: accepted ? this.publicManifest(link.b) : undefined,
        };
        relayTo(link.a, notice);
        relayTo(link.b, { ...notice, from: link.a, to: link.b, peer: accepted ? this.publicManifest(link.a) : undefined });
        if (accepted) this.pushEvent({ ts: Date.now(), type: 'agent.linked' });
        this.broadcastPresence();
    }

    public taskList(): Array<{ taskId: string } & TaskCoord> {
        return [...this.tasks.entries()].map(([taskId, t]) => ({ taskId, ...t }));
    }

    // ─── Internals ──────────────────────────────────────────────

    private handleConnection(ws: WebSocket): void {
        let currentAgentId: string | null = null;
        let connectionId = newId(8);
        meshMetrics.wsConnections++;

        ws.on('message', (data: Buffer) => {
            if (data.length > 262_144) { ws.close(1009, 'too large'); meshMetrics.errors++; return; }
            meshMetrics.messagesIn++;
            let msg: any;
            try { msg = JSON.parse(data.toString('utf8')); } catch { ws.close(1002, 'bad json'); meshMetrics.errors++; return; }

            // ── hello: API password was verified during the WebSocket upgrade ──
            if (msg.type === 'hello') {
                if (Number(msg.protocolVersion) !== PROTOCOL_VERSION) {
                    ws.send(JSON.stringify({ type: 'error', code: 'VERSION_MISMATCH', expected: PROTOCOL_VERSION }));
                    ws.close(4000, 'version');
                    return;
                }
                const deviceId = String(msg.deviceId ?? '').slice(0, 64);
                const existing = deviceId ? DeviceRegistry.getByDeviceId(deviceId) : undefined;

                if (existing && (existing.trust === 'revoked' || existing.trust === 'blocked')) {
                    ws.send(JSON.stringify({ type: 'agent.revoked', reason: 'device revoked — re-pair required' }));
                    ws.close(4003, 'revoked');
                    return;
                }

                const platform = String(msg.platform ?? 'other');
                const manifest = {
                    agentType: deriveAgentType(msg.agentType, platform),
                    userScope: String(msg.userScope ?? '').slice(0, 64),
                    tools: strArr(msg.tools, 256),
                    skills: strArr(msg.skills, 128),
                    providers: strArr(msg.providers, 64),
                    memoryCapabilities: strArr(msg.memoryCapabilities, 32),
                    browser: !!msg.browser,
                    mcp: !!msg.mcp,
                };

                if (existing) {
                    currentAgentId = existing.agentId;
                    this.bindAgent(ws, existing.agentId, existing, msg, connectionId, manifest);
                    DeviceRegistry.touchPresence(existing.agentId, {
                        displayName: String(msg.displayName ?? existing.displayName).slice(0, 40),
                        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : existing.capabilities,
                        resourceState: { ...manifest },
                    });
                    ws.send(JSON.stringify({ type: 'welcome', v: 1, nonce: newId(4), ts: Date.now(), agentId: existing.agentId, trust: existing.trust, connectionId, serverTime: Date.now(), links: AgentLinkRegistry.peersOf(existing.agentId) }));
                    this.broadcastPresence();
                    return;
                }

                const dev = DeviceRegistry.register({
                    deviceId,
                    displayName: String(msg.displayName ?? 'Device').slice(0, 40),
                    platform,
                    runtimeVersion: String(msg.runtimeVersion ?? '0'),
                    // The WebSocket password is the sole authentication mechanism.
                    // Keep the field populated for on-disk registry compatibility.
                    deviceSecret: crypto.randomBytes(32).toString('base64url'),
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : [],
                });

                currentAgentId = dev.agentId;
                this.bindAgent(ws, dev.agentId, dev, msg, connectionId, manifest);
                DeviceRegistry.touchPresence(dev.agentId, { resourceState: { ...manifest } });
                ws.send(JSON.stringify({
                    type: 'welcome', v: 1, nonce: newId(4), ts: Date.now(),
                    agentId: dev.agentId, trust: dev.trust, connectionId, serverTime: Date.now(), links: [] as string[],
                }));
                console.log(chalk.green(`🔐 [MESH] Registered ${dev.displayName} → ${dev.agentId} (${dev.platform})`));
                this.pushEvent({ ts: Date.now(), type: 'agent.registered' });
                this.broadcastPresence();
                return;
            }

            // Everything below requires an authenticated agent.
            if (!currentAgentId) {
                console.warn(chalk.yellow('[Gateway] dropped message from unauthenticated connection'));
                return;
            }

            // Replay + clock-skew guards (§60, §29)
            const skew = Math.abs(Date.now() - Number(msg.ts ?? 0));
            if (!Number.isFinite(skew) || skew > CLOCK_SKEW_MS) {
                ws.send(JSON.stringify({ type: 'error', code: 'CLOCK_SKEW', echoNonce: msg.nonce }));
                return;
            }
            if (typeof msg.nonce !== 'string' || !globalRegistry.consumeNonce(currentAgentId, msg.nonce)) {
                meshMetrics.rejectedReplays++;
                ws.send(JSON.stringify({ type: 'error', code: 'REPLAY', echoNonce: msg.nonce }));
                return;
            }
            msg.from = currentAgentId; // authoritative stamp

            switch (msg.type) {
                case 'ping':
                case 'heartbeat':
                    globalRegistry.updateHeartbeat(currentAgentId);
                    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', echoNonce: msg.nonce, ts: Date.now() }));
                    return;

                case 'agent.presence':
                    globalRegistry.updateHeartbeat(currentAgentId, msg.status);
                    this.broadcastPresence();
                    return;

                case 'agent.capabilities':
                case 'agent.capabilities.update': {
                    // Runtime capability refresh while connected (§11, §12, §48).
                    const caps = Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : [];
                    const a = globalRegistry.get(currentAgentId);
                    if (a) {
                        a.capabilities = caps;
                        if (Array.isArray(msg.tools)) a.tools = strArr(msg.tools, 256);
                        if (Array.isArray(msg.skills)) a.skills = strArr(msg.skills, 128);
                        if (Array.isArray(msg.providers)) a.providers = strArr(msg.providers, 64);
                        if (Array.isArray(msg.memoryCapabilities)) a.memoryCapabilities = strArr(msg.memoryCapabilities, 32);
                        if (msg.browser !== undefined) a.browser = !!msg.browser;
                        if (msg.mcp !== undefined) a.mcp = !!msg.mcp;
                    }
                    DeviceRegistry.touchPresence(currentAgentId, { capabilities: caps });
                    this.pushEvent({ ts: Date.now(), type: 'capabilities.changed', });
                    this.broadcastPresence(); // linked agents learn the diff (§49)
                    return;
                }

                case 'agent.link.request': {
                    // §7: A → AWS → B, never auto-trusted.
                    meshMetrics.linkRequests++;
                    const to = String(msg.to ?? '');
                    const targetDev = DeviceRegistry.getByDeviceId(to) ? undefined : DeviceRegistry.get(to);
                    const targetLive = globalRegistry.get(to);
                    if (!targetLive || !targetDev || !(targetDev.trust === 'trusted')) {
                        ws.send(JSON.stringify({ type: 'error', code: 'LINK_TARGET_UNAVAILABLE', to, echoNonce: msg.nonce, ts: Date.now() }));
                        return;
                    }
                    const r = AgentLinkRegistry.request(currentAgentId, to, currentAgentId);
                    if (!r.ok) {
                        ws.send(JSON.stringify({ type: 'agent.link.result', linkId: r.link?.linkId, state: r.reason === 'ALREADY_LINKED' ? 'linked' : r.reason, to, echoNonce: msg.nonce, ts: Date.now() }));
                        return;
                    }
                    const link = r.link!;
                    relayTo(to, {
                        type: 'agent.link.request', v: 1, nonce: newId(6), ts: Date.now(),
                        from: currentAgentId, to, linkId: link.linkId,
                        requester: this.publicManifest(currentAgentId),
                    });
                    ws.send(JSON.stringify({ type: 'agent.link.pending', linkId: link.linkId, to, echoNonce: msg.nonce, ts: Date.now() }));
                    this.pushEvent({ ts: Date.now(), type: 'agent.link.requested' });
                    return;
                }

                case 'agent.link.accept':
                case 'agent.link.reject': {
                    const link = AgentLinkRegistry.get(String(msg.linkId ?? ''));
                    if (!link || link.state !== 'pending') {
                        ws.send(JSON.stringify({ type: 'error', code: 'LINK_NOT_PENDING', echoNonce: msg.nonce, ts: Date.now() }));
                        return;
                    }
                    // Only the REQUESTED side may accept/reject over WS.
                    if (currentAgentId !== link.b) {
                        ws.send(JSON.stringify({ type: 'error', code: 'NOT_LINK_TARGET', echoNonce: msg.nonce, ts: Date.now() }));
                        return;
                    }
                    const accepted = msg.type === 'agent.link.accept';
                    AgentLinkRegistry.setState(link.linkId, accepted ? 'linked' : 'rejected');
                    const notice = {
                        type: accepted ? 'agent.link.accepted' : 'agent.link.rejected',
                        v: 1, nonce: newId(6), ts: Date.now(),
                        linkId: link.linkId, from: currentAgentId, to: link.a,
                        peer: accepted ? this.publicManifest(link.b) : undefined,
                    };
                    relayTo(link.a, notice);
                    ws.send(JSON.stringify({ ...notice, echoNonce: msg.nonce }));
                    this.pushEvent({ ts: Date.now(), type: accepted ? 'agent.linked' : 'agent.link.rejected' });
                    this.broadcastPresence();
                    return;
                }

                case 'agent.unlink': {
                    const other = String(msg.to ?? '');
                    const removed = AgentLinkRegistry.removeBetween(currentAgentId, other);
                    relayTo(other, { type: 'agent.unlinked', v: 1, nonce: newId(6), ts: Date.now(), from: currentAgentId, to: other });
                    ws.send(JSON.stringify({ type: 'agent.link.result', state: removed ? 'unlinked' : 'not-linked', to: other, echoNonce: msg.nonce, ts: Date.now() }));
                    return;
                }

                // §23/§26: lightweight config exchange between LINKED peers only.
                case 'agent.config.status': {
                    const payload = {
                        type: 'agent.config.status', v: 1, nonce: newId(6), ts: Date.now(),
                        from: currentAgentId,
                        configVersion: Number(msg.configVersion ?? 0),
                        capabilityVersion: Number(msg.capabilityVersion ?? 0),
                        protocolVersion: Number(msg.protocolVersion ?? PROTOCOL_VERSION),
                    };
                    let routed = 0;
                    for (const peer of AgentLinkRegistry.peersOf(currentAgentId)) {
                        if (relayTo(peer, payload)) routed++;
                    }
                    ws.send(JSON.stringify({ type: 'agent.config.routed', peers: routed, echoNonce: msg.nonce, ts: Date.now() }));
                    return;
                }

                case 'agent.notification': {
                    const to = String(msg.to ?? '');
                    if (!to) return;
                    // Notifications may reach linked peers or the task owner (server flows).
                    const t = this.tasks.get(String(msg.taskId ?? ''));
                    const ownerOk = t && t.ownerAgent === to;
                    if (AgentLinkRegistry.isLinked(currentAgentId, to) || ownerOk) {
                        relayTo(to, { ...msg, from: currentAgentId, ts: Date.now() });
                    }
                    return;
                }

                case 'agent.task.delegate': {
                    if (!msg.taskId || typeof msg.goal !== 'string') {
                        ws.send(JSON.stringify({ type: 'error', code: 'BAD_TASK', echoNonce: msg.nonce }));
                        return;
                    }
                    // §33: delegation loop / depth protection.
                    const chain: string[] = Array.isArray(msg.chain) ? msg.chain.map(String).slice(0, 12) : [];
                    if (chain.includes(currentAgentId!)) {
                        meshMetrics.delegationRejects++;
                        this.failTask(msg, currentAgentId!, 'LOOP_DETECTED');
                        return;
                    }
                    if (chain.length >= MAX_CHAIN_DEPTH) {
                        meshMetrics.delegationRejects++;
                        this.failTask(msg, currentAgentId!, 'CHAIN_TOO_DEEP');
                        return;
                    }
                    // §34: delegated authority must be ≤ caller authority.
                    const granted: string[] = Array.isArray(msg.policy?.grantedCapabilities) ? msg.policy!.grantedCapabilities.map(String) : [];
                    const caller = globalRegistry.get(currentAgentId!);
                    if (granted.length > 0 && caller && !granted.every(g => caller.capabilities.includes(g))) {
                        meshMetrics.delegationRejects++;
                        this.failTask(msg, currentAgentId!, 'EXCESS_AUTHORITY');
                        return;
                    }

                    const explicitTarget = String(msg.to ?? '');
                    if (explicitTarget && explicitTarget !== currentAgentId) {
                        // §5/§55: agent→agent needs an authenticated LINK.
                        const targetDev = DeviceRegistry.get(explicitTarget);
                        if (!AgentLinkRegistry.isLinked(currentAgentId!, explicitTarget)) {
                            meshMetrics.delegationRejects++;
                            this.failTask(msg, currentAgentId!, 'NOT_LINKED');
                            return;
                        }
                        const target = globalRegistry.get(explicitTarget);
                        if (!target || target.ws.readyState !== WebSocket.OPEN || !targetDev || targetDev.trust !== 'trusted') {
                            meshMetrics.delegationRejects++;
                            this.failTask(msg, currentAgentId!, 'UNAVAILABLE');
                            return;
                        }
                        this.tasks.set(String(msg.taskId), {
                            state: 'queued',
                            ownerAgent: msg.ownerAgent ?? currentAgentId!,
                            originatingAgent: msg.originatingAgent ?? currentAgentId!,
                            executingAgent: explicitTarget,
                            updatedAt: Date.now(),
                        });
                        this.pushEvent({ ts: Date.now(), type: 'agent.task.delegate', taskId: String(msg.taskId) });
                        target.ws.send(JSON.stringify({
                            ...msg,
                            from: currentAgentId,
                            ownerAgent: msg.ownerAgent ?? currentAgentId,
                            originatingAgent: msg.originatingAgent ?? currentAgentId,
                            delegatedAgent: explicitTarget,
                            chain: [...new Set([...chain, explicitTarget])],
                            ts: Date.now(),
                        }));
                        meshMetrics.delegations++;
                        return;
                    }

                    // Capability routing — restrict candidates to THIS agent's linked
                    // peers (default-restrictive §8); server-initiated routing is unaffected.
                    const linkedPeers = AgentLinkRegistry.peersOf(currentAgentId!).filter(p => {
                        const d = DeviceRegistry.get(p);
                        return d && d.trust === 'trusted';
                    });
                    const r = routeDelegation({
                        type: 'agent.task.delegate',
                        taskId: String(msg.taskId),
                        goal: String(msg.goal),
                        from: currentAgentId!,
                        requiredCapabilities: msg.requiredCapabilities,
                        policy: msg.policy,
                        candidateFilter: linkedPeers,
                    });
                    if (!r.ok) {
                        meshMetrics.delegationRejects++;
                        this.tasks.set(String(msg.taskId), { state: 'failed', ownerAgent: currentAgentId!, updatedAt: Date.now() });
                        ws.send(JSON.stringify({
                            type: 'agent.task.result', echoNonce: msg.nonce, ts: Date.now(),
                            from: 'server', taskId: String(msg.taskId), state: 'failed', summary: r.reason,
                        }));
                    } else {
                        this.tasks.get(String(msg.taskId))!.executingAgent = r.delegatedAgent;
                        this.tasks.get(String(msg.taskId))!.originatingAgent = msg.originatingAgent ?? currentAgentId!;
                        meshMetrics.delegations++;
                    }
                    return;
                }

                case 'agent.task.accepted': {
                    const t = this.tasks.get(String(msg.taskId));
                    if (t) { t.state = 'accepted'; t.executingAgent = currentAgentId!; t.updatedAt = Date.now(); }
                    relayTo(String(msg.to ?? ''), { ...msg, from: currentAgentId, ts: Date.now() });
                    return;
                }

                case 'agent.task.progress': {
                    const p = this.tasks.get(String(msg.taskId));
                    if (p && p.state !== 'unknown') { p.state = 'running'; p.executingAgent = currentAgentId; p.updatedAt = Date.now(); }
                    relayTo(String(msg.to ?? ''), { ...msg, from: currentAgentId, ts: Date.now() });
                    return;
                }

                case 'agent.task.result': {
                    const t = this.tasks.get(String(msg.taskId));
                    if (t) {
                        t.state = ['completed', 'failed'].includes(msg.state) ? msg.state : 'unknown';
                        t.executingAgent = currentAgentId;
                        t.updatedAt = Date.now();
                    }
                    this.pushEvent({ ts: Date.now(), type: `agent.task.${msg.state ?? 'result'}`, taskId: String(msg.taskId) });
                    if (msg.to) {
                        relayTo(String(msg.to), { ...msg, from: currentAgentId, ts: Date.now() });
                    } else if (t?.ownerAgent && t.ownerAgent !== currentAgentId) {
                        relayTo(t.ownerAgent, { ...msg, from: currentAgentId, ts: Date.now() });
                    }
                    return;
                }

                case 'agent.approval.request': {
                    this.pushEvent({ ts: Date.now(), type: 'approval.requested' });
                    // §35/§36: route toward the target's linked peers / trusted non-mobile
                    // consoles; fallback honest-nack to sender.
                    let routed = false;
                    const preferred = String(msg.to ?? '');
                    if (preferred && relayTo(preferred, { ...msg, from: currentAgentId, ts: Date.now() })) routed = true;
                    if (!routed) {
                        for (const c of globalRegistry.getAll()) {
                            if (c.agentId === currentAgentId || c.platform === 'android') continue;
                            if (relayTo(c.agentId, { ...msg, from: currentAgentId, ts: Date.now() })) { routed = true; break; }
                        }
                    }
                    if (!routed) {
                        ws.send(JSON.stringify({ type: 'agent.approval.unroutable', approvalId: msg.approvalId, echoNonce: msg.nonce, ts: Date.now() }));
                    }
                    return;
                }

                case 'agent.approval.response': {
                    relayTo(String(msg.to ?? ''), { ...msg, from: currentAgentId, ts: Date.now() });
                    return;
                }

                case 'memory.share': {
                    const out = SharedMemoryStore.share({
                        ownerAgent: currentAgentId,
                        memoryId: String(msg.memoryId ?? ''),
                        scope: msg.scope,
                        title: msg.title,
                        content: msg.content,
                        project: msg.project,
                        taskId: msg.taskId,
                        goalId: msg.goalId,
                        tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [],
                        version: Number(msg.version ?? 1),
                        vector: Array.isArray(msg.vector) ? msg.vector.map(Number) : undefined,
                    });
                    if (out.ok) { meshMetrics.memoryShares++; this.pushEvent({ ts: Date.now(), type: 'memory.shared' }); }
                    ws.send(JSON.stringify({
                        type: 'memory.share.result', echoNonce: msg.nonce, ts: Date.now(),
                        memoryId: String(msg.memoryId ?? ''),
                        ok: out.ok,
                        reason: out.ok ? undefined : out.reason,
                        currentVersion: (!out.ok && out.reason === 'CONFLICT') ? out.currentVersion : undefined,
                        version: out.ok ? out.entry.version : undefined,
                    }));
                    return;
                }

                case 'memory.query': {
                    let results: unknown;
                    if (Array.isArray(msg.vector) && msg.vector.length > 0) {
                        results = SharedMemoryStore.searchVector(currentAgentId, msg.vector.map(Number), Number(msg.limit ?? 5))
                            .map(r => ({ ...r.entry, score: Number(r.score.toFixed(4)) }));
                    } else {
                        results = SharedMemoryStore.visibleTo(currentAgentId, {
                            q: msg.q ? String(msg.q) : undefined,
                            project: msg.project ? String(msg.project) : undefined,
                        }).slice(0, Number(msg.limit ?? 20));
                    }
                    ws.send(JSON.stringify({ type: 'memory.query.result', echoNonce: msg.nonce, ts: Date.now(), results }));
                    return;
                }

                case 'agent.sync': {
                    const sinceTs = Number(msg.sinceTs ?? 0);
                    ws.send(JSON.stringify({
                        type: 'agent.sync.batch', echoNonce: msg.nonce, ts: Date.now(), serverTime: Date.now(),
                        events: this.events.filter(e => e.ts > sinceTs),
                        tasks: this.taskList().filter(t => t.ownerAgent === currentAgentId || t.executingAgent === currentAgentId),
                        links: AgentLinkRegistry.listFor(currentAgentId!),
                    }));
                    return;
                }

                default:
                    // Unknown versioned types are ignored quietly (forward-compat).
                    return;
            }
        });

        ws.on('close', () => {
            if (currentAgentId) {
                console.log(chalk.gray(`[MESH] ${currentAgentId} disconnected`));
                globalRegistry.remove(currentAgentId);
                this.broadcastPresence();
            }
        });

        ws.on('error', () => { /* close follows */ });
    }

    /** Honest task failure back to the delegating agent (§37). */
    private failTask(msg: any, from: string, reason: string): void {
        const w = globalRegistry.get(from)?.ws;
        try {
            w?.send(JSON.stringify({
                type: 'agent.task.result', echoNonce: msg.nonce, ts: Date.now(),
                from: 'server', taskId: String(msg.taskId), state: 'failed', summary: reason,
            }));
        } catch { /* ignore */ }
    }

    /** Safe cross-agent identity snapshot — no private state (§13). */
    private publicManifest(agentId: string): Record<string, unknown> | undefined {
        const a = globalRegistry.get(agentId);
        if (!a) return undefined;
        return {
            agentId: a.agentId,
            displayName: a.displayName,
            platform: a.platform,
            agentType: a.agentType,
            runtimeVersion: a.runtimeVersion,
            protocolVersion: a.protocolVersion,
            capabilities: a.capabilities,
            tools: a.tools,
            skills: a.skills,
            providers: a.providers,
            browser: a.browser,
            mcp: a.mcp,
        };
    }

    private bindAgent(
        ws: WebSocket,
        agentId: string,
        dev: { deviceId: string; displayName: string; platform: string; runtimeVersion: string },
        msg: any,
        connectionId: string,
        manifest: { agentType: string; userScope: string; tools: string[]; skills: string[]; providers: string[]; memoryCapabilities: string[]; browser: boolean; mcp: boolean },
    ): void {
        globalRegistry.register(agentId, {
            agentId,
            deviceId: dev.deviceId,
            displayName: dev.displayName,
            platform: dev.platform,
            capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : [],
            protocolVersion: PROTOCOL_VERSION,
            runtimeVersion: String(msg.runtimeVersion ?? dev.runtimeVersion),
            status: 'online',
            ws,
            nonces: new Set(),
            connectionId,
            agentType: manifest.agentType,
            userScope: manifest.userScope,
            tools: manifest.tools,
            skills: manifest.skills,
            providers: manifest.providers,
            memoryCapabilities: manifest.memoryCapabilities,
            browser: manifest.browser,
            mcp: manifest.mcp,
        });
        DeviceRegistry.touchPresence(agentId, {
            capabilities: globalRegistry.get(agentId)?.capabilities ?? [],
            resourceState: msg.resourceState ?? undefined,
        });
    }

    private pushEvent(e: { ts: number; type: string; taskId?: string }): void {
        this.events.push(e);
        if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    }

    private broadcastPresence(): void {
        const peers = this.summary().agents;
        for (const c of globalRegistry.getAll()) {
            try {
                c.ws.send(JSON.stringify({
                    type: 'agent.presence', v: 1, nonce: newId(6), ts: Date.now(), from: 'server', peers,
                }));
            } catch { /* closing */ }
        }
    }
}
