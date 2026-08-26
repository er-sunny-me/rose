import crypto from 'crypto';
import WebSocket from 'ws';

const B = 'http://127.0.0.1:3444';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer xyz123' };

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n); } };

async function main() {
    const pair = await (await fetch(`${B}/api/agents/pair`, { method: 'POST', headers: H })).json();
    ok(/^\d{3}-\d{3}$/.test(pair.code), `pairing code (${pair.code})`);
    await fetch(`${B}/api/agents/pair/approve`, { method: 'POST', headers: H, body: JSON.stringify({ code: pair.code }) });
    const token = new URL(pair.qr).searchParams.get('token')!;

    let resultReceived = false;
    const ws = new WebSocket(`ws://127.0.0.1:3444/mesh/ws?pair=${encodeURIComponent(token)}`);
    ws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.type === 'mobile.pair.approved') {
            ok(true, 'WS pairing approved');
            // delegate a terminal task to... ourselves? No—delegate requires OTHER agent; expect honest failure:
            ws.send(JSON.stringify({ type: 'agent.task.delegate', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), taskId: 'solo-1', goal: 'x', requiredCapabilities: ['gpu'] }));
        }
        if (m.type === 'agent.task.result' && m.taskId === 'solo-1') {
            ok(m.state === 'failed' && m.summary.includes('no capable'), 'no-capable delegation fails honestly');
        }
        if (m.type === 'memory.share.result') {
            ok(m.ok === true && m.version === 2, `memory re-share version bumped to ${m.version}`);
            console.log(`PASSED: ${passed}  FAILED: ${failed}`);
            process.exit(failed > 0 ? 1 : 0);
        }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), deviceId: 'c-' + Date.now(), displayName: 'Client', platform: 'linux', runtimeVersion: 't', protocolVersion: 1, capabilities: ['terminal'] })));

    const approvedWait = new Promise<void>(res => {
        ws.on('message', d => { if ((d.toString()).includes('mobile.pair.approved')) res(); });
    });
    await approvedWait;

    // memory tests
    const sendW = (msg: any) => new Promise<any>(res => {
        const h = (d: any) => { const m = JSON.parse(d.toString()); if (m.echoNonce === msg.nonce) { ws.off('message', h); res(m); } };
        ws.on('message', h);
        ws.send(JSON.stringify(msg));
    });

    const s1 = await sendW({ type: 'memory.share', memoryId: 'pnpm', scope: 'shared-project', content: 'uses pnpm', version: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now() });
    ok(s1.ok === true, 'share accepted');
    const s2 = await sendW({ type: 'memory.share', memoryId: 'pnpm', scope: 'shared-project', content: 'older text', version: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now() });
    ok(s2.ok === false && s2.reason === 'CONFLICT', 'conflict detected');
    const q = await sendW({ type: 'memory.query', q: 'pnpm', nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now() });
    ok(q.results?.length >= 1, 'query finds shared memory');

    // trigger the no-capable delegation (result comes async)
    ws.send(JSON.stringify({ type: 'agent.task.delegate', v: 1, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now(), taskId: 'solo-1', goal: 'x', requiredCapabilities: ['gpu'] }));

    // re-share with bumped version
    const s3 = await sendW({ type: 'memory.share', memoryId: 'pnpm', scope: 'shared-project', content: 'updated!', version: 2, nonce: crypto.randomBytes(6).toString('hex'), ts: Date.now() });
    ok(s3.ok === true && s3.version === 2, 'version-bumped share accepted');
}
main().catch(e => { console.error(e.message); process.exit(1); });
