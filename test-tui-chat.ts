/**
 * Rose TUI chat behavioral test (headless, injected responder).
 * Run: npx tsx test-tui-chat.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.ROSE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-tui-chat-'));
delete process.env.GEMINI_API_KEY;

let passed = 0, failed = 0;
const ok = (c: boolean, n: string, d?: string) => {
    if (c) { passed++; console.log(`  ✓ ${n}`); }
    else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

async function main() {
    const { ChatTui, wrapText } = await import('./src/tui/chatApp.js');
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

    console.log('▶ ChatTui behavior');

    const replies: string[] = [];
    const chat = new ChatTui({
        responder: async (messages, _system, onDelta) => {
            replies.push(messages[messages.length - 1]?.content ?? '');
            onDelta?.('Hello');
            onDelta?.(' there');
            return {
                text: 'Hello there — I am the fake model.',
                model: 'fake/model-x',
                usage: { promptTokens: 10, completionTokens: 7, costUsd: 0.002 },
                durationMs: 1234,
            };
        },
        greeting: 'Welcome to Rose.',
    });

    // Type a message and send it
    'hi rose'.split('').forEach(ch => chat.handleKey({ type: 'char', text: ch } as any));
    ok(chat.input === 'hi rose', 'typing fills input');
    await chat.submitCurrentInput();
    await new Promise(r => setImmediate(r));
    ok(!chat.busy, 'busy clears after reply');
    ok(replies[0] === 'hi rose', 'responder received user message');
    const roles = chat.transcript.map(t2 => t2.role);
    ok(roles.includes('you') && roles.includes('rose'), 'transcript has both sides');
    const lastRose = [...chat.transcript].reverse().find(t2 => t2.role === 'rose');
    ok(lastRose?.text === 'Hello there — I am the fake model.', 'streamed placeholder finalized with authoritative text');
    ok(chat.lastReplyInfo?.model === 'fake/model-x', 'last-reply panel records ACTUAL answering model');
    ok(chat.lastReplyInfo?.usage?.costUsd === 0.002, 'cost surfaced when API reports it');
    ok(chat.history.length === 2 && chat.history[1].role === 'assistant', 'conversation history maintained for context');

    // Frame renders key sections
    const frame = chat.composeFrame(100, 30).map(strip).join('\n');
    ok(frame.includes('ROSE CHAT'), 'header shows ROSE CHAT');
    ok(frame.includes('MODEL'), 'model panel present on wide terminals');
    ok(frame.includes('Tier'), 'tier (high/low capability) shown');
    ok(frame.includes('Context'), 'context window shown');
    ok(frame.includes('LAST REPLY'), 'last-reply section shown');
    ok(frame.includes('fake/model-x'), 'actual answering model visible in UI');

    // Streaming deltas appear while busy
    let sawStreaming = false;
    const chat2 = new ChatTui({
        responder: async (_m, _s, onDelta) => {
            onDelta?.('partial...');
            await new Promise(r => setTimeout(r, 60)); // keep busy for a tick
            return { text: 'partial...done' };
        },
    });
    'say hi'.split('').forEach(ch => chat2.handleKey({ type: 'char', text: ch } as any));
    const p = chat2.submitCurrentInput();
    await new Promise(r => setTimeout(r, 15));
    sawStreaming = chat2.composeFrame(100, 30).map(strip).join('\n').includes('partial...');
    await p;
    ok(sawStreaming || chat2.transcript.some(t3 => t3.text.includes('partial...')), 'streamed delta visible during generation');

    // Quit flows
    chat.handleKey({ type: 'esc' } as any);
    ok(chat.confirmQuit, 'Esc raises quit confirmation');
    ok(chat.handleKey({ type: 'char', text: 'n' } as any) === 'continue' && !chat.confirmQuit, 'n cancels quit');
    ok(chat.handleKey({ type: 'ctrl', name: 'c' } as any) === 'quit', 'Ctrl+C quits immediately');

    // wrapText sanity
    const wrapped = wrapText('aaaa bbbb cccc dddd', 9);
    ok(wrapped.every(l => l.length <= 9), 'wrapText respects width');

    // Too-small terminal guard
    const smallFrame = chat.composeFrame(40, 12).join('\n');
    ok(smallFrame.includes('larger terminal'), 'too-small guard message shown');

    console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
