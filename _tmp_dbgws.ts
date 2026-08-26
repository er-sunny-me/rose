import fs from 'fs'; import os from 'os'; import path from 'path';
process.env.ROSE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-dbg-'));
process.env.PORT = '0'; process.env.ROSE_ENABLE_OLLAMA = 'false';
const AUTH_TOKEN = (() => { try { return fs.readFileSync(path.join(process.cwd(), '.rose', 'auth-token'), 'utf8').trim(); } catch { return ''; } })();

const { AgentServer } = await import('./src/server.js');
const srv = new AgentServer();
(srv as any).host = '127.0.0.1'; (srv as any).port = 0;
srv.start();
await new Promise(r => setTimeout(r, 800));
const addr = (srv as any).server?.address?.();
console.log('address():', JSON.stringify(addr));

// REST check
const pr = await fetch(`http://127.0.0.1:${addr.port}/api/v1/agents/pair`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
console.log('pair REST:', pr.status, JSON.stringify(await pr.json()).slice(0, 140));

// WS check
const WebSocket = (await import('ws')).default;
const pair = await (await fetch(`http://127.0.0.1:${addr.port}/api/v1/agents/pair`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
await new Promise<void>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/mesh/ws?pair=${encodeURIComponent(pair.pairToken)}`);
    ws.on('open', () => { console.log('WS OPEN'); ws.send(JSON.stringify({ type: 'hello', v: 1, nonce: 'n1', ts: Date.now(), deviceId: 'dbg-1', displayName: 'Dbg', platform: 'android', runtimeVersion: 't', protocolVersion: 1, capabilities: [] })); });
    ws.on('message', d => { console.log('WS MSG:', d.toString().slice(0, 100)); process.exit(0); });
    ws.on('close', (c, r) => { console.log('WS CLOSE:', c, r.toString()); process.exit(0); });
    ws.on('error', e => console.log('WS ERR:', e.message));
    ws.on('unexpected-response', (_q, rsp) => { console.log('HTTP', rsp.statusCode); process.exit(0); });
    setTimeout(() => { console.log('TIMEOUT'); process.exit(0); }, 6000);
});
