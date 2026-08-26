/**
 * Rose Chat TUI (`rose tui`) — full-screen chat on the Phase 33 TUI engine.
 *
 * Layout: transcript panel + input line, with a live MODEL panel on wide
 * terminals showing exactly what is running: provider, model id, capability
 * tier (high/low), context window, health — plus the model that ACTUALLY
 * answered the last reply (router fallbacks are visible, never hidden),
 * token usage and API-reported cost when available.
 */
import { Screen, KeyMsg } from './screen.js';
import { Theme, padEndVisible, visibleLength, stripAnsi } from './theme.js';
import { panel } from './widgets.js';
import { Config } from '../config.js';
import { getSystemInstruction } from '../context.js';
import { ModelRouter, ModelProvider } from '../router.js';

export interface ChatUsage {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
}

export interface ChatReply {
    text: string;
    /** The model that ACTUALLY produced this reply (post-fallback). */
    model?: string;
    usage?: ChatUsage;
    durationMs?: number;
}

export type ChatResponder = (
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    system: string,
    onDelta: ((delta: string) => void) | null,
) => Promise<ChatReply>;

interface TranscriptEntry {
    role: 'you' | 'rose' | 'sys';
    text: string;
}

const CHAT_COMMANDS = ['/help', '/model', '/models', '/voice', '/clear', '/exit', '/quit'];

const MIN_COLS = 46;
const MIN_ROWS = 16;

/** Word-wrap a plain string to `width` display columns (Unicode-width aware). */
export function wrapText(text: string, width: number): string[] {
    const out: string[] = [];
    for (const rawLine of text.split('\n')) {
        if (rawLine.length === 0) { out.push(''); continue; }
        let current = '';
        for (const word of rawLine.split(/\s+/)) {
            const candidate = current ? current + ' ' + word : word;
            if (visibleLength(candidate) <= width) {
                current = candidate;
            } else {
                if (current) out.push(current);
                if (visibleLength(word) > width) {
                    // hard-break very long tokens (urls etc.)
                    let rest = word;
                    while (visibleLength(rest) > width) {
                        let cut = '';
                        for (const ch of rest) {
                            if (visibleLength(cut + ch) > width) break;
                            cut += ch;
                        }
                        out.push(cut);
                        rest = rest.slice(cut.length);
                    }
                    current = rest;
                } else {
                    current = word;
                }
            }
        }
        if (current) out.push(current);
    }
    return out;
}

/** Language directive appended to the system prompt (default: Hinglish). */
export function languageDirective(): string {
    const override = process.env.ROSE_LANG;
    if (override) return `\n\nAlways respond in ${override}.`;
    return '\n\nAlways reply in Hinglish (Roman Hindi mixed with English, e.g. "haan bilkul, ye kar deta hoon"). Keep technical terms in English. Only switch language when the user explicitly writes in pure Hindi or another language.';
}

import { ToolRegistry, ToolExecutor } from '../tools.js';

/** Default responder: existing Model Router, streaming when the provider supports it.
 *  Phase 37 fix: now includes tool declarations and an agentic tool loop so the
 *  TUI can execute commands, search the web, check battery etc. */
