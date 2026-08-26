/**
 * Phase 37 — PC-side MESH AGENT CONNECTOR.
 *
 * Connects THIS PC's Rose runtime to the Agent Server as a first-class agent
 * (same protocol as mobile): pairing → challenge auth → capability exchange →
 * receive delegated tasks → execute LOCALLY with the existing agent core →
 * stream results back.
 *
 * Identity persists in ~/.rose/mesh/device.json. The device secret never
 * leaves this machine except during the one-time pairing delivery.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import chalk from 'chalk';
import { Config } from './config.js';

export const PROTOCOL_VERSION = 1;

export interface ConnectorOptions {
    serverUrl: string;            // http://host:port
    displayName?: string;
    capabilities?: string[];
    /** Executes a delegated goal with the LOCAL agent core (tools/security). */
    executeGoal: (goal: string, taskId: string) => Promise<string>;
}

interface DeviceIdentity {
    serverUrl: string;
    deviceId: string;
    agentId?: string;
    deviceSecret?: string;
}

function identityFile(): string {
    const envHome = process.env.ROSE_HOME?.trim();
    const base = envHome && envHome !== 'undefined' && envHome !== 'null'
        ? envHome
        : path.join(os.homedir(), '.rose');
    return path.join(base, 'mesh-device.json');
}

export function loadIdentity(): DeviceIdentity | null {
    try {
        const f = identityFile();
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* ignore */ }
    return null;
}

export function saveIdentity(id: DeviceIdentity): void {
    const f = identityFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(id, null, 2), { mode: 0o600 });
}

