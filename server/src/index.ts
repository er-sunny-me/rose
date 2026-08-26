import express from 'express';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { MeshGateway } from './gateway.js';
import { DeviceRegistry } from './pairing.js';
import { AgentLinkRegistry } from './links.js';

dotenv.config();

export const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
export const HOST = process.env.HOST || '127.0.0.1';

/**
 * REST auth: every /api/* call needs the ROSE_API_TOKEN bearer token.
 * /health stays open (load-balancer probes). No token configured ⇒ server
 * refuses /api/* rather than silently running open (spec §73).
 */
const API_TOKEN = process.env.ROSE_API_TOKEN || '';

function requireToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!API_TOKEN) {
        res.status(503).json({ error: 'Server has no ROSE_API_TOKEN set. Refusing to serve unauthenticated mesh APIs.' });
        return;
    }
    const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.query.token ?? '');
    const a = Buffer.from(presented);
    const b = Buffer.from(API_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { next(); return; }
    res.status(401).json({ error: 'unauthorized' });
}

export function buildServer() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    const gateway = new MeshGateway();
    const server = http.createServer(app);
    server.on('upgrade', (request, socket, head) => gateway.upgrade(request, socket, head));

    // ── health (open) ──
    app.get('/health', (_req, res) => {
        res.json({
            status: 'healthy',
            uptimeSec: Math.round(process.uptime()),
            agentsOnline: gateway.summary().online,
            activeTasks: gateway.summary().activeTasks,
        });
    });

    // ── authenticated mesh REST ──
    const api = express.Router();
    api.use(requireToken);

    api.get('/mesh', (_req, res) => res.json(gateway.summary()));
    api.get('/agents', (_req, res) => res.json(gateway.summary().agents));
    api.get('/agents/:id', (req, res) => {
        const agent = gateway.summary().agents.find(a => a.agentId === req.params.id);
        if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
        res.json(agent);
    });
    api.get('/agents/:id/capabilities', (req, res) => {
        const agent = gateway.summary().agents.find(a => a.agentId === req.params.id);
        if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
        res.json({
            agentId: agent.agentId,
            platform: agent.platform,
            agentType: agent.agentType,
            runtimeVersion: agent.runtimeVersion,
            protocolVersion: agent.protocolVersion,
            capabilities: agent.capabilities,
            tools: agent.tools,
            skills: agent.skills,
            providers: agent.providers,
            memoryCapabilities: agent.memoryCapabilities,
            browser: agent.browser,
            mcp: agent.mcp,
            lastSeen: agent.lastSeen,
        });
    });

    // ── Phase 38: agent↔agent LINKS ──────────────────────────────
    api.get('/links', (_req, res) => {
        res.json({ links: AgentLinkRegistry.list(), activeLinks: AgentLinkRegistry.list().filter(l => l.state === 'linked').length });
    });
    // Admin-approved link (web panel / CLI trusted console). Token-gated above.
    api.post('/agents/link', (req, res) => {
        const a = String(req.body?.a ?? '').trim();
        const b = String(req.body?.b ?? '').trim();
        for (const id of [a, b]) {
            const dev = DeviceRegistry.get(id);
            if (!dev || !(dev.trust === 'trusted')) { res.status(400).json({ error: `Agent ${id} not found or not trusted` }); return; }
        }
        const existing = AgentLinkRegistry.findBetween(a, b);
        if (existing?.state === 'linked') { res.json({ ok: true, link: existing, alreadyLinked: true }); return; }
        const r = AgentLinkRegistry.request(a, b, 'server');
        if (!r.ok && !r.link) { res.status(400).json({ error: r.reason ?? 'link failed' }); return; }
        AgentLinkRegistry.setState(r.link!.linkId, 'linked'); // admin consent covers both sides
        res.json({ ok: true, link: AgentLinkRegistry.get(r.link!.linkId) });
    });
    api.post('/agents/unlink', (req, res) => {
        const a = String(req.body?.a ?? '').trim();
        const b = String(req.body?.b ?? '').trim();
        const okUnlink = AgentLinkRegistry.removeBetween(a, b);
        if (!okUnlink) { res.status(404).json({ error: 'No link between these agents' }); return; }
        console.log(chalk.red(`🔗✕ [MESH] Unlinked ${a} ↔ ${b}`));
        res.json({ ok: true, unlinked: true });
    });
    api.post('/links/:id/approve', (req, res) => {
        const l = AgentLinkRegistry.get(req.params.id);
        if (!l || l.state !== 'pending') { res.status(404).json({ error: 'Pending link not found' }); return; }
        AgentLinkRegistry.setState(l.linkId, 'linked');
        gateway.notifyLinkStateChange(l.linkId, 'linked');
        res.json({ ok: true, link: AgentLinkRegistry.get(l.linkId) });
    });
    api.post('/links/:id/reject', (req, res) => {
        const l = AgentLinkRegistry.get(req.params.id);
        if (!l || l.state !== 'pending') { res.status(404).json({ error: 'Pending link not found' }); return; }
        AgentLinkRegistry.setState(l.linkId, 'rejected');
        gateway.notifyLinkStateChange(l.linkId, 'rejected');
        res.json({ ok: true, link: AgentLinkRegistry.get(l.linkId) });
    });
    api.get('/agents/:id/health', (req, res) => {
        const agent = gateway.summary().agents.find(a => a.agentId === req.params.id);
        if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
        res.json({ agentId: agent.agentId, status: agent.status, trust: agent.trust, lastSeen: agent.lastSeen, capabilities: agent.capabilities });
    });
    api.post('/agents/:id/revoke', (req, res) => {
        const okRevoke = DeviceRegistry.revoke(req.params.id);
        if (!okRevoke) { res.status(404).json({ error: 'Agent not found' }); return; }
        // §55: revocation tears down every link touching this agent.
        const purged = AgentLinkRegistry.purgeFor(req.params.id);
        console.log(chalk.red(`🚫 [MESH] Revoked ${req.params.id}${purged ? ` (purged ${purged} link(s))` : ''}`));
        res.json({ ok: true, agentId: req.params.id, revoked: true, linksPurged: purged });
    });
    api.delete('/agents/:id', (req, res) => {
        const okDel = DeviceRegistry.remove(req.params.id);
        if (!okDel) { res.status(404).json({ error: 'Agent not found' }); return; }
        console.log(chalk.red(`🗑️  [MESH] Removed ${req.params.id} from the registry`));
        res.json({ ok: true, agentId: req.params.id, removed: true });
    });
    api.post('/agents/:id/tasks', (req, res) => {
        const goal = String(req.body?.goal ?? '').trim();
        if (!goal) { res.status(400).json({ error: 'goal is required' }); return; }
        const caps = Array.isArray(req.body?.requiredCapabilities) ? req.body.requiredCapabilities.map(String) : [];
        const r = gateway.delegateTo(req.params.id, goal, caps);
        if (!r.ok) { res.status(409).json(r); return; }
        res.json(r);
    });

    app.use('/api', api);

    return { app, server: http.createServer(app), gateway };
}