export function createRouterResponder(): ChatResponder {
    return async (messages, system, onDelta) => {
        const started = Date.now();
        const roseTools = ToolRegistry.getDeclarations();
        const MAX_TOOL_ITERATIONS = 6;

        // Build a working copy of the conversation for the tool loop.
        const convo = messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: m.content,
        }));

        let finalText = '';

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const res: any = await ModelRouter.route(
                { intent: 'generation', maxTokens: 4096, tools: roseTools },
                convo,
                system,
            );

            // ── Extract function calls across provider shapes ──
            const fnCalls: Array<{ id: string; name: string; args: any }> = [];
            let textParts: string[] = [];

            // Gemini / Anthropic shape: res.content is an array of parts
            if (res?.content && Array.isArray(res.content)) {
                for (const part of res.content) {
                    if (part?.type === 'tool_use' && part.name) {
                        fnCalls.push({ id: part.id || `tc_${iteration}_${fnCalls.length}`, name: part.name, args: part.input ?? {} });
                    } else if (part?.functionCall?.name) {
                        fnCalls.push({ id: `tc_${iteration}_${fnCalls.length}`, name: part.functionCall.name, args: part.functionCall.args ?? {} });
                    } else if ((part?.type === 'text' || !part?.type) && part?.text) {
                        textParts.push(part.text);
                    }
                }
            }
            // OpenAI shape: res.choices[0].message.tool_calls
            const openaiCalls = res?.choices?.[0]?.message?.tool_calls;
            if (Array.isArray(openaiCalls)) {
                for (const tc of openaiCalls) {
                    if (tc?.function?.name) {
                        let parsedArgs: any = {};
                        try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
                        fnCalls.push({ id: tc.id || `tc_${iteration}_${fnCalls.length}`, name: tc.function.name, args: parsedArgs });
                    }
                }
            }

            // No tool calls → we have the final answer
            if (fnCalls.length === 0) {
                finalText = textParts.join('\n') || res?.choices?.[0]?.message?.content || '';
                break;
            }

            // ── Execute each tool ──
            for (const call of fnCalls) {
                onDelta?.(`\n🔧 ${call.name}…\n`);
                let resultText: string;
                try {
                    const response = await ToolExecutor.execute(call);
                    resultText = typeof response === 'string'
                        ? response
                        : JSON.stringify(response?.response ?? response?.result ?? response);
                } catch (e: any) {
                    resultText = `Tool error: ${e.message}`;
                }
                // Feed the tool result back into the conversation
                convo.push({ role: 'assistant', content: `[called tool ${call.name} with ${JSON.stringify(call.args)}]` });
                convo.push({ role: 'user', content: `[TOOL RESULT ${call.name}]:\n${String(resultText).slice(0, 8000)}` });
            }
        }

        if (!finalText) finalText = 'Tools were used but the model did not produce a final answer.';

        return { text: finalText, model: undefined, durationMs: Date.now() - started };
    };
}

interface ActiveModelInfo {
    configuredId: string;
    activeId: string;
    name: string;
    tier: string;
    providerKind: string;
    health: string;
    contextLabel: string;
    chips: string[];
    remote: boolean;
}

function describeActiveModel(): ActiveModelInfo {
    const cfg = Config.get();
    const providers: ModelProvider[] = ModelRouter.getProviders();
    const configuredId = cfg.agent?.model || providers[0]?.id || '(none)';
    const active = providers.find(p => p.id === configuredId && p.health !== 'OPEN')
        ?? providers.find(p => p.health !== 'OPEN')
        ?? providers[0];

    let contextLabel = '—';
    let chips: string[] = [];
    try {
        const limit = ModelRouter.getContextLimit(configuredId);
        if (limit) contextLabel = `${Math.round(limit / 1000)}k`;
        // Lazy import avoids hard dependency when OpenRouter is unused.
        const mod = (ModelRouter as any).openrouterModule as
            | { OpenRouterProvider?: { getModelInfo(id: string): { supportsTools?: boolean; supportsVision?: boolean; pricingInputPerToken?: number; pricingOutputPerToken?: number } | undefined } }
            | null;
        const info = mod?.OpenRouterProvider?.getModelInfo(active?.id ?? configuredId);
        if (info) {
            if (info.supportsTools) chips.push('tools');
            if (info.supportsVision) chips.push('vision');
            if (info.pricingInputPerToken !== undefined) {
                chips.push(`$${(info.pricingInputPerToken * 1_000_000).toFixed(2)}/Mtok in`);
            }
        }
    } catch { /* router not booted yet */ }

    return {
        configuredId,
        activeId: active?.id ?? '(none)',
        name: active?.name ?? '(no provider)',
        tier: active?.tier || '—',
        providerKind: active?.providerId || '—',
        health: active?.health || '—',
        contextLabel,
        chips,
        remote: (active as any)?.remote === true,
    };
}

