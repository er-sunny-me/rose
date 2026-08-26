import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import chalk from 'chalk';
import { PairingManager, DeviceRegistry, PROTOCOL_VERSION, CLOCK_SKEW_MS } from './pairing.js';
import { globalRegistry, sha256Hex } from './registry.js';
import { routeDelegation, relayTo } from './router.js';
import { SharedMemoryStore } from './shared-memory.js';

/**
 * Mesh WebSocket gateway — the FULL Phase-37 lifecycle:
 *
 *   discovery → pairing (human-approved) → challenge auth → capability
 *   exchange → presence/heartbeat → task coordination → revoke
 *
 * Invariants:
 *  - clients never self-assign agentId/from/to (server stamps them)
 *  - replay: per-connection nonce cache; stale ts rejected (±30s)
 *  - heartbeat sweep marks silent agents degraded — registry state is KEPT
 *  - memory.* messages never trigger any AI/embedding call on this server
 */

export type TaskState = 'queued' | 'accepted' | 'running' | 'completed' | 'failed' | 'unknown';

interface TaskCoord {
    state: TaskState;
    ownerAgent?: string;
    executingAgent?: string;
    updatedAt: number;
}

function dbg(...a: unknown[]): void {
    if (process.env.ROSE_MESH_DEBUG) console.error('[MESH-DBG]', ...a);
}

