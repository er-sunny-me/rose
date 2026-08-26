import express from 'express';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { MeshGateway } from './gateway.js';
import { PairingManager, DeviceRegistry } from './pairing.js';

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

/** Tiny per-IP rate limiter for pairing/auth endpoints (§72). */
const hits = new Map<string, { n: number; windowStart: number }>();
function rateLimit(maxPerMin = 20) {
    return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        const ip = req.ip ?? (req.socket.remoteAddress ?? '?');
        const now = Date.now();
        const h = hits.get(ip);
        if (!h || now - h.windowStart > 60_000) {
            hits.set(ip, { n: 1, windowStart: now });
            next();
            return;
        }
        h.n++;
        if (h.n > maxPerMin) { res.status(429).json({ error: 'rate limited' }); return; }
        next();
    };
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

    api.post('/agents/pair', rateLimit(10), (req, res) => {
        const p = PairingManager.begin();
        // Use the host the CLIENT actually reached us on (public IP/domain),
        // falling back to the configured bind address.
        const reqHost = String(req.headers.host ?? '').split(',')[0].trim();
        const hostPort = reqHost || `${HOST}:${PORT}`;
        const qrPayload = `rose-mesh://pair?host=${encodeURIComponent(hostPort)}&token=${encodeURIComponent(p.pairToken)}`;
        res.json({
            code: p.code,
            expiresAt: p.expiresAt,
            qr: qrPayload,
            approveWith: `rose agents approve ${p.code}`,
        });
    });

    api.post('/agents/pair/approve', rateLimit(20), (req, res) => {
        const p = PairingManager.approve(String(req.body?.code ?? ''), req.body?.displayName ? String(req.body.displayName) : undefined);
        if (!p) { res.status(404).json({ error: 'no such pending pairing code (or expired)' }); return; }
        res.json({ ok: true, code: p.code });
    });

    api.get('/mesh', (_req, res) => res.json(gateway.summary()));
    api.get('/agents', (_req, res) => res.json(gateway.summary().agents));
    api.get('/agents/:id', (req, res) => {
        const agent = gateway.summary().agents.find(a => a.agentId === req.params.id);
        if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
        res.json(agent);
    });
    api.get('/agents/:id/health', (req, res) => {
        const agent = gateway.summary().agents.find(a => a.agentId === req.params.id);
        if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
        res.json({ agentId: agent.agentId, status: agent.status, trust: agent.trust, lastSeen: agent.lastSeen, capabilities: agent.capabilities });
    });
    api.post('/agents/:id/revoke', (req, res) => {
        const okRevoke = DeviceRegistry.revoke(req.params.id);
        if (!okRevoke) { res.status(404).json({ error: 'Agent not found' }); return; }
        console.log(chalk.red(`🚫 [MESH] Revoked ${req.params.id}`));
        res.json({ ok: true, agentId: req.params.id, revoked: true });
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