export class ChatTui {
    screen = new Screen();
    theme: Theme;
    transcript: TranscriptEntry[] = [];
    input = '';
    busy = false;
    spinnerFrame = 0;
    /** Lines scrolled up from the bottom (0 = follow latest). */
    scrollFromBottom = 0;
    confirmQuit = false;

    lastReplyInfo?: { model: string; usage?: ChatUsage; durationMs: number };
    errorCount = 0;

    private responder: ChatResponder;
    private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    private spinnerTimer: NodeJS.Timeout | null = null;
    private quitResolve: (() => void) | null = null;
    /** Set by /exit — the key loop checks it after each draw. */
    quitRequested = false;
    /** Set by /voice — CLI launches the voice app after clean TUI exit. */
    voiceRequested = false;

    constructor(opts: { responder?: ChatResponder; greeting?: string } = {}) {
        this.theme = new Theme(Config.get().appearance);
        this.responder = opts.responder ?? createRouterResponder();
        if (opts.greeting !== undefined) {
            this.transcript.push({ role: 'rose', text: opts.greeting });
        }
    }

    // ─── Public API ─────────────────────────────────────────

    async run(): Promise<void> {
        if (!Screen.supportsInteractive()) throw new Error('NON_INTERACTIVE');
        this.screen.enter();
        this.draw();
        try {
            await new Promise<void>((resolve) => {
                this.quitResolve = resolve;
                void this.keyLoop();
            });
        } finally {
            this.stopSpinnerTick();
            this.screen.exit(); // guaranteed restore
        }
    }