function newId(bytes = 6): string {
    return crypto.randomBytes(bytes).toString('hex');
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
        const pairToken = url.searchParams.get('pair') ?? '';
        const knownToken = url.searchParams.get('token') ?? '';
        if (!pairToken && !knownToken.startsWith('mesh.')) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(request, socket, head, ws => this.handleConnection(ws, pairToken, knownToken));
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
                trust: d.trust,
                capabilities: d.capabilities,
                status,
                lastSeen: live ? Date.now() : d.lastSeen,
            };
        });
        const activeTasks = [...this.tasks.values()].filter(t => !['completed', 'failed'].includes(t.state)).length;
        return {
            protocolVersion: PROTOCOL_VERSION,
            total: agents.length,
            online: agents.filter(a => a.status === 'online').length,
            degraded: agents.filter(a => a.status === 'degraded').length,
            offline: agents.filter(a => a.status === 'offline').length,
            activeTasks,
            sharedMemories: SharedMemoryStore.count(),
            agents,
        };
    }

    /** Server-initiated delegation (CLI/Web "run on agent X"). */
    public delegateTo(agentId: string, goal: string, requiredCapabilities: string[] = []): { ok: boolean; taskId?: string; error?: string } {
        const target = globalRegistry.get(agentId);
        if (!target || target.ws.readyState !== WebSocket.OPEN) return { ok: false, error: 'Agent is offline.' };
        const taskId = `task-${newId(5)}`;
        this.tasks.set(taskId, { state: 'queued', ownerAgent: 'server', executingAgent: agentId, updatedAt: Date.now() });
        this.pushEvent({ ts: Date.now(), type: 'agent.task.delegate', taskId });
        target.ws.send(JSON.stringify({
            type: 'agent.task.delegate', v: 1, nonce: newId(8), ts: Date.now(),
            from: 'server', to: agentId, taskId, goal, requiredCapabilities,
            originAgent: 'server', ownerAgent: 'server', delegatedAgent: agentId,
            policy: { scope: 'delegated' },
        }));
        return { ok: true, taskId };
    }

    public taskList(): Array<{ taskId: string } & TaskCoord> {
        return [...this.tasks.entries()].map(([taskId, t]) => ({ taskId, ...t }));
    }

    // ─── Internals ──────────────────────────────────────────────

    private handleConnection(ws: WebSocket, pairToken: string, knownToken: string): void {
        let currentAgentId: string | null = null;
        let challenge: string | null = null;
        let pendingAgentId: string | null = null;

        ws.on('message', (data: Buffer) => {
            if (data.length > 262_144) { ws.close(1009, 'too large'); return; }
            let msg: any;
            try { msg = JSON.parse(data.toString('utf8')); } catch { ws.close(1002, 'bad json'); return; }

            // ── hello: pairing OR challenge start ──
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

                if (existing) {
                    // Known device → replay-safe challenge
                    challenge = crypto.randomBytes(24).toString('base64url');
                    pendingAgentId = existing.agentId;
                    globalRegistry.consumeNonce(existing.agentId, challenge);
                    ws.send(JSON.stringify({ type: 'challenge', v: 1, nonce: challenge.slice(0, 8), ts: Date.now(), challenge }));
                    return;
                }

                // New device → approved pairing token required
                const req = pairToken ? PairingManager.find(pairToken) : undefined;
                dbg('hello new-device', { hasReq: !!req, approved: !!req?.approved, matches: !!req && pairToken === req.pairToken });
                if (!req || !req.approved || pairToken !== req.pairToken) {
                    ws.send(JSON.stringify({
                        type: 'mobile.pair.rejected', v: 1, nonce: newId(4), ts: Date.now(),
                        reason: 'invalid or unapproved pairing token',
                    }));
                    ws.close(4002, 'pairing');
                    return;
                }

                const deviceSecret = crypto.randomBytes(32).toString('base64url'); // delivered ONCE
                const dev = DeviceRegistry.register({
                    deviceId,
                    displayName: req.displayName ?? String(msg.displayName ?? 'Device').slice(0, 40),
                    platform: String(msg.platform ?? 'other'),
                    runtimeVersion: String(msg.runtimeVersion ?? '0'),
                    deviceSecret,
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : [],
                });
                PairingManager.consume(pairToken);
                currentAgentId = dev.agentId;
                this.bindAgent(ws, dev.agentId, dev, msg);
                ws.send(JSON.stringify({
                    type: 'mobile.pair.approved', v: 1, nonce: newId(4), ts: Date.now(),
                    agentId: dev.agentId, deviceSecret, trust: dev.trust,
                }));
                console.log(chalk.green(`🤝 [MESH] Paired ${dev.displayName} → ${dev.agentId} (${dev.platform})`));
                this.pushEvent({ ts: Date.now(), type: 'agent.paired' });
                this.broadcastPresence();
                return;
            }

            // ── challenge response ──
            if (msg.type === 'challenge.response') {
                if (!challenge || !pendingAgentId) { ws.close(4002, 'no challenge'); return; }
                const okAuth = DeviceRegistry.verifyChallenge(pendingAgentId, String(msg.response ?? ''), challenge);
                const agentId = pendingAgentId;
                challenge = null;
                if (!okAuth) { ws.close(4003, 'auth failed'); return; }
                const dev = DeviceRegistry.get(agentId)!;
                currentAgentId = agentId;
                this.bindAgent(ws, currentAgentId, dev, msg);
                DeviceRegistry.touchPresence(currentAgentId);
                ws.send(JSON.stringify({
                    type: 'welcome', v: 1, nonce: newId(4), ts: Date.now(),
                    agentId: currentAgentId, trust: dev.trust, serverTime: Date.now(),
                }));
                console.log(chalk.cyan(`🔗 [MESH] ${dev.displayName} connected (${currentAgentId})`));
                this.broadcastPresence();
                return;
            }

            // Everything below requires an authenticated agent.
            if (!currentAgentId) {
                console.warn(chalk.yellow('[Gateway] dropped message from unauthenticated connection'));
                return;
            }

            // Replay + clock-skew guards (§60)
            const skew = Math.abs(Date.now() - Number(msg.ts ?? 0));
            if (!Number.isFinite(skew) || skew > CLOCK_SKEW_MS) {
                ws.send(JSON.stringify({ type: 'error', code: 'CLOCK_SKEW', echoNonce: msg.nonce }));
                return;
            }
            if (typeof msg.nonce !== 'string' || !globalRegistry.consumeNonce(currentAgentId, msg.nonce)) {
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

                case 'agent.capabilities': {
                    const caps = Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 32) : [];
                    const a = globalRegistry.get(currentAgentId);
                    if (a) a.capabilities = caps;
                    DeviceRegistry.touchPresence(currentAgentId, { capabilities: caps });
                    this.broadcastPresence();
                    return;
                }

                case 'agent.task.delegate': {
                    if (!msg.taskId || typeof msg.goal !== 'string') {
                        ws.send(JSON.stringify({ type: 'error', code: 'BAD_TASK', echoNonce: msg.nonce }));
                        return;
                    }
                    this.tasks.set(String(msg.taskId), { state: 'queued', ownerAgent: currentAgentId, updatedAt: Date.now() });
                    this.pushEvent({ ts: Date.now(), type: 'agent.task.delegate', taskId: String(msg.taskId) });
                    const r = routeDelegation({
                        type: 'agent.task.delegate',
                        taskId: String(msg.taskId),
                        goal: String(msg.goal),
                        from: currentAgentId,
                        requiredCapabilities: msg.requiredCapabilities,
                        policy: msg.policy,
                    });
                    if (!r.ok) {
                        this.tasks.set(String(msg.taskId), { state: 'failed', ownerAgent: currentAgentId, updatedAt: Date.now() });
                        ws.send(JSON.stringify({
                            type: 'agent.task.result', echoNonce: msg.nonce, ts: Date.now(),
                            from: 'server', taskId: String(msg.taskId), state: 'failed', summary: r.reason,
                        }));
                    } else {
                        this.tasks.get(String(msg.taskId))!.executingAgent = r.delegatedAgent;
                    }
                    return;
                }

                case 'agent.task.accepted': {
                    const t = this.tasks.get(String(msg.taskId));
                    if (t) { t.state = 'accepted'; t.executingAgent = currentAgentId; t.updatedAt = Date.now(); }
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
                    // Route toward trusted non-mobile consoles; fallback honest-nack to sender.
                    let routed = false;
                    for (const c of globalRegistry.getAll()) {
                        if (c.agentId === currentAgentId || c.platform === 'android') continue;
                        if (relayTo(c.agentId, { ...msg, from: currentAgentId, ts: Date.now() })) { routed = true; break; }
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
                    if (out.ok) this.pushEvent({ ts: Date.now(), type: 'memory.shared' });
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
                        tasks: this.taskList(),
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

    private bindAgent(ws: WebSocket, agentId: string, dev: { deviceId: string; displayName: string; platform: string; runtimeVersion: string }, msg: any): void {
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
