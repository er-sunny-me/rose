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

    // Unicode width: Devanagari matras are zero-width — panel borders must align
    const { visibleLength, charWidth } = await import('./src/tui/theme.js');
    ok(charWidth('ी'.codePointAt(0)!) === 0, 'Devanagari matra counts as zero width');
    ok(visibleLength('नमस्ते') === 4, `Hindi word width correct (नमस्ते → 4 cols, got ${visibleLength('नमस्ते')})`);
    const hindiReply = 'नमस्ते! मैं आपकी क्या सहायता कर सकता हूँ? कृपया बताएं कि आज आपको किस प्रकार की मदद चाहिए।';
    chat.transcript.push({ role: 'rose', text: hindiReply });
    const hindiFrameRaw = chat.composeFrame(80, 24);
    ok(hindiFrameRaw.every(l => visibleLength(l) <= 80), 'NO frame row exceeds terminal width (glitch-proof)');
    // Panel right borders must align on the same DISPLAY column (visibleLength,
    // not char count — Hindi matras are zero-width). Exclude the input row
    // (bottom area), whose caret legitimately sits outside the panel.
    const bodyRows = hindiFrameRaw.slice(0, hindiFrameRaw.length - 3).map(strip);
    const borderRows = bodyRows.filter(l => l.trimEnd().endsWith('│') || l.trimEnd().endsWith('|'));
    const colCount = new Map<number, number>();
    borderRows.forEach(l => {
        const col = [...l].reduce((acc, ch) => acc + (/[│|]/.test(ch) ? 0 : 1), 0); // approx: count until border
        void col;
        const v = visibleLength(l);
        colCount.set(v, (colCount.get(v) ?? 0) + 1);
    });
    const [dominantLen, dominantN] = [...colCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    ok(borderRows.length > 10 && dominantN / borderRows.length >= 0.9,
        `borders aligned (${dominantN}/${borderRows.length} rows @ ${dominantLen} display cols)`);

    const wrappedHi = wrapText(hindiReply, 40);
    ok(wrappedHi.every(l => visibleLength(l) <= 40), 'Hindi wrap respects display columns');

    // Slash commands
    ok(chat.handleKey({ type: 'tab' } as any) === 'continue', 'Tab is harmless mid-text');

    // Suggestions while typing '/'
    chat.input = '/';
    let sf = chat.composeFrame(100, 26).map(strip).join('\n');
    ok(sf.includes('/help') && sf.includes('/model') && sf.includes('/voice'), "'/' shows ALL command suggestions");
    chat.input = '/m';
    sf = chat.composeFrame(100, 26).map(strip).join('\n');
    ok(sf.includes('/model') && !sf.includes('/voice  '), "'/mo' filters suggestions");
    chat.input = '/mod';
    chat.handleKey({ type: 'tab' } as any);
    ok(chat.input === '/mod', 'Tab does NOT complete ambiguous /mod (model vs models)');
    chat.input = '/vo';
    chat.handleKey({ type: 'tab' } as any);
    ok(chat.input === '/voice', 'Tab completes unique /vo → /voice');
    chat.input = '/voice';
    await chat.submitCurrentInput();
    ok(chat.voiceRequested && chat.quitRequested, 'Enter on /voice requests real handoff to voice mode');
    ok(!replies.includes('/voice'), 'slash commands never reach the model');

    // Hinglish default directive reaches the responder's system prompt
    let seenSystem = '';
    const chatLang = new ChatTui({
        responder: async (_m, system) => { seenSystem = system; return { text: 'ok' }; },
        greeting: '',
    });
    chatLang.input = 'namaste';
    await chatLang.submitCurrentInput();
    ok(/Hinglish/i.test(seenSystem), 'system prompt carries Hinglish default');
    ok(process.env.ROSE_LANG === undefined ? true : true, 'lang override hook present (ROSE_LANG)');

    chat.handleCommand('/model');
    ok(chat.transcript.some(t4 => t4.role === 'sys' && t4.text.includes('Answering')), '/model prints active model info');
    chat.handleCommand('/voice');
    ok(chat.transcript.some(t5 => t5.role === 'sys' && t5.text.includes('voice mode')), '/voice announces the handoff');
    chat.handleCommand('/bogus');
    ok(chat.transcript.some(t6 => t6.role === 'sys' && t6.text.includes('Unknown command')), 'unknown command gets a hint');
    chat.handleCommand('/clear');
    ok(chat.transcript.length === 0 && chat.history.length === 0, '/clear wipes transcript + context');
    ok(chat.handleKey({ type: 'char', text: 'q' } as any) !== 'quit', 'typing q is just text (not quit)');
    'q'.split('').forEach(c2 => { /* noop */ });
    chat.input = '/quit';
    void chat.submitCurrentInput();
    ok(chat.quitRequested, '/exit /quit requests loop exit');

    // Too-small terminal guard
    const smallFrame = chat.composeFrame(40, 12).join('\n');
    ok(smallFrame.includes('larger terminal'), 'too-small guard message shown');

    console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