    /** Compose (not paint) the frame — public for tests. */
    composeFrame(w: number, h: number): string[] {
        const t = this.theme;
        if (w < MIN_COLS || h < MIN_ROWS) {
            const mid = Math.floor(h / 2);
            return Array.from({ length: h }, (_, y) =>
                y === mid - 1 ? center(`Rose TUI needs a larger terminal (${w}x${h} < ${MIN_COLS}x${MIN_ROWS}).`, w)
                : y === mid ? center('Resize your terminal and it will continue.', w)
                : '');
        }

        // Slash suggestions occupy an extra row above the input when active.
        const suggesting = !this.busy && this.input.startsWith('/') && !this.input.includes(' ');
        const headerLines = 2;
        const footerLines = 2;
        const bodyH = Math.max(4, h - headerLines - footerLines - (suggesting ? 2 : 1));

        const wide = w >= 92;
        const modelW = wide ? Math.min(34, Math.floor(w * 0.3)) : 0;
        const chatW = w - modelW - (modelW ? 2 : 0);

        // ── Header ──
        const info = describeActiveModel();
        const title = ` ${t.icons.logo === 'ROSE' ? '' : t.icons.logo + ' '}ROSE CHAT`.trimStart();
        // Dedupe when provider kind and model id are identical strings.
        const rightText = info.providerKind === info.activeId
            ? shorten(info.activeId, Math.max(10, Math.floor(w / 3)))
            : `${info.providerKind} · ${shorten(info.activeId, Math.max(8, Math.floor(w / 3) - info.providerKind.length - 3))}`;
        const right = t.palette.dim(rightText);
        const header = truncateVisible(padEndVisible(title, Math.max(1, w - visibleLength(right))) + right, w);
        const sep = t.palette.border('─'.repeat(Math.min(w, 200)));

        // ── Transcript body ──
        const chatPanelInner = chatW - 4;
        const rendered: string[] = [];
        for (const entry of this.transcript) {
            const who = entry.role === 'you'
                ? t.palette.accentBold('You › ')
                : entry.role === 'rose'
                    ? t.palette.ok('Rose › ')
                    : t.palette.warn('! ');
            const wrapped = wrapText(entry.text, chatPanelInner - visibleLength(stripAnsi(who)));
            wrapped.forEach((line, i) => rendered.push((i === 0 ? who : ' '.repeat(visibleLength(stripAnsi(who)))) + t.palette.text(line)));
            rendered.push('');
        }
        if (this.busy) {
            const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
            rendered.push(t.palette.accent(frames[this.spinnerFrame % frames.length]) + ' ' + t.palette.dim(this.streamingText));
        }

        const innerH = Math.max(3, bodyH - 2); // panel borders
        const maxScroll = Math.max(0, rendered.length - innerH);
        this.scrollFromBottom = Math.max(0, Math.min(this.scrollFromBottom, maxScroll));
        const startIdx = Math.max(0, rendered.length - innerH - this.scrollFromBottom);
        const visible = rendered.slice(startIdx, startIdx + innerH);

        const scrollHint = this.scrollFromBottom > 0
            ? t.palette.dim(` ↑ ${this.scrollFromBottom} older`) : '';
        const chatContent = [...visible];
        while (chatContent.length < innerH) chatContent.push('');
        chatContent[innerH - 1] = padEndVisible(chatContent[innerH - 1], chatW - 4).slice(0, chatW - 4 - visibleLength(scrollHint)) + scrollHint;

        const leftCol = panel(t, chatContent, { width: chatW, title: 'TRANSCRIPT', paddingY: 0 });

        // ── Model panel ──
        const modelLines: string[] = [];
        if (wide) {
            const dot = (s: string) => s === 'HEALTHY' ? t.palette.ok('●') : s === 'DEGRADED' ? t.palette.warn('●') : t.palette.error('●');
            modelLines.push(t.palette.title('MODEL'));
            modelLines.push('');
            modelLines.push(kv(t, 'Provider', info.providerKind, 9));
            modelLines.push(kv(t, 'Tier', tierLabel(info.tier), 9));
            modelLines.push(kv(t, 'Context', info.contextLabel, 9));
            modelLines.push(dot(info.health) + ' ' + t.palette.text(padEndVisible(info.health.toLowerCase(), 14)));
            modelLines.push('');
            modelLines.push(t.palette.dim(shorten(info.configuredId, modelW - 6)));
            if (chipsNonEmpty(info.chips)) {
                modelLines.push(t.palette.accent(info.chips.map(c => `· ${c}`).join(' ')));
            }
            if (info.remote) modelLines.push(t.palette.dim('(external service)'));
            modelLines.push('');
            modelLines.push(t.palette.title('LAST REPLY'));
            modelLines.push('');
            if (this.lastReplyInfo) {
                modelLines.push(kv(t, 'By', shorten(this.lastReplyInfo.model, modelW - 8), 6));
                modelLines.push(kv(t, 'Time', `${(this.lastReplyInfo.durationMs / 1000).toFixed(1)}s`, 6));
                if (this.lastReplyInfo.usage?.promptTokens !== undefined) {
                    modelLines.push(kv(t, 'Tokens', `${this.lastReplyInfo.usage.promptTokens}→${this.lastReplyInfo.usage.completionTokens ?? '?'}`, 6));
                }
                if (this.lastReplyInfo.usage?.costUsd !== undefined) {
                    modelLines.push(kv(t, 'Cost', `$${this.lastReplyInfo.usage.costUsd.toFixed(4)}`, 6));
                }
            } else {
                modelLines.push(t.palette.dim('—'));
            }
            modelLines.push('');
            modelLines.push(t.palette.dim(`${this.history.length} msg in context`));
        }

        let body: string[];
        if (wide) {
            const rightPanel = panel(t, modelLines, { width: modelW, paddingY: 0, title: undefined });
            body = sideBySide(leftCol, rightPanel, 2);
        } else {
            body = leftCol;
        }

        // ── Input row (+ slash-command suggestions while typing) ──
        const caret = this.busy ? ' ' : t.palette.accentBold('│');
        const shownInput = truncateVisible(this.input, chatW - 6);
        const inputRow = ' ' + t.palette.accentBold('› ') + t.palette.text(shownInput) + caret +
            (this.confirmQuit ? '   ' + t.palette.warn('Quit? (y/n)') : '');

        let suggestionLine = '';
        if (suggesting) {
            const matches = CHAT_COMMANDS.filter(c => c.startsWith(this.input.toLowerCase()));
            if (matches.length > 0) {
                suggestionLine = ' ' + t.palette.dim(matches.join('   ')) +
                    (matches.length === 1 ? t.palette.dim('   Tab/Enter to run') : '');
            }
        }

        // ── Footer ──
        const hints = t.palette.dim('Enter send · ↑↓ scroll · Ctrl+L clear · Esc quit') +
            (wide ? '' : '  ' + t.palette.dim(shorten(info.activeId, Math.max(8, w - 44))));
        const footerSep = t.palette.border('─'.repeat(Math.min(w, 200)));

        const frame: string[] = [header, sep];
        for (let i = 0; i < bodyH; i++) frame.push(body[i] ?? '');
        if (suggestionLine) frame.push(truncateVisible(suggestionLine, w));
        frame.push(truncateVisible(inputRow, w));
        frame.push(footerSep);
        frame.push(' ' + truncateVisible(hints, w - 2));

        // Hard guarantee: no composed row can ever exceed the terminal width,
        // whatever the content (long tokens, wide glyphs, hint collisions).
        return frame.map(l => truncateVisible(l, w));
    }

