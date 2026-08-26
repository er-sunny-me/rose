// E2E: standalone server + fake PC agent + delegating client.
import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.PORT = '3377';
process.env.HOST = '127.0.0.1';
process.env.ROSE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-e2e-'));
process.env.ROSE_API_TOKEN = 'e2e-token';
delete process.env.GEMINI_API_KEY;

import { spawn } from 'child_process';
import WebSocket from 'ws';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n); } };

const logs: string[] = [];
const srv = spawn(process.execPath, ['server/dist/index.js'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', d => { logs.push(d.toString().trim()); fs.appendFileSync('e2srv.log', d.toString()); });
srv.stderr.on('data', d => fs.appendFileSync('e2srv.err', d.toString()));

const H = { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-token' };
const B = 'http://127.0.0.1:3377';

async function main() {
    console.log('BOOT-WAIT');
    for (let i = 0; i < 30; i++) {
        try { const r = await fetch(B + '/health'); if (r.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 500));
    }

    // Pair FakePC
    const pair = await (await fetch(`${B}/api/agents/pair`, { method: 'POST', headers: H })).json();
    await fetch(`${B}/api/agents/pair/approve`, { method: 'POST', headers: H, body: JSON.stringify({ code: pair.code }) });
    const token = new URL(pair.qr).searchParams.get('token');

    let resultReceived: any = null;
    const fakeWs = new WebSocket(`ws://127.0.0.1:3377/mesh/ws?pair=${encodeURIComponent(token)}`);
    let fakeReadyResolve!: () => void;
    const fakeReady = new Promise<void>(r => { fakeReadyResolve = r; });
    fakeWs.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.type === 'mobile.pair.approved') {
            fakeWs.send(JSON.stringify({ type: 'hello', v: 1, nonce: 'h' + Date.now(), ts: Date.now(), deviceId: 'fake-pc', displayName: 'FakePC', platform: 'linux', runtimeVersion: 't', protocolVersion: 1, capabilities: ['terminal'] }));
        }
        if (m.type === 'welcome') fakeReadyResolve();
        if (m.type === 'agent.task.delegate') {
            fakeWs.send(JSON.stringify({ type: 'agent.task.result', v: 1, nonce: 'r' + Date.now(), ts: Date.now(), to: m.ownerAgent, taskId: m.taskId, state: 'completed', summary: 'tests passed on FakePC' }));
        }
    });
    await fakeReady;
    ok(true, 'FakePC connected');

    // Real delegating client pairs too
    const pair2 = await (await fetch(`${B}/api/agents/pair`, { method: 'POST', headers: H })).json();
    await fetch(`${B}/api/agents/pair/approve`, { method: 'POST', headers: H, body: JSON.stringify({ code: pair2.code }) });
    const token2 = new URL(pair2.qr).searchParams.get('token');

    const ws2 = new WebSocket(`ws://127.0.0.1:3377/mesh/ws?pair=${encodeURIComponent(token2)}`);
    let agentId = '';
    ws2.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.type === 'mobile.pair.approved') {
            agentId = m.agentId;
            ws2.send(JSON.stringify({
                type: 'agent.task.delegate', v: 1, nonce: 'd1' + Date.now(), ts: Date.now(),
                taskId: 'e2e-final', goal: 'run tests', requiredCapabilities: ['terminal'],
                originAgent: m.agentId,
            }));
        }
        if (m.type === 'agent.task.result' && m.taskId === 'e2e-final') {
            resultReceived = m;
            ok(m.summary.includes('passed'), `full delegation loop → "${m.summary}"`);
            srv.kill(); process.exit(failed > 0 ? 1 : 0);
        }
    });
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'hello', v: 1, nonce: 'hh', ts: Date.now(), deviceId: 'realphone-1', displayName: 'RealPhone', platform: 'android', runtimeVersion: 't', protocolVersion: 1, capabilities: ['camera'] })));

    setTimeout(() => {
        console.log('SERVER:', logs.slice(-4).join(' | '));
        ok(!!resultReceived, 'delegation result within timeout');
        srv.kill(); process.exit(1);
    }, 15000);
}

main().catch(e => { console.error(e); process.exit(1); });