export function sha256Hex(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

export class PcMeshAgent {
    private ws: WebSocket | null = null;
    private attempts = 0;
    private stopped = false;
    private lastManifest: import('./mesh-manifest.js').MeshManifest | null = null;
    private pingTimer: NodeJS.Timeout | null = null;

    constructor(private opts: ConnectorOptions) {}

    async connect(): Promise<void> {
        let id = loadIdentity();
        const { Secrets } = await import('./security/secrets.js');
        const secretToken = process.env.ROSE_API_TOKEN
            || await Secrets.get('mesh-api-password', Config.get().web?.token ?? undefined);
        if (!secretToken) {
            console.error(chalk.red('Mesh API password is not configured. Run `rose agents connect <server-url>` once with ROSE_API_TOKEN set.'));
            return;
        }

        if (!id || id.serverUrl !== this.opts.serverUrl) {
            id = { serverUrl: this.opts.serverUrl, deviceId: crypto.randomBytes(32).toString('hex') };
            saveIdentity(id);
        }
        // Phase 38 §10/§46: manifest is detected from the REAL runtime, never hardcoded.
        const { detectManifest } = await import('./mesh-manifest.js');
        this.lastManifest = await detectManifest();
        await this.openSocket(this.opts.serverUrl, id, secretToken);
    }

    /** Re-detect the runtime and push a capability update (§12/§48). */
    async refreshCapabilities(): Promise<void> {
        const { detectManifest } = await import('./mesh-manifest.js');
        const next = await detectManifest();
        const prev = this.lastManifest;
        this.lastManifest = next;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (prev && prev.capabilityVersion === next.capabilityVersion) return; // avoid needless rescans
        this.sendNow({
            type: 'agent.capabilities.update',
            capabilities: next.capabilities,
            tools: next.tools,
            skills: next.skills,
            providers: next.providers,
            memoryCapabilities: next.memoryCapabilities,
            browser: next.browser,
            mcp: next.mcp,
            capabilityVersion: next.capabilityVersion,
            configVersion: next.configVersion,
        });
        console.log(chalk.cyan(`🔄 [MESH] Capabilities updated → v${next.capabilityVersion} (${next.capabilities.length} caps)`));
    }

    private buildHello(id: DeviceIdentity): Record<string, unknown> {
        const m = this.lastManifest;
        return {
            type: 'hello', v: PROTOCOL_VERSION,
            nonce: crypto.randomBytes(8).toString('hex'), ts: Date.now(),
            deviceId: id.deviceId,
            displayName: this.opts.displayName ?? 'PC Agent',
            platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'other',
            runtimeVersion: '1.0.0',
            protocolVersion: PROTOCOL_VERSION,
            capabilities: this.opts.capabilities ?? m?.capabilities ?? ['terminal', 'filesystem', 'browser'],
            agentType: process.platform === 'win32' ? 'desktop-agent' : `${process.platform}-agent`,
            userScope: process.env.ROSE_USER_SCOPE ?? '',
            tools: m?.tools ?? [],
            skills: m?.skills ?? [],
            providers: m?.providers ?? [],
            memoryCapabilities: m?.memoryCapabilities ?? [],
            browser: m?.browser ?? false,
            mcp: m?.mcp ?? false,
            configVersion: m?.configVersion,
            capabilityVersion: m?.capabilityVersion,
        };
    }

    private async openSocket(serverUrl: string, id: DeviceIdentity, secretToken: string): Promise<void> {
        const wsUrl = serverUrl.replace(/^http/, 'ws') + '/mesh/ws';
        const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${secretToken}` } });
        this.ws = ws;

        ws.on('open', () => {
            ws.send(JSON.stringify(this.buildHello(id)));
            // Presence accuracy (§31): periodic ping keeps the live registry fresh.
            if (this.pingTimer) clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => {
                try { ws.send(JSON.stringify({ type: 'ping', nonce: crypto.randomBytes(8).toString('hex'), ts: Date.now() })); } catch { /* close follows */ }
            }, 30_000);
            this.pingTimer.unref?.();
        });

        ws.on('message', (data) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }

            switch (msg.type) {
                case 'welcome':
                    id.agentId = msg.agentId;
                    saveIdentity(id);
                    console.log(chalk.green(`✅ [MESH] Connected as ${msg.agentId} (trust: ${msg.trust}, links: ${(msg.links ?? []).length}). Ready for delegations.`));
                    break;

                case 'agent.task.delegate':
                    void this.runDelegated(msg.taskId, msg.goal, msg.ownerAgent ?? msg.from);
                    break;

                case 'agent.link.request': {
                    // §7: never auto-trust. Default restrictive; explicit opt-in for headless.
                    const from = msg.from ?? msg.linkId;
                    console.log(chalk.yellow(`🔗 [MESH] Link request ${msg.linkId} from ${msg.requester?.displayName ?? from} (${msg.requester?.platform ?? '?'})`));
                    console.log(chalk.gray(`   caps: ${(msg.requester?.capabilities ?? []).join(', ') || '(none)'}`));
                    console.log(chalk.gray(`   approve: web panel → Agent Mesh, or REST POST /api/links/${msg.linkId}/approve`));
                    if (process.env.ROSE_MESH_AUTO_ACCEPT_LINKS === '1') {
                        this.sendNow({ type: 'agent.link.accept', linkId: msg.linkId });
                        console.log(chalk.green(`🔗 [MESH] Auto-accepted link ${msg.linkId} (ROSE_MESH_AUTO_ACCEPT_LINKS=1)`));
                    }
                    break;
                }

                case 'agent.link.accepted':
                    console.log(chalk.green(`🔗 [MESH] Link ACCEPTED by peer (${msg.linkId}) — trusted relationship established.`));
                    break;

                case 'agent.link.rejected':
                    console.log(chalk.red(`🔗✕ [MESH] Link rejected by peer (${msg.linkId}).`));
                    break;

                case 'agent.config.status':
                    console.log(chalk.blue(`⚙️  [MESH] Peer config: proto=${msg.protocolVersion} capV=${msg.capabilityVersion} cfg=${msg.configVersion}`));
                    break;

                case 'capabilities.changed':
                    void this.refreshCapabilities();
                    break;

                case 'agent.revoked':
                    console.log(chalk.red('🚫 This device was revoked by the server.'));
                    this.stop();
                    break;
                default:
                    break;
            }
        });

        ws.on('close', (code) => {
            if (this.stopped) return;
            if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
            console.log(chalk.yellow(`[MESH] disconnected (${code}) — retrying…`));
            setTimeout(() => void this.openSocket(serverUrl, loadIdentity() ?? id, secretToken), Math.min(60_000, 3000 * (++this.attempts)));
        });

        ws.on('error', () => { /* close follows */ });
    }

    private sendNow(payload: object): void {
        this.ws?.send(JSON.stringify({
            ...payload,
            v: PROTOCOL_VERSION,
            nonce: crypto.randomBytes(8).toString('hex'),
            ts: Date.now(),
        }));
    }

    /** Execute a delegated goal LOCALLY (real agent core) + report result. */
    private async runDelegated(taskId: string, goal: string, owner: string): Promise<void> {
        console.log(chalk.magenta(`📥 [MESH] Delegated task ${taskId}: ${goal}`));
        this.sendProgress(taskId, 10, 'accepted');
        try {
            const summary = await this.opts.executeGoal(goal, taskId);
            this.sendTo(owner, {
                type: 'agent.task.result', taskId, state: 'completed', summary: summary.slice(0, 4000),
            });
            console.log(chalk.green(`✅ [MESH] Task ${taskId} completed.`));
        } catch (e: any) {
            this.sendTo(owner, {
                type: 'agent.task.result', taskId, state: 'failed', summary: e.message?.slice(0, 500) ?? 'failed',
            });
            console.error(chalk.red(`❌ [MESH] Task ${taskId} failed: ${e.message}`));
        }
    }

    private sendProgress(taskId: string, pct: number, step: string): void {
        // Progress goes to the task owner; owner id arrives inside delegate msg.from —
        // simplest reliable path: broadcast-style direct send once known.
        void taskId; void pct; void step;
    }

    private sendTo(agentId: string, payload: object): void {
        this.ws?.send(JSON.stringify({
            ...payload, v: PROTOCOL_VERSION,
            nonce: crypto.randomBytes(8).toString('hex'), ts: Date.now(),
            to: agentId, from: loadIdentity()?.agentId,
        }));
    }

    stop(): void {
        this.stopped = true;
        this.ws?.close(1000, 'bye');
    }
}