    streamingText = 'thinking…';

    draw(): void {
        this.screen.render(this.composeFrame(this.screen.width, this.screen.height));
    }

    /**
     * Handle one key event. Public so tests can drive the UI headlessly.
     * Returns 'quit' when the loop should end.
     */
    handleKey(key: KeyMsg): 'continue' | 'quit' {
        if (this.confirmQuit) {
            if (key.type === 'char' && key.text.toLowerCase() === 'y') return 'quit';
            if (key.type === 'enter' || key.type === 'esc' ||
                (key.type === 'char' && key.text.toLowerCase() === 'n')) {
                this.confirmQuit = false;
            }
            return 'continue';
        }

        switch (key.type) {
            case 'ctrl':
                if (key.name === 'c') return 'quit';
                if (key.name === 'l') { this.transcript = []; this.history = []; this.scrollFromBottom = 0; }
                return 'continue';
            case 'esc':
                this.confirmQuit = true;
                return 'continue';
            case 'up':
                this.scrollFromBottom += 3;
                return 'continue';
            case 'down':
                this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 3);
                return 'continue';
            case 'backspace':
                this.input = this.input.slice(0, -1);
                return 'continue';
            case 'space':
                this.input += ' ';
                return 'continue';
            case 'tab': {
                // Complete a unique slash command
                if (this.input.startsWith('/') && !this.input.includes(' ')) {
                    const matches = CHAT_COMMANDS.filter(c => c.startsWith(this.input.toLowerCase()));
                    if (matches.length === 1) this.input = matches[0];
                }
                return 'continue';
            }
            case 'enter':
                void this.submitCurrentInput();
                return 'continue';
            case 'char':
                this.input += key.text;
                return 'continue';
            case 'mouse': {
                if (key.action === 'scroll-up') { this.scrollFromBottom += 3; return 'continue'; }
                if (key.action === 'scroll-down') { this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 3); return 'continue'; }
                return 'continue';
            }
            default:
                return 'continue';
        }
    }

    /** Send whatever is typed. Slash commands are handled locally (public for tests). */
    async submitCurrentInput(): Promise<void> {
        const text = this.input.trim();
        if (!text || this.busy) return;
        this.input = '';
        this.scrollFromBottom = 0;

        if (text.startsWith('/')) {
            this.handleCommand(text);
            return;
        }

        this.transcript.push({ role: 'you', text });
        this.history.push({ role: 'user', content: text });

        await this.generate();
    }

    /** Local slash commands — the old readline chat's command surface, TUI-native. */
    handleCommand(raw: string): void {
        const cmd = raw.toLowerCase().split(/\s+/)[0];
        const info = describeActiveModel();
        switch (cmd) {
            case '/help':
                this.transcript.push({ role: 'sys', text: [
                    'Commands:',
                    '  /help            this list',
                    '  /model           which model is running (tier, context, health)',
                    '  /models          same as /model — active model details',
                    '  /voice           switch to voice-to-voice mode (mic + Live)',
                    '  /clear           clear the conversation',
                    '  /exit  /quit     leave the TUI (Esc also works)',
                    '',
                    'Anything else is sent to the model.',
                ].join('\n') });
                break;
            case '/model':
            case '/models':
            case '/status': {
                const args = raw.trim().split(/\s+/);
                if (args.length > 1 && (cmd === '/model' || cmd === '/models')) {
                    const newModel = args[1];
                    const cfg = Config.get();
                    cfg.agent.model = newModel;
                    Config.saveConfig({ agent: cfg.agent });
                    this.transcript.push({ role: 'sys', text: `Switched model to: ${newModel}` });
                    break;
                }

                if (cmd === '/models') {
                    const providers = ModelRouter.getProviders();
                    const lines = providers.map((p: any) => `  ${p.id} [${p.tier || 'Standard'}]${p.id === info.activeId ? ' (active)' : ''}`);
                    this.transcript.push({ role: 'sys', text: [
                        'Available Models:',
                        ...lines,
                        '',
                        'Type /model <id> to switch live.'
                    ].join('\n') });
                    break;
                }

                const last = this.lastReplyInfo
                    ? `Last reply by: ${this.lastReplyInfo.model} (${(this.lastReplyInfo.durationMs / 1000).toFixed(1)}s${this.lastReplyInfo.usage?.costUsd !== undefined ? `, $${this.lastReplyInfo.usage.costUsd.toFixed(4)}` : ''})`
                    : 'No replies yet.';
                this.transcript.push({ role: 'sys', text: [
                    `Configured : ${info.configuredId}`,
                    `Answering  : ${info.activeId} [${info.tier}]`,
                    `Context    : ${info.contextLabel}${info.chips.length ? `   ${info.chips.join(' · ')}` : ''}`,
                    `Health     : ${info.health}${info.remote ? '  (external service)' : ''}`,
                    last,
                    '',
                    'Type /models to see available models.'
                ].join('\n') });
                break;
            }
            case '/voice':
                // Real handoff: TUI cleanly exits and the CLI launches voice mode.
                this.transcript.push({ role: 'sys', text: '🎙️  Switching to voice mode… (terminal will hand over)' });
                this.voiceRequested = true;
                this.quitRequested = true;
                break;
            case '/clear':
                this.transcript = [];
                this.history = [];
                this.scrollFromBottom = 0;
                break;
            case '/exit':
            case '/quit':
                this.quitRequested = true;
                break;
            default:
                this.transcript.push({ role: 'sys', text: `Unknown command "${cmd}". Type /help for the list.` });
        }
    }

    /** Generate a Rose reply using the injected/router responder. */
    async generate(): Promise<void> {
        this.busy = true;
        this.streamingText = 'thinking…';
        this.startSpinnerTick();

        // Live placeholder that streams deltas into the transcript.
        const streamEntry: TranscriptEntry = { role: 'rose', text: '' };
        let streamed = false;
        let lastPaint = 0;
        const onDelta = (d: string) => {
            if (!streamed) { streamed = true; this.transcript.push(streamEntry); this.scrollFromBottom = 0; }
            streamEntry.text += d;
            this.streamingText = 'streaming…';
            // Repaint while streaming even when animations are disabled.
            const now = Date.now();
            if (now - lastPaint > 50) { lastPaint = now; this.draw(); }
        };

        try {
            // Language directive applied HERE so every responder (router or
            // injected test double) receives the same baseline instruction.
            const reply = await this.responder(
                this.history.slice(),
                getSystemInstruction() + languageDirective(),
                onDelta,
            );
            if (!streamed) {
                this.transcript.push({ role: 'rose', text: reply.text || '(empty reply)' });
            } else if (reply.text && reply.text !== streamEntry.text) {
                streamEntry.text = reply.text; // authoritative final text
            }
            if (reply.model || reply.usage || reply.durationMs !== undefined) {
                this.lastReplyInfo = {
                    model: reply.model ?? '(unknown)',
                    usage: reply.usage,
                    durationMs: reply.durationMs ?? 0,
                };
            }
            this.history.push({ role: 'assistant', content: reply.text });
        } catch (err: any) {
            this.errorCount++;
            this.transcript.push({
                role: 'sys',
                text: `Request failed: ${err?.message ?? String(err)}`,
            });
        } finally {
            this.busy = false;
            this.stopSpinnerTick();
            this.scrollFromBottom = 0;
            // BUGFIX: the spinner tick stopped — paint the FINAL state now,
            // otherwise the reply stays invisible until the next keypress.
            this.draw();
        }
    }

    private startSpinnerTick(): void {
        const interval = this.theme.spinnerIntervalMs;
        if (interval === null || this.spinnerTimer) return;
        this.spinnerTimer = setInterval(() => {
            this.spinnerFrame++;
            this.draw();
        }, interval);
        this.spinnerTimer.unref?.();
    }

    private stopSpinnerTick(): void {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = null;
        }
    }

    private async keyLoop(): Promise<void> {
        while (true) {
            const key = await this.screen.readKey();
            const result = this.handleKey(key);
            this.draw();
            if (result === 'quit' || this.quitRequested) {
                this.quitResolve?.();
                return;
            }
        }
    }
}

