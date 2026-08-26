// ALL-IN-ONE: spawn standalone server + run full mesh client flow.
process.env.PORT = '3777';
process.env.HOST = '127.0.0.1';
process.env.ROSE_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rfull-'));
process.env.ROSE_API_TOKEN = 'tok777';
process.env.ROSE_MESH_DEBUG = '1';

const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');

const srv = spawn(process.execPath, ['server/dist/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', () => {});
srv.stderr.on('data', d => console.error('[SRV-ERR]', d.toString().slice(0, 200)));

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n); } };

const B = 'http://127.0.0.1:3777';
const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer tok777' });

function waitMatch(ws, pred, ms) {
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting: ' + ms)), ms);
        const h = d => {
            const m = JSON.parse(d.toString());
            if (pred(m)) { clearTimeout(t); ws.off('message', h); res(m); }
        };
        ws.on('message', h);
    });
}

async function main() {
    // wait for boot
    for (let i = 0; i < 40; i++) {
        try { const r = await fetch(B + '/health'); if (r.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }

    // REST auth checks
    const unauth = await fetch(B + '/api/mesh');
    ok(unauth.status === 401, 'REST 401 without token');

    // pair + approve via REST
    const pair = await (await fetch(B + '/api/agents/pair', { method: 'POST', headers: H() })).json();
    ok(/^\d{3}-\d{3}$/.test(pair.code), `pairing code (${pair.code})`);
    await fetch(B + '/api/agents/pair/approve', { method: 'POST', headers: H(), body: JSON.stringify({ code: pair.code }) });
    const token = new URL(pair.qr).searchParams.get('token');

    // WS connect as paired device
    const ws = new WebSocket(`ws://127.0.0.1:3777/mesh/ws?pair=${encodeURIComponent(token)}`);
    const DEV = 'client-' + Date.now();
    ws.on('open', () => ws.send(JSON.stringify({
        type: 'hello', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(),
        deviceId: DEV, displayName: 'Client Phone', platform: 'android',
        runtimeVersion: 't', protocolVersion: 1, capabilities: ['camera'],
    })));
    const approved = await waitMatch(ws, m => m.type === 'mobile.pair.approved', 6000).catch(() => null);
    ok(!!approved && approved.agentId.startsWith('agent-'), 'WS pairing → agentId issued');
    if (!approved) throw new Error('no approval');

    // memory share/query over WS
    const sendW = msg => new Promise(res => {
        ws.on('message', function h(d) {
            const m = JSON.parse(d.toString());
            if (m.echoNonce === msg.nonce) { ws.off('message', h); res(m); }
        });
        ws.send(JSON.stringify(msg));
    });

    const s1 = await sendW({ type: 'memory.share', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), memoryId: 'pnpm', scope: 'shared-project', content: 'uses pnpm', version: 1 });
    ok(s1.ok === true && s1.version === 1, 'memory share accepted');
    const s2 = await sendW({ type: 'memory.share', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), memoryId: 'pnpm', scope: 'shared-project', content: 'older', version: 1 });
    ok(s2.ok === false && s2.reason === 'CONFLICT' && s2.currentVersion === 1, 'stale version → CONFLICT');
    const q = await sendW({ type: 'memory.query', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), q: 'pnpm' });
    ok(Array.isArray(q.results) && q.results.length >= 1, 'query finds shared memory');

    const syncB = await sendW({ type: 'agent.sync', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), sinceTs: 0 });
    ok(Array.isArray(syncB.events), 'agent.sync returns event batch');

    const summary = await (await fetch(B + '/api/mesh', { headers: H() })).json();
    ok(summary.total >= 1 && summary.online >= 1, `mesh online (${summary.total}/${summary.online})`);
    ok(typeof summary.sharedMemories === 'number', 'sharedMemories count exposed');

    console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
    srv.kill();
    process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => { console.error('HARD TIMEOUT'); console.error('[SRV-ERR] tail available above'); srv.kill(); process.exit(1); }, 20000);
main().catch(e => { console.error(e); srv.kill(); process.exit(1); });