// ─── Direct-run entry ───────────────────────────────────────
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
    // Boot-time hygiene: drop devices unseen for ROSE_MESH_PRUNE_DAYS (default 30).
    const pruneDays = Number(process.env.ROSE_MESH_PRUNE_DAYS ?? 30);
    if (Number.isFinite(pruneDays) && pruneDays > 0) {
        const removed = DeviceRegistry.prune(pruneDays * 86_400_000);
        if (removed > 0) console.log(chalk.gray(`🧹 Pruned ${removed} device(s) unseen for ${pruneDays}+ day(s).`));
    }

    const { server, gateway } = buildServer();
    server.on('upgrade', (request, socket, head) => gateway.upgrade(request, socket, head));

    server.listen(PORT, HOST, () => {
        console.log(chalk.bold.blue(`\n🚀 Rose Mesh Server v1.1.7`));
        console.log(chalk.green(`✓ HTTP API   http://${HOST}:${PORT}  (auth: ${API_TOKEN ? 'token required' : chalk.red('NO TOKEN SET — /api disabled')})`));
        console.log(chalk.green(`✓ WS Gateway ws://${HOST}:${PORT}/mesh/ws`));
        console.log(chalk.gray(`  Coordination only — no AI keys needed on this box.\n`));
    });

    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            console.log(chalk.yellow(`\n${sig} — shutting down.`));
            process.exit(0);
        });
    }
}