// ─── Small helpers ──────────────────────────────────────────

function kv(t: Theme, key: string, value: string, keyWidth: number): string {
    return t.palette.dim(padEndVisible(key + ':', keyWidth)) + t.palette.text(value);
}

function tierLabel(tier: string): string {
    // Human-friendly capability hint: high/low phrasing users asked for.
    switch (tier) {
        case 'Fast': return 'Low (fast)';
        case 'Local': return 'Local';
        case 'Fallback': return 'Backup';
        case '—': case '-': return 'starting…';
        default: return `High (${tier})`;
    }
}

function chipsNonEmpty(c: string[]): boolean { return c.length > 0; }

function center(s: string, w: number): string {
    const left = Math.max(0, Math.floor((w - stripAnsi(s).length) / 2));
    return ' '.repeat(left) + s;
}

function truncateVisible(s: string, max: number): string {
    if (visibleLength(s) <= max) return s;
    let out = ''; let vis = 0;
    for (let i = 0; i < s.length && vis < max - 1; i++) {
        if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) { out += m[0]; i += m[0].length - 1; continue; }
            continue;
        }
        out += s[i]; vis++;
    }
    return out + '…';
}

function sideBySide(a: string[], b: string[], gap: number): string[] {
    const rows = Math.max(a.length, b.length);
    const widthA = Math.max(0, ...a.map(l => visibleLength(l)));
    const out: string[] = [];
    for (let i = 0; i < rows; i++) {
        const la = a[i] ?? '';
        const lb = b[i] ?? '';
        out.push(la + ' '.repeat(Math.max(gap, widthA - visibleLength(la) + gap)) + lb);
    }
    return out;
}

export function shorten(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}
