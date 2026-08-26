/**
 * Phase 33 — Setup step screens.
 *
 * Each screen is a pure state machine over the shared SetupApp: render()
 * produces frame fragments, a key handler mutates state. Screens call the
 * configuration service / health module for anything persistent — they never
 * write config or fake results themselves (spec 27, 76-79).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { KeyMsg } from '../tui/screen.js';
import { Theme } from '../tui/theme.js';
import {
    Fragment, frag, selectList, SelectItem, checkboxRow, textInput,
    statusRow, kvRow, heading, progressBar, HealthState,
} from '../tui/widgets.js';
import {
    SetupApp, StepId, MANAGER_SECTIONS, shortenHome,
} from './app.js';
import {
    DraftConfig, VOICE_NAME_OPTIONS, defaultModelFor, envCredentialDetected, detectProject,
    resolveWorkspacePath, maskSecret, diffAgainstCurrent, configFileExists,
    type FieldKey,
} from './configService.js';
import {
    probeProvider, isPortFree, findFreePort, summarize, CheckResult,
} from './health.js';
import { OpenRouterProvider, type OpenRouterModelInfo } from '../providers/openrouter.js';

export type StepNav = 'continue' | 'exit' | 'done' | 'launch';

// ─── Per-app transient step state ───────────────────────────

const transient = new WeakMap<SetupApp, Map<string, unknown>>();

function st<T>(app: SetupApp, key: string, def: T): T {
    let m = transient.get(app);
    if (!m) { m = new Map(); transient.set(app, m); }
    if (!m.has(key)) m.set(key, def);
    return m.get(key) as T;
}
function stSet(app: SetupApp, key: string, value: unknown): void {
    st(app, key, value);
}

/** Shared per-app UI state access for the app shell (scroll anchoring). */
export const uiState = { get: st, set: stSet };

const MODELS_BY_PROVIDER: Record<string, Array<{ id: string; tier: string }>> = {
    gemini: [
        { id: 'gemini-2.0-flash', tier: 'Fast' },
        { id: 'gemini-2.0-pro-exp', tier: 'Smart' },
    ],
    anthropic: [
        { id: 'claude-3-5-sonnet-20241022', tier: 'Thinking' },
        { id: 'claude-3-opus-20240229', tier: 'Most Capable' },
        { id: 'claude-3-5-haiku-20241022', tier: 'Fast' },
    ],
    openai: [
        { id: 'gpt-4o', tier: 'Smart' },
        { id: 'gpt-4o-mini', tier: 'Fast' },
        { id: 'gpt-4-turbo', tier: 'Powerful' },
    ],
};

const PROVIDER_CHOICES: Array<{ id: DraftConfig['provider']; label: string; hint: string }> = [
    { id: 'proxy', label: 'Antigravity Proxy', hint: 'Claude/GPT via local proxy' },
    { id: 'gemini', label: 'Google Gemini', hint: 'Direct API · Live voice' },
    { id: 'anthropic', label: 'Anthropic Claude', hint: 'Direct API' },
    { id: 'openai', label: 'OpenAI GPT', hint: 'Direct API' },
    { id: 'openrouter', label: 'OpenRouter', hint: '400+ models · external service' },
];

// ═══ RENDER ENTRY POINT ═══════════════════════════════════

export function renderStepContent(
    app: SetupApp, view: StepId | 'dashboard', width: number, height: number
): Fragment {
    const inner = Math.max(20, width - 4); // account for panel borders
    switch (view) {
        case 'welcome': return renderWelcome(app, inner);
        case 'provider': return renderProvider(app, inner);
        case 'workspace': return renderWorkspace(app, inner);
        case 'memory': return renderMemory(app, inner);
        case 'voice': return renderVoice(app, inner);
        case 'security': return renderSecurity(app, inner);
        case 'appearance': return renderAppearance(app, inner);
        case 'web': return renderWeb(app, inner);
        case 'review': return renderReview(app, inner);
        case 'health': return renderHealth(app, inner);
        case 'complete': return renderComplete(app, inner);
        case 'dashboard': return renderDashboard(app, inner);
        default: return frag([`Unknown view: ${view}`]);
    }
}

// ═══ WELCOME ══════════════════════════════════════════════

function renderWelcome(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const lines = [
        '',
        heading(t, 'Welcome to Rose'),
        '',
        t.palette.text('Your AI Agent Platform is installed.'),
        '',
        t.palette.dim("Let's configure:"),
        ...['AI provider', 'Workspace', 'Memory', 'Security', 'Appearance & theme', 'Web Control Panel']
            .map(s => `  ${t.icons.bullet} ${t.palette.text(s)}`),
        '',
        t.palette.dim('Setup takes about two minutes. You can change'),
        t.palette.dim('everything later with `rose setup`.'),
        '',
        t.palette.accentBold(`${t.icons.selected} Press Enter to continue`),
    ];
    return frag(lines.slice(0, Math.max(8, w)));
}

// ═══ AI PROVIDER ═════════════════════════════════════════

/**
 * AI Provider screen — FLAT CURSOR navigation (bugfix: ↑↓ ab har visible row
 * par chalte hain). Enter/click activates; typing edits the focused field.
 */
type CredField = 'geminiKey' | 'anthropicKey' | 'openaiKey' | 'openrouterKey' | 'proxyUrl';

type ProviderRow =
    | { kind: 'provider'; id: DraftConfig['provider'] }
    | { kind: 'cred'; field: CredField }
    | { kind: 'model'; value: string }
    | { kind: 'modelText' }
    | { kind: 'action'; btn: 0 | 1 };

const CRED_FIELD_BY_PROVIDER: Partial<Record<DraftConfig['provider'], {
    field: CredField; masked: boolean; label: string; placeholder?: string;
}>> = {
    gemini: { field: 'geminiKey', masked: true, label: 'Gemini API Key', placeholder: 'paste key — kept local, never displayed' },
    anthropic: { field: 'anthropicKey', masked: true, label: 'Anthropic API Key', placeholder: 'paste key — kept local, never displayed' },
    openai: { field: 'openaiKey', masked: true, label: 'OpenAI API Key', placeholder: 'paste key — kept local, never displayed' },
    openrouter: { field: 'openrouterKey', masked: true, label: 'OpenRouter API Key', placeholder: 'sk-or-… kept local, never displayed' },
    proxy: { field: 'proxyUrl', masked: false, label: 'Proxy URL' },
};

/** Reset per-provider discovery caches when the user switches provider. */
function selectProvider(app: SetupApp, id: DraftConfig['provider']): void {
    const d = app.draft;
    if (d.provider === id) return;
    d.provider = id;
    d.model = defaultModelFor(id);
    app.markDirty();
    app.testResult = null;
    stSet(app, 'proxy.models', null);
    stSet(app, 'proxy.fetched', false);
    stSet(app, 'openrouter.models', null);
    stSet(app, 'openrouter.fetched', false);
}

function activateProviderAction(app: SetupApp, btn: 0 | 1): void {
    if (btn === 0) void runProviderTest(app);
    else app.stepForward();
}

function renderProvider(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    // Kick off async model discovery early so results appear on a later frame.
    let orModels = st<Array<OpenRouterModelInfo> | null>(app, 'openrouter.models', null);
    if (d.provider === 'openrouter' && !st<boolean>(app, 'openrouter.fetched', false)) {
        stSet(app, 'openrouter.fetched', true);
        OpenRouterProvider.listModels().then(list => {
            const picked = list
                .filter(m => m.supportsTools !== false)
                .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
                .slice(0, 8);
            stSet(app, 'openrouter.models', picked.length > 0 ? picked : list.slice(0, 8));
        }).catch(() => {});
    }
    let proxyModels = st<Array<{ id: string; tier?: string }> | null>(app, 'proxy.models', null);
    if (d.provider === 'proxy' && !st<boolean>(app, 'proxy.fetched', false)) {
        stSet(app, 'proxy.fetched', true);
        fetchProxyModels(d.proxyUrl).then(list => stSet(app, 'proxy.models', list)).catch(() => {});
    }

    // ── Build interactive row model FIRST so ↑↓ can traverse every visible row ──
    const rowModel: ProviderRow[] = [];
    for (const p of PROVIDER_CHOICES) rowModel.push({ kind: 'provider', id: p.id });
    const cred = CRED_FIELD_BY_PROVIDER[d.provider];
    if (cred) rowModel.push({ kind: 'cred', field: cred.field });

    if (d.provider === 'openrouter') {
        if (orModels && orModels.length > 0) {
            for (const m of orModels) rowModel.push({ kind: 'model', value: `openrouter/${m.id}` });
        } else {
            rowModel.push({ kind: 'modelText' });
        }
    } else if (d.provider === 'proxy') {
        if (proxyModels && proxyModels.length > 0) {
            for (const m of proxyModels.slice(0, 6)) rowModel.push({ kind: 'model', value: m.id });
        } else {
            rowModel.push({ kind: 'modelText' });
        }
    } else {
        for (const m of MODELS_BY_PROVIDER[d.provider] ?? []) rowModel.push({ kind: 'model', value: m.id });
    }
    rowModel.push({ kind: 'action', btn: 0 });
    rowModel.push({ kind: 'action', btn: 1 });
    app.providerRows = rowModel;

    // Cursor default: currently selected provider row (first render only).
    if (!app.prCursorInit) {
        app.prCursor = Math.max(0, rowModel.findIndex(r => r.kind === 'provider' && r.id === d.provider));
        app.prCursorInit = true;
      }
    let cursor = app.prCursor;
    cursor = Math.max(0, Math.min(cursor, rowModel.length - 1));
    app.prCursor = cursor;

    // Absolute screen line of each row entry → scroll anchor follows the cursor.
    const absOfRow = new Array<number>(rowModel.length).fill(-1);

    lines.push(heading(t, 'AI Provider'));
    lines.push('');

    // ── Provider list ──
    rowModel.forEach((r, i) => {
        if (r.kind !== 'provider') return;
        absOfRow[i] = lines.length;
        const p = PROVIDER_CHOICES.find(x => x.id === r.id)!;
        const selected = d.provider === r.id;
        const focused = i === cursor;
        const icon = focused ? t.icons.selected : selected ? t.icons.radioOn : t.icons.radioOff;
        const painter = focused ? ((x: string) => t.palette.accentBold(x))
            : selected ? ((x: string) => t.palette.accent(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${icon} ${p.label}${p.hint ? '  ' + t.palette.dim(p.hint) : ''}`));
        hits.set(lines.length - 1, () => {
            selectProvider(app, r.id);
            app.prCursor = i;
        });
    });

    // ── Credentials ──
    lines.push('');
    lines.push(heading(t, 'Credentials'));
    if (cred) {
        const i = rowModel.findIndex(r2 => r2.kind === 'cred');
        lines.push('');
        const val = String((d as any)[cred.field] ?? '');
        if (val) {
            lines.push(t.palette.ok(`${t.icons.check} ${cred.label.replace(' API Key', ' key')} configured (${maskSecret(val)}) — type below to replace.`));
        } else if (cred.field !== 'proxyUrl') {
            const envProv = cred.field.replace(/Key$/, '') as 'gemini' | 'anthropic' | 'openai' | 'openrouter';
            if (envCredentialDetected(envProv)) {
                lines.push(t.palette.ok(`${t.icons.check} Environment credential detected (masked).`));
            }
        }
        absOfRow[i] = lines.length + 1; // label line; field follows
        lines.push(t.palette.dim(cred.label));
        const err = app.errors.get(cred.field as FieldKey);
        const fieldLines = textInput(t, {
            value: val,
            cursorPos: val.length,
            masked: cred.masked,
            placeholder: cred.placeholder,
            error: err ?? undefined,
        }, Math.min(w, 56));
        for (const fl of fieldLines) lines.push('  ' + fl);
        hits.set(lines.length - fieldLines.length, () => { app.prCursor = i; });
    }

    // ── Default Model ──
    lines.push('');
    lines.push(heading(t, 'Default Model'));
    lines.push('');

    rowModel.forEach((r, i) => {
        if (r.kind === 'model') {
            absOfRow[i] = lines.length;
            const selected = d.model === r.value;
            const focused = i === cursor;
            const icon = focused ? t.icons.selected : selected ? t.icons.radioOn : t.icons.radioOff;
            const painter = focused ? ((x: string) => t.palette.accentBold(x))
                : selected ? ((x: string) => t.palette.accent(x)) : ((x: string) => t.palette.text(x));

            let badge = '';
            if (d.provider === 'openrouter' && orModels) {
                const info = orModels.find(m => `openrouter/${m.id}` === r.value);
                if (info) badge = '  ' + t.palette.dim(capabilityBadge(info));
            } else {
                const tier = MODELS_BY_PROVIDER[d.provider]?.find(x => x.id === r.value)?.tier;
                if (tier) badge = '  ' + t.palette.dim(`(${tier})`);
            }

            lines.push(painter(`${icon} ${r.value}${badge}`));
            hits.set(lines.length - 1, () => {
                app.draft.model = r.value; app.markDirty(); app.prCursor = i;
            });
        } else if (r.kind === 'modelText') {
            absOfRow[i] = lines.length + 1;
            lines.push(t.palette.warn(`${t.icons.warn} List unavailable right now — type a valid model id below.`));
            lines.push(t.palette.dim('Model ID'));
            const fieldLines = textInput(t, {
                value: d.model,
                cursorPos: d.model.length,
                placeholder: d.provider === 'openrouter' ? 'vendor/model e.g. anthropic/claude-3.5-sonnet' : undefined,
            }, Math.min(w, 56));
            for (const fl of fieldLines) lines.push('  ' + fl);
            hits.set(lines.length - fieldLines.length, () => { app.prCursor = i; });
        }
    });

    if (d.provider === 'openrouter' && orModels && orModels.length > 0) {
        lines.push('');
        lines.push(t.palette.dim('Badges: context · T=tools · V=vision — live from OpenRouter discovery.'));
    }

    // ── Actions (each button is its own navigable row) ──
    lines.push('');
    const testLabel = app.testRunning ? 'Testing…' : `${t.icons.check} Test Connection`;
    rowModel.forEach((r, i) => {
        if (r.kind !== 'action') return;
        absOfRow[i] = lines.length;
        const active = i === cursor;
        const label = ` ${r.btn === 0 ? testLabel : 'Continue →'} `;
        lines.push(active ? t.palette.inverse(label) : t.palette.text(label));
        hits.set(lines.length - 1, () => {
            app.prCursor = i;
            activateProviderAction(app, r.btn);
        });
    });

    if (app.testResult) {
        lines.push('');
        lines.push(statusFromCheck(t, app.testResult, w));
        if (app.testResult.fixHint) lines.push(t.palette.dim(`  ${app.testResult.fixHint}`));
    }

    uiState.set(app, 'focusRow', absOfRow[cursor] >= 0 ? absOfRow[cursor] : -1);
    return { lines, rowHits: hits };
}

function capabilityBadge(m: OpenRouterModelInfo): string {
    const parts: string[] = [];
    if (m.contextLength) parts.push(fmtContext(m.contextLength));
    if (m.supportsTools) parts.push('T');
    if (m.supportsVision) parts.push('V');
    return parts.join(' · ');
}

function fmtContext(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

async function fetchProxyModels(proxyUrl: string): Promise<Array<{ id: string; tier?: string }>> {
    try {
        const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) return [];
        const data: any = await res.json();
        return (data.data || []).map((m: any) => ({ id: m.id, tier: m.tier }));
    } catch {
        return [];
    }
}

async function runProviderTest(app: SetupApp): Promise<void> {
    if (app.testRunning) return;
    app.testRunning = true;
    app.testResult = null;
    app.startSpinner('Testing connection...');
    try {
        app.testResult = await probeProvider({
            provider: app.draft.provider,
            model: app.draft.model,
            geminiKey: app.draft.geminiKey || process.env.GEMINI_API_KEY,
            anthropicKey: app.draft.anthropicKey || process.env.ANTHROPIC_API_KEY,
            openaiKey: app.draft.openaiKey || process.env.OPENAI_API_KEY,
            openrouterKey: app.draft.openrouterKey || process.env.OPENROUTER_API_KEY,
            proxyUrl: app.draft.proxyUrl,
        });
    } finally {
        app.stopSpinner();
        app.testRunning = false;
        app.drawFrame(); // paint result immediately (bugfix: needed a keypress before)
    }
}

function statusFromCheck(t: Theme, c: CheckResult, w: number): string {
    const state: HealthState = c.state === 'pass' ? 'pass' : c.state === 'warn' ? 'warn' : c.state === 'fail' ? 'fail' : 'idle';
    const detail = c.detail.length > Math.max(10, w - 30) ? c.detail.slice(0, Math.max(10, w - 33)) + '…' : c.detail;
    return '  ' + statusRow(t, c.label, state, detail, 22);
}

/** Labeled input line pair with hit registration on the field row. */
// ═══ WORKSPACE ════════════════════════════════════════════

function renderWorkspace(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const idx = app.workspaceOptionIdx;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();
    const row = () => lines.length;

    lines.push(heading(t, 'Workspace'));
    lines.push('');
    lines.push(kvRow(t, 'Current directory', shortenHome(process.cwd()), 20));
    lines.push('');

    const options = ['Use current directory', 'Choose directory', 'Create workspace'];
    options.forEach((o, i) => {
        const sel = i === idx;
        const cursor = sel ? t.icons.selected : ' ';
        const painter = sel ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${cursor} ${o}`));
        hits.set(row() - 1 + 1 - 1 + (lines.length - 1), () => {}); // replaced below
    });

    // rebind each option row to its activation handler
    lines.forEach((_, i) => {
        const optIdx = i - firstOptionRow(lines);
        if (optIdx >= 0 && optIdx < options.length) {
            hits.set(i, () => activateWorkspaceOption(app, optIdx));
        }
    });
    uiState.set(app, 'focusRow', firstOptionRow(lines) + app.workspaceOptionIdx);

    if (idx > 0) {
        lines.push('');
        const target = st<string>(app, 'ws.path', d.workspacePath === process.cwd() ? '' : d.workspacePath);
        lines.push(t.palette.dim(idx === 1 ? 'Directory to use:' : 'Directory to create:'));
        const inputLines = textInput(t, {
            value: target,
            cursorPos: target.length,
            placeholder: '~/projects/my-agent',
        }, Math.min(w, 60));
        for (const il of inputLines) lines.push('  ' + il);
        const proj = detectProject(target);
        if (target.trim()) {
            if (proj.detected) {
                lines.push(t.palette.ok(`  ${t.icons.check} Project detected: ${proj.name} (${proj.kind}) — nothing will be modified.`));
            } else {
                lines.push(t.palette.dim('  No existing project detected.'));
            }
            const abs = resolveWorkspacePath(target);
            const exists = safeIsDir(abs);
            if (idx === 1 && !exists) lines.push(t.palette.error(`  ${t.icons.cross} Directory does not exist yet.`));
        }
    }

    const projCur = detectProject(d.workspacePath);
    lines.push('');
    lines.push(kvRow(t, 'Resolved', shortenHome(resolveWorkspacePath(d.workspacePath)), 12));
    if (projCur.detected) lines.push(t.palette.ok(`${t.icons.check} Project detected here: ${projCur.name} (${projCur.kind})`));

    return { lines, rowHits: hits };
}

function firstOptionRow(lines: string[]): number {
    return 4; // heading, blank, kvRow, blank
}

function safeIsDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function activateWorkspaceOption(app: SetupApp, idx: number): void {
    const d = app.draft;
    app.workspaceOptionIdx = idx;
    if (idx === 0) {
        d.workspacePath = process.cwd();
        app.markDirty();
        app.stepForward();
    }
    // idx 1/2 wait for path + Enter (handled in key handler)
}

// ═══ MEMORY ═══════════════════════════════════════════════

function renderMemory(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push(heading(t, 'Memory'));
    lines.push('');
    lines.push(kvRow(t, 'Storage', 'Local memory vault (memory/vault)', 10));
    lines.push(statusRow(t, 'Local Memory', 'pass', 'always on', 18));
    lines.push('');

    // Learning memory toggle
    const learn = checkboxRow(t, d.memoryLearning, 'Learning memory (preferences, strategies)', () => {
        d.memoryLearning = !d.memoryLearning; app.markDirty();
    });
    learn.rowHits?.forEach((cb, rel) => hits.set(lines.length + rel, cb));
    lines.push(...learn.lines);
    lines.push('');

    // Retention
    lines.push(t.palette.dim('Retention — max entries per type'));
    const retLines = textInput(t, { value: String(d.maxEntriesPerType), cursorPos: String(d.maxEntriesPerType).length }, 16);
    for (const rl of retLines) lines.push('  ' + rl);
    lines.push('');

    // Obsidian
    lines.push(heading(t, 'Obsidian'));
    if (d.obsidianVaultPath) {
        const ok = safeIsDir(resolveWorkspacePath(d.obsidianVaultPath));
        lines.push(ok
            ? t.palette.ok(`${t.icons.radioOn} Connected → ${shortenHome(resolveWorkspacePath(d.obsidianVaultPath))}`)
            : t.palette.error(`${t.icons.cross} Path not found`));
    } else {
        lines.push(t.palette.dim(`${t.icons.radioOff} Not configured`));
    }
    const obsLines = textInput(t, {
        value: d.obsidianVaultPath,
        cursorPos: d.obsidianVaultPath.length,
        placeholder: 'path/to/your/vault (optional)',
    }, Math.min(w, 58));
    obsLines.forEach(ol => lines.push('  ' + ol));
    hits.set(lines.length - obsLines.length, () => {});
    const testLine = app.obsidianTest
        ? '  ' + statusFromCheck(t, app.obsidianTest, w)
        : '  ' + t.palette.dim('Test verifies the folder exists and is writable.');
    lines.push(testLine);
    lines.push('');
    lines.push(t.palette.text(' Save ') + t.palette.dim('(Enter applies section)'));
    lines.push(t.palette.dim('Saved entries mirror into the vault when configured.'));

    return { lines, rowHits: hits };
}

// ═══ VOICE (Gemini Live) ══════════════════════════════════

/**
 * Voice setup screen: voice personality, microphone, screen-share.
 * Flat-cursor navigation like AI Provider; mic list is detected lazily.
 */
type VoiceRow =
    | { kind: 'voice'; id: string }
    | { kind: 'mic'; id: string }        // '' = auto
    | { kind: 'screenshare'; value: boolean }
    | { kind: 'interval' }
    | { kind: 'action'; btn: 0 };

async function ensureMics(app: SetupApp): Promise<void> {
    if (st<boolean>(app, 'voice.micsFetched', false)) return;
    stSet(app, 'voice.micsFetched', true);
    try {
        const { detectTools, listInputDevices } = await import('../audio.js');
        const tools = await detectTools();
        if (tools.ffmpeg) {
            const devices = await listInputDevices();
            stSet(app, 'voice.mics', devices);
        } else {
            stSet(app, 'voice.mics', []);
            stSet(app, 'voice.micsError', 'ffmpeg not found on PATH');
        }
    } catch (e: any) {
        stSet(app, 'voice.mics', []);
        stSet(app, 'voice.micsError', e.message ?? String(e));
    }
}

function renderVoice(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    void ensureMics(app);
    const mics = st<string[] | null>(app, 'voice.mics', null);

    // Row model
    const rowModel: Array<
        | { kind: 'voice'; id: string }
        | { kind: 'mic'; id: string }
        | { kind: 'screenshare'; value: boolean }
        | { kind: 'interval' }
        | { kind: 'action'; btn: 0 }
    > = [];
    for (const v of VOICE_NAME_OPTIONS) rowModel.push({ kind: 'voice', id: v });
    rowModel.push({ kind: 'mic', id: '' }); // Auto
    for (const m of mics ?? []) rowModel.push({ kind: 'mic', id: m });
    rowModel.push({ kind: 'screenshare', value: true });
    rowModel.push({ kind: 'screenshare', value: false });
    rowModel.push({ kind: 'interval' });
    rowModel.push({ kind: 'action', btn: 0 });
    app.providerRows = rowModel as typeof app.providerRows;

    if (!st<boolean>(app, 'voice.cursorInit', false)) {
        stSet(app, 'voice.cursorInit', true);
        app.prCursor = Math.max(0, rowModel.findIndex(r => r.kind === 'voice' && r.id === d.voiceName));
    }
    let cursor = Math.max(0, Math.min(st<number>(app, 'voice.cursor', 0), rowModel.length - 1));
    stSet(app, 'voice.cursor', cursor);
    // Reuse prCursor so shared key-handler helpers stay coherent.
    app.prCursor = cursor;

    lines.push(heading(t, 'Voice'));
    lines.push('');
    lines.push(t.palette.dim('Gemini Live voice-to-voice · applies after save'));

    // ── Voice personality ──
    lines.push('');
    lines.push(heading(t, 'Voice Personality'));
    lines.push('');
    rowModel.forEach((r, i) => {
        if (r.kind !== 'voice') return;
        const selected = d.voiceName === r.id;
        const focused = i === cursor;
        const icon = focused ? t.icons.selected : selected ? t.icons.radioOn : t.icons.radioOff;
        const painter = focused ? ((x: string) => t.palette.accentBold(x)) : selected ? ((x: string) => t.palette.accent(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${icon} ${r.id}`));
        hits.set(lines.length - 1, () => { d.voiceName = r.id; app.markDirty(); app.prCursor = i; });
    });

    // ── Microphone ──
    lines.push('');
    lines.push(heading(t, 'Microphone'));
    lines.push('');
    if (mics === null) {
        lines.push(t.palette.dim('Detecting microphones…'));
    } else if (mics.length === 0) {
        const err = st<string>(app, 'voice.micsError', '');
        lines.push(t.palette.warn(`${t.icons.warn} ${err || 'No input devices detected'} — install FFmpeg to enable mic capture.`));
    } else {
        rowModel.forEach((r, i) => {
            if (r.kind !== 'mic') return;
            const label = r.id === '' ? 'Auto (first detected)' : r.id;
            const selected = (d.defaultMic || '') === r.id ||
                (!d.defaultMic && r.id === '') ||
                (r.id !== '' && d.defaultMic && r.id.toLowerCase().includes(d.defaultMic.toLowerCase()));
            const focused = i === cursor;
            const icon = focused ? t.icons.selected : selected ? t.icons.radioOn : t.icons.radioOff;
            const painter = focused ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
            lines.push(painter(`${icon} ${truncateStr(label, Math.max(12, w - 8))}`));
            hits.set(lines.length - 1, () => {
                d.defaultMic = r.id; // '' = auto
                app.markDirty(); app.prCursor = i;
            });
        });
    }

    // ── Screen share ──
    lines.push('');
    lines.push(heading(t, 'Screen Share'));
    lines.push(t.palette.dim('Lets the model see your screen while talking.'));
    lines.push('');
    for (const val of [true, false]) {
        const i = rowModel.findIndex(r2 => r2.kind === 'screenshare' && r2.value === val);
        const selected = d.screenShare === val;
        const focused = i === cursor;
        const icon = focused ? t.icons.selected : selected ? t.icons.radioOn : t.icons.radioOff;
        const painter = focused ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${icon} ${val ? 'Enabled' : 'Disabled'}`));
        hits.set(lines.length - 1, () => { d.screenShare = val; app.markDirty(); app.prCursor = i; });
    }

    // ── Capture interval ──
    {
        const i = rowModel.findIndex(r2 => r2.kind === 'interval');
        lines.push('');
        lines.push(t.palette.dim('Screen capture interval (ms)'));
        absRow(i, () => lines.length + 1);
        const err = app.errors.get('screenIntervalMs');
        const fieldLines = textInput(t, {
            value: String(d.screenIntervalMs),
            cursorPos: String(d.screenIntervalMs).length,
            error: err ?? undefined,
        }, 14);
        for (const fl of fieldLines) lines.push('  ' + fl);
        hits.set(lines.length - fieldLines.length, () => { app.prCursor = i; });
    }

    // ── Save action ──
    lines.push('');
    rowModel.forEach((r, i) => {
        if (r.kind !== 'action') return;
        const active = i === cursor;
        const label = active ? ' Save Voice Settings ' : ' Save Voice Settings ';
        lines.push(active ? t.palette.inverse(label) : t.palette.text(label));
        hits.set(lines.length - 1, () => {
            app.prCursor = i;
            void app.applyAndThen(() => { /* stay */ });
        });
    });

    function absRow(_i: number, _fn: () => number): void { /* helper kept for clarity */ }

    uiState.set(app, 'focusRow', Math.max(0, lines.length - 4));
    return { lines, rowHits: hits };
}

function handleVoice(app: SetupApp, key: KeyMsg): StepNav {
    const rows = app.providerRows;
    if (rows.length === 0) return 'continue';
    let cur = Math.max(0, Math.min(rows.length - 1, app.prCursor));

    switch (key.type) {
        case 'up':
        case 'shifttab':
            cur--; break;
        case 'down':
        case 'tab':
            cur++; break;
        case 'enter':
        case 'space': {
            app.prCursor = cur;
            const r: any = rows[cur];
            if (!r) return 'continue';
            const d = app.draft;
            if (r.kind === 'voice') d.voiceName = r.id;
            else if (r.kind === 'mic') d.defaultMic = r.id;
            else if (r.kind === 'screenshare') d.screenShare = r.value;
            else if (r.kind === 'interval') return 'continue';
            else if (r.kind === 'action') { void app.applyAndThen(() => {}); }
            app.markDirty();
            return 'continue';
        }
        case 'char': {
            const r: any = rows[cur];
            if (r?.kind === 'interval' && /^[0-9]$/.test(key.text)) {
                const s = String(app.draft.screenIntervalMs);
                app.draft.screenIntervalMs = parseInt((s + key.text).slice(0, 6), 10) || 0;
                app.markDirty();
                app.errors.delete('screenIntervalMs');
            }
            return 'continue';
        }
        case 'backspace': {
            const r: any = rows[cur];
            if (r?.kind === 'interval') {
                const s = String(app.draft.screenIntervalMs).slice(0, -1);
                app.draft.screenIntervalMs = parseInt(s, 10) || 0;
                app.markDirty();
            }
            return 'continue';
        }
        default:
            return 'continue';
    }
    app.prCursor = Math.max(0, Math.min(rows.length - 1, cur));
    return 'continue';
}


// ═══ SECURITY ═════════════════════════════════════════════

const AUTONOMY_OPTIONS: Array<{ id: 'safe' | 'balanced' | 'autonomous'; label: string; desc: string }> = [
    { id: 'safe', label: 'Ask before every tool', desc: 'Safest. Confirms terminal and file writes.' },
    { id: 'balanced', label: 'Ask before sensitive actions', desc: 'Recommended. Destructive/external always confirm.' },
    { id: 'autonomous', label: 'Trusted mode', desc: 'No prompts except destructive actions.' },
];

const FULL_ACCESS_OPTIONS: Array<{ value: boolean; label: string; desc: string }> = [
    { value: true,  label: 'Full System Access',       desc: 'Rose can run any command. Only truly dangerous commands (format, shutdown, rm -rf /) are blocked.' },
    { value: false, label: 'Restricted (ask first)',    desc: 'Rose will ask permission before running commands not on the safe list.' },
];

function renderSecurity(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    // ── Full System Access (shown first, most important) ──
    lines.push(heading(t, 'System Access Level'));
    lines.push('');
    FULL_ACCESS_OPTIONS.forEach((o, i) => {
        const sel = d.fullAccess === o.value;
        const focusedRow = i === app.securityIdx;
        const icon = sel ? t.icons.radioOn : t.icons.radioOff;
        const painter = focusedRow ? ((x: string) => t.palette.accentBold(x))
            : sel ? ((x: string) => t.palette.accent(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${focusedRow ? t.icons.selected : ' '} ${icon} ${o.label}${sel && !focusedRow ? t.palette.accent('  ←') : ''}`));
        hits.set(lines.length - 1, () => {
            d.fullAccess = o.value; app.markDirty();
            refreshSecurityPreview(app);
        });
        lines.push('   ' + t.palette.dim(o.desc));
    });
    lines.push('');

    // ── Autonomy Policy ──
    lines.push(heading(t, 'Default Action Policy'));
    lines.push('');
    AUTONOMY_OPTIONS.forEach((o, i) => {
        const rowIdx = i + FULL_ACCESS_OPTIONS.length;
        const sel = o.id === d.autonomy;
        const focusedRow = rowIdx === app.securityIdx;
        const icon = sel ? t.icons.radioOn : t.icons.radioOff;
        const painter = focusedRow ? ((x: string) => t.palette.accentBold(x))
            : sel ? ((x: string) => t.palette.accent(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${focusedRow ? t.icons.selected : ' '} ${icon} ${o.label}${sel && !focusedRow ? t.palette.accent('  ←') : ''}`));
        hits.set(lines.length - 1, () => {
            d.autonomy = o.id; app.markDirty();
            refreshSecurityPreview(app);
        });
        lines.push('   ' + t.palette.dim(o.desc));
    });
    uiState.set(app, 'focusRow', app.securityIdx < (FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length) ? 2 + app.securityIdx * 2 : -1);

    // Policy matrix reflecting ACTUAL SecurityEngine semantics
    lines.push(heading(t, 'Effective Behavior'));
    lines.push('');
    const ask = (label: string, when: string) => statusRow(t, label, 'idle', when, 16);
    lines.push(ask('System commands', d.fullAccess ? 'Allow all (denylist active)' : 'Allowlist only'));
    lines.push(ask('Destructive', 'Always ask'));
    lines.push(ask('External (email/push)', 'Always ask'));
    lines.push(ask('Terminal / system', d.autonomy === 'safe' ? 'Ask' : 'Allow silently'));
    lines.push(ask('Filesystem writes', d.autonomy === 'safe' ? 'Ask' : 'Allow silently'));
    lines.push(ask('Secret redaction', 'Always on'));
    lines.push('');

    const fed = checkboxRow(t, d.allowFederation, 'Allow agent federation (network delegation)', () => {
        d.allowFederation = !d.allowFederation; app.markDirty();
    });
    if (app.securityIdx === FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length) {
        uiState.set(app, 'focusRow', lines.length);
    }
    fed.rowHits?.forEach((cb, rel) => hits.set(lines.length + rel, cb));
    lines.push(...fed.lines);
    lines.push('');
    lines.push(t.palette.dim('The backend Policy Engine stays authoritative — the UI cannot bypass it.'));

    // ── Action ──
    lines.push('');
    const btnIdx = FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length + 1;
    const btnActive = app.securityIdx === btnIdx;
    const btnLabel = app.mode === 'manager' ? ' Done → ' : ' Continue → ';
    lines.push(btnActive ? t.palette.inverse(btnLabel) : t.palette.text(btnLabel));
    hits.set(lines.length - 1, () => {
        app.securityIdx = btnIdx;
        if (app.mode === 'manager') {
            app.openSection = null;
        } else {
            app.stepForward();
        }
    });

    if (btnActive) {
        uiState.set(app, 'focusRow', lines.length - 1);
    }

    return { lines, rowHits: hits };
}

function refreshSecurityPreview(_app: SetupApp): void { /* values render live from draft */ }

// ═══ APPEARANCE ═══════════════════════════════════════════

interface AppearanceRow {
    label: string;
    get(): string;
    adjust(dir: 1 | -1): void;
}

const THEME_CYCLE = [
    { id: 'roseDark' as const, label: 'Rose Dark' },
    { id: 'roseLight' as const, label: 'Rose Light' },
    { id: 'system' as const, label: 'System' },
];
const ACCENT_CYCLE = ['rose', 'blue', 'purple', 'green', 'amber'] as const;
const DENSITY_CYCLE = ['comfortable', 'compact', 'minimal'] as const;
const ANIMATION_CYCLE = ['enabled', 'reduced', 'disabled'] as const;
const UNICODE_CYCLE = ['auto', 'on', 'off'] as const;

function appearanceRows(app: SetupApp): AppearanceRow[] {
    const d = app.draft;
    const cycle = <T>(list: readonly T[], cur: T, set: (v: T) => void, dir: 1 | -1): void => {
        const i = list.indexOf(cur);
        const next = list[(((i < 0 ? 0 : i) + dir) % list.length + list.length) % list.length];
        set(next);
    };
    return [
        {
            label: 'Theme',
            get: () => THEME_CYCLE.find(x => x.id === d.appearance.theme)?.label ?? d.appearance.theme,
            adjust: (dir) => cycle(THEME_CYCLE.map(x => x.id), d.appearance.theme, (v) => {
                d.appearance.theme = v;
                if (v === 'system') d.appearance.theme = resolveSystemThemeSync();
                app.refreshTheme(); app.markDirty();
            }, dir),
        },
        {
            label: 'Accent',
            get: () => accentDisplay(d),
            adjust: (dir) => cycle(ACCENT_CYCLE, isAccent(d.appearance.accent) ? d.appearance.accent : 'rose', (v) => {
                d.appearance.accent = v;
                d.appearance.accentHex = undefined;
                app.refreshTheme(); app.markDirty();
            }, dir),
        },
        {
            label: 'Density',
            get: () => d.appearance.density,
            adjust: (dir) => cycle(DENSITY_CYCLE, d.appearance.density, (v) => {
                d.appearance.density = v; app.refreshTheme(); app.markDirty();
            }, dir),
        },
        {
            label: 'Animations',
            get: () => d.appearance.animations,
            adjust: (dir) => cycle(ANIMATION_CYCLE, d.appearance.animations, (v) => {
                d.appearance.animations = v; app.refreshTheme(); app.markDirty();
            }, dir),
        },
        {
            label: 'Unicode mode',
            get: () => d.appearance.unicode,
            adjust: (dir) => cycle(UNICODE_CYCLE, d.appearance.unicode, (v) => {
                d.appearance.unicode = v; app.refreshTheme(); app.markDirty();
            }, dir),
        },
        {
            label: 'High contrast',
            get: () => d.appearance.highContrast ? 'on' : 'off',
            adjust: () => {
                d.appearance.highContrast = !d.appearance.highContrast;
                app.refreshTheme(); app.markDirty();
            },
        },
    ];
}

function isAccent(v: string): v is typeof ACCENT_CYCLE[number] {
    return (ACCENT_CYCLE as readonly string[]).includes(v);
}

function accentDisplay(d: DraftConfig): string {
    if (d.appearance.accent === 'custom' && d.appearance.accentHex) return `custom ${d.appearance.accentHex}`;
    return String(d.appearance.accent);
}

/** Best-effort OS theme detection for "System" (Windows registry / fallback dark). */
let systemThemeCache: 'roseDark' | 'roseLight' | null = null;
function resolveSystemThemeSync(): 'roseDark' | 'roseLight' {
    if (systemThemeCache) return systemThemeCache;
    try {
        if (process.platform === 'win32') {
            // Synchronous reg query is acceptable inside setup only.
            const out = execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme',
                { encoding: 'utf8', timeout: 1500 }
            );
            systemThemeCache = /0x1/.test(out) ? 'roseLight' : 'roseDark';
            return systemThemeCache;
        }
        if (process.platform === 'darwin') {
            const out = execSync('defaults read -g AppleInterfaceStyle', { encoding: 'utf8', timeout: 1500 });
            systemThemeCache = /Dark/i.test(out) ? 'roseDark' : 'roseLight';
            return systemThemeCache;
        }
    } catch { /* fall through to dark default */ }
    systemThemeCache = 'roseDark';
    return systemThemeCache;
}

function renderAppearance(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const rows = appearanceRows(app);
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push(heading(t, 'Appearance'));
    lines.push('');
    lines.push(t.palette.dim('↑↓ choose setting · ←→ change value · preview updates instantly'));
    lines.push('');

    rows.forEach((r, i) => {
        const sel = i === app.appearanceSectionIdx;
        const cursor = sel ? t.icons.selected : ' ';
        const painter = sel ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
        const value = padEndStr(r.get(), 18);
        lines.push(painter(`${cursor} ${padEndStr(r.label, 15)} ${t.palette.accent(sel ? '◂ ' + value + ' ▸' : value)}`));
        hits.set(lines.length - 1, () => { app.appearanceSectionIdx = i; });
    });
    uiState.set(app, 'focusRow', 4 + app.appearanceSectionIdx);

    // Custom accent input appears when custom selected
    if (app.draft.appearance.accent === 'custom' || app.customAccentFocused) {
        lines.push('');
        lines.push(t.palette.dim('Custom accent hex (#rrggbb):'));
        const val = app.customAccentInput.value;
        const valid = /^#?[0-9a-fA-F]{6}$/.test(val);
        const inp = textInput(t, {
            value: val,
            cursorPos: app.customAccentInput.cursorPos,
            error: val && !valid ? 'Use #rrggbb hex format.' : undefined,
        }, 20);
        for (const l of inp) lines.push('  ' + l);
        if (valid) {
            app.draft.appearance.accentHex = val.startsWith('#') ? val : '#' + val;
            app.draft.appearance.accent = 'custom';
            app.refreshTheme();
            app.markDirty();
        }
    }

    lines.push('');
    lines.push(progressBar(t, 0.72, Math.max(10, Math.min(40, w - 20))));
    lines.push(t.palette.dim('Sample progress indicator at current density/theme.'));

    return { lines, rowHits: hits };
}

function padEndStr(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ═══ WEB CONTROL PANEL ════════════════════════════════════

function renderWeb(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push(heading(t, 'Web Control Panel'));
    lines.push('');

    ['Yes', 'No'].forEach((opt, i) => {
        const enabled = d.webEnabled ? 0 : 1;
        const sel = i === enabled;
        const focusedRow = i === app.webEnableIdx;
        const icon = sel ? t.icons.radioOn : t.icons.radioOff;
        const painter = focusedRow ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
        lines.push(painter(`${focusedRow ? t.icons.selected : ' '} ${icon} ${opt}`));
        hits.set(lines.length - 1, () => {
            const newVal = i === 0;
            if (newVal !== d.webEnabled) {
                d.webEnabled = newVal; app.markDirty();
                schedulePortCheck(app);
            }
        });
    });
    lines.push('');

    if (!d.webEnabled) {
        lines.push(t.palette.dim('You can enable it anytime with `rose web` or back in settings.'));
        return { lines, rowHits: hits };
    }

    lines.push(t.palette.dim('Host'));
    const hostErr = app.errors.get('webHost');
    const hostInp = textInput(t, {
        value: d.webHost,
        cursorPos: d.webHost.length,
        error: hostErr ?? undefined,
    }, 24);
    hostInp.forEach(l => lines.push('  ' + l));
    hits.set(lines.length - hostInp.length, () => {});
    lines.push('');

    lines.push(t.palette.dim('Port (automatic suggestion offered if busy)'));
    const portInp = textInput(t, {
        value: app.webPortInput.value,
        cursorPos: app.webPortInput.cursorPos,
        error: app.errors.get('webPort') ?? undefined,
    }, 16);
    portInp.forEach(l => lines.push('  ' + l));
    hits.set(lines.length - portInp.length, () => {});

    const statusIcon = app.webPortStatus === 'free'
        ? t.palette.ok(`${t.icons.check} Port ${d.webPort} is available`)
        : app.webPortStatus === 'busy'
            ? t.palette.error(`${t.icons.cross} ${app.webPortMessage || `Port ${d.webPort} is unavailable.`}`)
            : app.webPortStatus === 'checking'
                ? t.palette.dim('Checking port...')
                : t.palette.dim('Port not checked yet.');
    lines.push('  ' + statusIcon);
    if (app.webPortStatus === 'busy') {
        lines.push('');
        lines.push('  ' + t.palette.accentBold('[U] Use another port') + '   ' +
            t.palette.text('[E] Edit manually') + '   ' + t.palette.dim('[Esc] Cancel'));
    }

    lines.push('');
    lines.push(t.palette.dim('Authentication uses the existing backend session layer.'));
    lines.push(t.palette.dim('Default binds to 127.0.0.1 — never exposed publicly.'));

    return { lines, rowHits: hits };
}

const portTimers = new WeakMap<SetupApp, NodeJS.Timeout>();

function schedulePortCheck(app: SetupApp): void {
    const prev = portTimers.get(app);
    if (prev) clearTimeout(prev);
    app.webPortStatus = 'checking';
    const timer = setTimeout(async () => {
        const port = Number(app.draft.webPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            app.webPortStatus = 'unknown';
            return;
        }
        const free = await isPortFree(port, app.draft.webHost);
        app.webPortStatus = free ? 'free' : 'busy';
        if (!free) {
            const suggestion = await findFreePort(port, app.draft.webHost);
            app.webPortMessage = `Port ${port} is unavailable.${suggestion ? ` Free: ${suggestion}` : ''}`;
            stSet(app, 'web.suggestedPort', suggestion);
        }
    }, 350);
    timer.unref?.();
    portTimers.set(app, timer);
}

// ═══ REVIEW ═══════════════════════════════════════════════

function renderReview(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push(heading(t, 'Review'));
    lines.push('');
    lines.push(kvRow(t, 'AI Provider', `${PROVIDER_LABEL(d.provider)} · ${d.model}`, 14));
    lines.push(kvRow(t, 'Credentials', credentialsSummary(d), 14));
    lines.push(kvRow(t, 'Workspace', shortenHome(resolveWorkspacePath(d.workspacePath)), 14));
    lines.push(kvRow(t, 'Memory', memorySummary(d), 14));
    lines.push(kvRow(t, 'Security', AUTONOMY_OPTIONS.find(o => o.id === d.autonomy)?.label ?? d.autonomy, 14));
    lines.push(kvRow(t, 'Appearance', `${themeLabel(d)} · ${accentDisplay(d)} · ${d.appearance.density}`, 14));
    lines.push(kvRow(t, 'Web Panel', d.webEnabled ? `${d.webHost}:${d.webPort}` : 'Disabled', 14));
    lines.push('');

    const changes = diffAgainstCurrent(d);
    app.lastDiff = changes;
    if (configFileExists()) {
        if (changes.length > 0) {
            lines.push(heading(t, 'Changes'));
            lines.push('');
            for (const ch of changes.slice(0, 8)) {
                lines.push(`  ${t.palette.text(padEndStr(ch.label, 14))} ${t.palette.dim(shortenVal(ch.before))} → ${t.palette.accent(shortenVal(ch.after))}`);
            }
            if (changes.length > 8) lines.push(t.palette.dim(`  … and ${changes.length - 8} more`));
        } else {
            lines.push(t.palette.dim('No differences from saved configuration.'));
        }
        lines.push('');
    }

    const options = ['Apply Configuration', 'Go back'];
    options.forEach((o, i) => {
        const sel = i === app.reviewOptionIdx;
        const painter = sel ? ((x: string) => t.palette.inverse(` ${x} `)) : ((x: string) => t.palette.dim(x));
        lines.push('  ' + painter(o) + (i === 1 ? '  ' : ''));
        hits.set(lines.length - 1, () => activateReviewOption(app, i));
    });
    if (app.lastApplyError) {
        lines.push('');
        lines.push(t.palette.error(`${t.icons.cross} Last apply failed: ${app.lastApplyError}`));
    }

    return { lines, rowHits: hits };
}

function activateReviewOption(app: SetupApp, idx: number): void {
    if (idx === 0) {
        void app.applyAndThen(() => {
            app.lastDiff = [];
            if (app.mode === 'wizard') app.goTo('health');
        });
    } else if (app.mode === 'manager') {
        app.openSection = null;
    } else {
        app.goTo('provider');
    }
}

function shortenVal(v: string): string {
    if (v.length > 34) return v.slice(0, 31) + '…';
    return v;
}

function PROVIDER_LABEL(id: string): string {
    return PROVIDER_CHOICES.find(p => p.id === id)?.label ?? id;
}

function credentialsSummary(d: DraftConfig): string {
    const parts: string[] = [];
    if (d.geminiKey || envCredentialDetected('gemini')) parts.push('Gemini ✓');
    if (d.anthropicKey) parts.push('Anthropic ✓');
    if (d.openaiKey) parts.push('OpenAI ✓');
    if (d.openrouterKey || envCredentialDetected('openrouter')) parts.push('OpenRouter ✓');
    if (d.provider === 'proxy') parts.push('Proxy');
    return parts.length ? parts.join(', ') : '(none)';
}

function memorySummary(d: DraftConfig): string {
    const bits = ['Local'];
    if (d.obsidianVaultPath) bits.push('Obsidian');
    if (!d.memoryLearning) bits.push('(learning off)');
    return bits.join(' + ');
}

function themeLabel(d: DraftConfig): string {
    return THEME_CYCLE.find(x => x.id === d.appearance.theme)?.label ?? d.appearance.theme;
}

// ═══ HEALTH CHECK ═════════════════════════════════════════

function renderHealth(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push(heading(t, app.healthResults.length === 0 ? 'Initializing Rose' : 'Health Check'));
    lines.push('');

    if (app.healthRunning || (app.healthResults.length === 0 && !app.healthProgressLine)) {
        void ensureScanStarted(app);
    }

    if (app.healthProgressLine && app.healthResults.length === 0) {
        lines.push(t.palette.accent('⠿ ' + app.healthProgressLine));
        lines.push('');
        lines.push(progressBar(t, 0.5, Math.min(30, w - 16)));
        return { lines, rowHits: hits };
    }

    if (app.healthResults.length === 0) {
        lines.push(t.palette.dim('Press R to run checks.'));
        return { lines, rowHits: hits };
    }

    const total = app.healthResults.length;
    const passed = app.healthResults.filter(r => r.state === 'pass').length;
    app.healthResults.forEach(r => {
        const state: HealthState = r.state === 'skip' ? 'idle' : r.state;
        lines.push('  ' + statusRow(t, r.label, state, truncateStr(r.detail, Math.max(12, w - 34)), 20));
        if (r.state === 'fail' && r.fixHint) lines.push('      ' + t.palette.dim(r.fixHint));
    });
    lines.push('');
    lines.push(t.palette.title(`${passed} / ${total}`));

    const verdict = summarize(app.healthResults);
    lines.push('');
    if (verdict.ready && verdict.degraded) {
        lines.push(t.palette.warn(`${t.icons.warn} Rose is ready with warnings.`));
    } else if (verdict.ready) {
        lines.push(t.palette.ok(`${t.icons.check} READY`));
    } else {
        lines.push(t.palette.error(`${t.icons.cross} Required components failed — continue anyway is disabled.`));
        lines.push(t.palette.dim('Fix the failed items above, then press R to re-check.'));
        return { lines, rowHits: hits };
    }

    lines.push('');
    lines.push('  ' + t.palette.accentBold(`${t.icons.selected} Press Enter to finish`));
    hits.set(lines.length - 1, () => { /* Enter handles this */ });

    return { lines, rowHits: hits };
}

const scanFlags = new WeakMap<SetupApp, boolean>();

async function ensureScanStarted(app: SetupApp): Promise<void> {
    if (scanFlags.get(app)) return;
    scanFlags.set(app, true);
    await app.runHealthScan();
    scanFlags.set(app, false);
}

function truncateStr(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}

// ═══ COMPLETE ═════════════════════════════════════════════

function renderComplete(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const lines: string[] = [];
    const logoText = t.icons.logo === 'ROSE' ? 'R O S E' : t.icons.logo + '  R O S E';

    lines.push('');
    lines.push(centerStr(t.palette.accentBold(logoText), w));
    lines.push(centerStr(t.palette.title('YOUR AGENT IS READY'), w));
    lines.push('');

    const byId = new Map(app.healthResults.map(r => [r.id, r]));
    const rowFor = (label: string, id: string, fallbackDetail: string) => {
        const r = byId.get(id);
        const state: HealthState = !r ? 'idle' : r.state === 'fail' ? 'fail' : r.state === 'warn' ? 'warn' : 'pass';
        const detail = r ? r.detail : fallbackDetail;
        return '  ' + statusRow(t, padEndStr(label, 16), state, truncateStr(detail, Math.max(10, w - 42)), 0);
    };

    const providerOk = byId.get('provider-probe');
    lines.push(rowFor('Runtime', 'providers', 'configured'));
    lines.push(rowFor(providerOk ? providerOk!.label + ' Live' : 'Provider Live', 'provider-probe', providerOk?.detail ?? 'not probed'));
    lines.push(rowFor('Memory', 'memory', 'ready'));
    lines.push(rowFor('Tools', 'tools', 'available'));
    lines.push(rowFor('Security', 'security', 'protected'));
    lines.push(rowFor('Event Store', 'eventstore', 'recording'));
    lines.push(rowFor('Web Control', 'web', app.draft.webEnabled ? `${app.draft.webHost}:${app.draft.webPort}` : 'disabled'));
    lines.push('');
    lines.push(centerStr(t.palette.dim('Start:            rose'), w));
    lines.push(centerStr(t.palette.dim('Control Panel:    rose web'), w));
    lines.push(centerStr(t.palette.dim('Reconfigure:      rose setup'), w));
    lines.push('');
    lines.push(centerStr(t.palette.accentBold('Press Enter to launch Rose · Esc to exit'), w));

    return frag(lines);
}

function centerStr(s: string, w: number): string {
    const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
    const left = Math.max(0, Math.floor((w - plain.length) / 2));
    return ' '.repeat(left) + s;
}

// ═══ DASHBOARD (manager mode) ═════════════════════════════

function renderDashboard(app: SetupApp, w: number): Fragment {
    const t = app.theme;
    const d = app.draft;
    const lines: string[] = [];
    const hits = new Map<number, () => void>();

    lines.push('');
    const items: SelectItem[] = MANAGER_SECTIONS.map(s => ({
        label: padEndStr(s.nav, 16),
        badge: dashboardBadge(app, s.id),
        value: s.id,
    }));
    items.push({
        label: app.dirty ? t.palette.accentBold('Save & Exit') : 'Exit',
        badge: '',
        value: 'exit'
    });
    const list = selectList(t, items, Math.min(app.dashboardIdx, items.length - 1), (v) => {
        if (v === 'exit') {
            app.confirmExit();
            return;
        }
        const idx = MANAGER_SECTIONS.findIndex(s => s.id === v);
        app.dashboardIdx = idx;
        app.openSection = MANAGER_SECTIONS[idx].id;
    });
    list.rowHits?.forEach((cb, rel) => hits.set(lines.length + rel, cb));
    uiState.set(app, 'focusRow', lines.length + Math.min(app.dashboardIdx, items.length - 1));
    lines.push(...list.lines);
    lines.push('');

    lines.push(kvRow(t, 'Status', app.dirty ? 'Unsaved changes' : 'All saved', 9));
    lines.push(kvRow(t, 'Provider', `${PROVIDER_LABEL(d.provider)} (${maskSecret(providerMaskSource(d))})`, 9));
    lines.push(kvRow(t, 'Model', d.model, 9));
    lines.push('');
    lines.push(t.palette.dim('Enter opens the selected section · Esc exits · Ctrl+K palette'));

    return { lines, rowHits: hits };
}

function providerMaskSource(d: DraftConfig): string | undefined {
    if (d.provider === 'gemini') return d.geminiKey;
    if (d.provider === 'anthropic') return d.anthropicKey;
    if (d.provider === 'openai') return d.openaiKey;
    if (d.provider === 'openrouter') return d.openrouterKey;
    return undefined;
}

function dashboardBadge(app: SetupApp, id: StepId): string {
    switch (id) {
        case 'provider':
            return (app.draft.provider !== 'gemini' || Boolean(app.draft.geminiKey) || envCredentialDetected('gemini'))
                ? '✓ configured' : '! needs key';
        case 'web': return app.draft.webEnabled ? `on ${app.draft.webHost}:${app.draft.webPort}` : 'off';
        case 'security': return app.draft.autonomy;
        default: return '✓';
    }
}

// ═══ KEY HANDLING ═════════════════════════════════════════

export function createStepKeyHandler(app: SetupApp): (key: KeyMsg) => StepNav {
    return (key: KeyMsg): StepNav => {
        switch (app.viewId) {
            case 'welcome': return handleWelcome(app, key);
            case 'provider': return handleProvider(app, key);
            case 'workspace': return handleWorkspace(app, key);
            case 'memory': return handleMemory(app, key);
            case 'voice': return handleVoice(app, key);
            case 'security': return handleSecurity(app, key);
            case 'appearance': return handleAppearance(app, key);
            case 'web': return handleWeb(app, key);
            case 'review': return handleReview(app, key);
            case 'health': return handleHealth(app, key);
            case 'complete': return handleComplete(app, key);
            case 'dashboard': return handleDashboard(app, key);
            default: return 'continue';
        }
    };
}

function handleWelcome(app: SetupApp, key: KeyMsg): StepNav {
    if (key.type === 'enter' || key.type === 'space') return app.stepForward();
    return 'continue';
}

function handleProvider(app: SetupApp, key: KeyMsg): StepNav {
    let rows = app.providerRows;
    if (rows.length === 0) {
        // Key arrived before first paint — rebuild the row model (pure fn).
        try { renderProvider(app, Math.max(46, app.screen.width)); } catch { /* ignore */ }
        rows = app.providerRows;
        if (rows.length === 0) return 'continue';
    }

    let cur = Math.max(0, Math.min(rows.length - 1, app.prCursor));

    switch (key.type) {
        case 'up':
        case 'shifttab':
            cur--; break;
        case 'down':
        case 'tab':
            cur++; break;
        case 'enter':
        case 'space': {
            app.prCursor = cur;
            const r = rows[cur];
            if (!r) return 'continue';
            if (r.kind === 'provider' && r.id) selectProvider(app, r.id as DraftConfig['provider']);
            else if (r.kind === 'model' && r.value) { app.draft.model = r.value; app.markDirty(); }
            else if (r.kind === 'action' && r.btn !== undefined) activateProviderAction(app, r.btn as 0 | 1);
            else {
                // Text rows: Enter advances toward the actions instead of
                // doing nothing (bugfix: "Continue kaam nahi kar raha" feel).
                app.prCursor = Math.min(rows.length - 1, cur + 1);
            }
            return 'continue';
        }
        case 'char': {
            app.prCursor = cur;
            applyProviderEdit(app, rows[cur], key.text);
            return 'continue';
        }
        case 'backspace': {
            app.prCursor = cur;
            applyProviderEdit(app, rows[cur], null);
            return 'continue';
        }
        default:
            return 'continue';
    }
    app.prCursor = Math.max(0, Math.min(rows.length - 1, cur));
    return 'continue';
}


/** Route typed characters to the focused text row (credential or manual model id). */
function applyProviderEdit(app: SetupApp, row: { kind: string; field?: string } | undefined, ch: string | null): void {
    if (!row) return;
    let field: string | null = null;
    if (row.kind === 'cred' && row.field) field = row.field;
    else if (row.kind === 'modelText') field = 'model';
    if (!field) return;

    const d = app.draft as any;
    if (ch === null) d[field] = String(d[field] ?? '').slice(0, -1);
    else d[field] = String(d[field] ?? '') + ch;
    app.markDirty();
    app.errors.delete(field as any);
}

function handleWorkspace(app: SetupApp, key: KeyMsg): StepNav {
    switch (key.type) {
        case 'up': app.workspaceOptionIdx = (app.workspaceOptionIdx + 2) % 3; return 'continue';
        case 'down': app.workspaceOptionIdx = (app.workspaceOptionIdx + 1) % 3; return 'continue';
        case 'enter': {
            if (app.workspaceOptionIdx === 0) {
                activateWorkspaceOption(app, 0);
                return 'continue';
            }
            const raw = st<string>(app, 'ws.path', '').trim();
            if (!raw) return 'continue';
            const abs = resolveWorkspacePath(raw);
            if (app.workspaceOptionIdx === 2) {
                try {
                    fs.mkdirSync(abs, { recursive: true });
                } catch (e: any) {
                    app.toast(`Could not create ${abs}: ${e.message}`);
                    return 'continue';
                }
            } else if (!safeIsDir(abs)) {
                app.toast(`Directory not found: ${abs}`);
                return 'continue';
            }
            app.draft.workspacePath = abs;
            app.markDirty();
            return app.stepForward();
        }
        case 'char': {
            if (app.workspaceOptionIdx > 0) {
                const cur = st<string>(app, 'ws.path', '');
                stSet(app, 'ws.path', cur + key.text);
            }
            return 'continue';
        }
        case 'backspace': {
            if (app.workspaceOptionIdx > 0) {
                const cur = st<string>(app, 'ws.path', '');
                stSet(app, 'ws.path', cur.slice(0, -1));
            }
            return 'continue';
        }
        default: return 'continue';
    }
}

function handleMemory(app: SetupApp, key: KeyMsg): StepNav {
    const d = app.draft;
    switch (key.type) {
        case 'down': stSet(app, 'mem.focus', (st<number>(app, 'mem.focus', 0) + 1) % 4); return 'continue';
        case 'up': stSet(app, 'mem.focus', (st<number>(app, 'mem.focus', 0) + 3) % 4); return 'continue';
        case 'space': case 'enter': {
            const f = st<number>(app, 'mem.focus', 0);
            if (f === 0) { d.memoryLearning = !d.memoryLearning; app.markDirty(); }
            else if (f === 3) {
                // Apply section: validate + persist through service
                const obsidian = d.obsidianVaultPath.trim();
                if (obsidian) {
                    const abs = resolveWorkspacePath(obsidian);
                    if (!safeIsDir(abs)) {
                        app.obsidianTest = {
                            id: 'obsidian', label: 'Obsidian', state: 'fail',
                            detail: `Folder not found: ${abs}`,
                            fixHint: 'Create the folder first or correct the path.',
                        };
                        return 'continue';
                    }
                    try {
                        fs.accessSync(abs, fs.constants.W_OK);
                        app.obsidianTest = { id: 'obsidian', label: 'Obsidian', state: 'pass', detail: `Writable: ${abs}` };
                    } catch {
                        app.obsidianTest = { id: 'obsidian', label: 'Obsidian', state: 'fail', detail: `Not writable: ${abs}` };
                        return 'continue';
                    }
                } else {
                    app.obsidianTest = null;
                }
                const ret = Number(d.maxEntriesPerType);
                if (!Number.isInteger(ret) || ret < 10 || ret > 100000) {
                    app.toast('Retention must be between 10 and 100000.');
                    return 'continue';
                }
                void app.applyAndThen(() => { /* stay on section */ });
            }
            return 'continue';
        }
        case 'char': {
            const f = st<number>(app, 'mem.focus', 0);
            if (f === 1) { d.maxEntriesPerType = clampNumStr(String(d.maxEntriesPerType) + key.text); app.markDirty(); }
            else if (f === 2) { d.obsidianVaultPath += key.text; app.markDirty(); }
            return 'continue';
        }
        case 'backspace': {
            const f = st<number>(app, 'mem.focus', 0);
            if (f === 1) { d.maxEntriesPerType = clampNumStr(String(d.maxEntriesPerType).slice(0, -1)); app.markDirty(); }
            else if (f === 2) { d.obsidianVaultPath = d.obsidianVaultPath.slice(0, -1); app.markDirty(); }
            return 'continue';
        }
        default: return 'continue';
    }
}

function clampNumStr(s: string): number {
    const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 500;
}

function handleSecurity(app: SetupApp, key: KeyMsg): StepNav {
    const d = app.draft;
    const totalRows = FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length + 2; // +1 for federation, +1 for continue button
    switch (key.type) {
        case 'up': app.securityIdx = (app.securityIdx + totalRows - 1) % totalRows; return 'continue';
        case 'down': app.securityIdx = (app.securityIdx + 1) % totalRows; return 'continue';
        case 'enter': case 'space': {
            if (app.securityIdx < FULL_ACCESS_OPTIONS.length) {
                d.fullAccess = FULL_ACCESS_OPTIONS[app.securityIdx].value;
                app.markDirty();
            } else if (app.securityIdx < FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length) {
                const autoIdx = app.securityIdx - FULL_ACCESS_OPTIONS.length;
                d.autonomy = AUTONOMY_OPTIONS[autoIdx].id;
                app.markDirty();
            } else if (app.securityIdx === FULL_ACCESS_OPTIONS.length + AUTONOMY_OPTIONS.length) {
                d.allowFederation = !d.allowFederation;
                app.markDirty();
            } else {
                if (app.mode === 'manager') {
                    app.openSection = null;
                } else {
                    app.stepForward();
                }
            }
            return 'continue';
        }
        default: return 'continue';
    }
}

function handleAppearance(app: SetupApp, key: KeyMsg): StepNav {
    const rows = appearanceRows(app);
    switch (key.type) {
        case 'up': app.appearanceSectionIdx = (app.appearanceSectionIdx - 1 + rows.length) % rows.length; return 'continue';
        case 'down': app.appearanceSectionIdx = (app.appearanceSectionIdx + 1) % rows.length; return 'continue';
        case 'left': rows[app.appearanceSectionIdx]?.adjust(-1); return 'continue';
        case 'right': rows[app.appearanceSectionIdx]?.adjust(1); return 'continue';
        case 'space': case 'enter': rows[app.appearanceSectionIdx]?.adjust(1); return 'continue';
        case 'char': {
            if (app.customAccentFocused || app.draft.appearance.accent === 'custom') {
                app.customAccentInput.value += key.text;
                app.customAccentInput.cursorPos = app.customAccentInput.value.length;
            }
            return 'continue';
        }
        case 'backspace': {
            app.customAccentInput.value = app.customAccentInput.value.slice(0, -1);
            app.customAccentInput.cursorPos = app.customAccentInput.value.length;
            return 'continue';
        }
        default: return 'continue';
    }
}

function handleWeb(app: SetupApp, key: KeyMsg): StepNav {
    const d = app.draft;
    switch (key.type) {
        case 'up': app.webEnableIdx = (app.webEnableIdx + 1) % 2; return 'continue';
        case 'down': app.webEnableIdx = (app.webEnableIdx + 1) % 2; return 'continue';
        case 'char': {
            // Editing port digits when focus below toggles
            if (/^[0-9]$/.test(key.text)) {
                if (app.webPortInput.cursorPos >= 5 && app.webPortInput.value.length >= 5) return 'continue';
                app.webPortInput.value = app.webPortInput.value.slice(0, app.webPortInput.cursorPos) + key.text + app.webPortInput.value.slice(app.webPortInput.cursorPos);
                app.webPortInput.cursorPos++;
                applyWebPortDraft(app);
            } else if (/[a-zA-Z0-9.:]/.test(key.text)) {
                d.webHost += key.text.toLowerCase();
                app.markDirty();
                schedulePortCheck(app);
            }
            return 'continue';
        }
        case 'backspace': {
            if (app.webPortInput.cursorPos > 0) {
                app.webPortInput.value = app.webPortInput.value.slice(0, app.webPortInput.cursorPos - 1) + app.webPortInput.value.slice(app.webPortInput.cursorPos);
                app.webPortInput.cursorPos--;
                applyWebPortDraft(app);
            } else if (d.webHost.length > 0) {
                d.webHost = d.webHost.slice(0, -1);
                app.markDirty();
                schedulePortCheck(app);
            }
            return 'continue';
        }
        case 'left': {
            if (app.webPortInput.cursorPos > 0) { app.webPortInput.cursorPos--; }
            return 'continue';
        }
        case 'right': {
            if (app.webPortInput.cursorPos < app.webPortInput.value.length) { app.webPortInput.cursorPos++; }
            return 'continue';
        }
        case 'enter': case 'space': {
            if (st<number>(app, 'web.focus', 0) === 0) {
                d.webEnabled = app.webEnableIdx === 0;
                app.markDirty();
                schedulePortCheck(app);
            }
            return 'continue';
        }
        default:
            if (key.type === 'ctrl' && key.name === 'r') { /* reserved */ }
            return 'continue';
    }
}

function applyWebPortDraft(app: SetupApp): void {
    const n = parseInt(app.webPortInput.value, 10);
    if (Number.isFinite(n)) {
        app.draft.webPort = n;
        app.markDirty();
        app.errors.delete('webPort');
        schedulePortCheck(app);
    }
}

function handleReview(app: SetupApp, key: KeyMsg): StepNav {
    switch (key.type) {
        case 'up': app.reviewOptionIdx = (app.reviewOptionIdx + 1) % 2; return 'continue';
        case 'down': app.reviewOptionIdx = (app.reviewOptionIdx + 1) % 2; return 'continue';
        case 'enter': case 'space': activateReviewOption(app, app.reviewOptionIdx); return 'continue';
        default: return 'continue';
    }
}

function handleHealth(app: SetupApp, key: KeyMsg): StepNav {
    switch (key.type) {
        case 'char':
            if (key.text.toLowerCase() === 'r') {
                app.healthResults = [];
                void ensureScanStarted(app);
            }
            return 'continue';
        case 'enter': {
            const verdict = summarize(app.healthResults);
            if (app.healthResults.length === 0) { void ensureScanStarted(app); return 'continue'; }
            if (!verdict.ready) return 'continue'; // block completion when unsafe (spec 42)
            return app.stepForward();
        }
        default: return 'continue';
    }
}

function handleComplete(app: SetupApp, key: KeyMsg): StepNav {
    app.setupJustCompleted = true;
    if (key.type === 'enter') return 'launch';
    if (key.type === 'esc') return 'done';
    return 'continue';
}

function handleDashboard(app: SetupApp, key: KeyMsg): StepNav {
    const total = MANAGER_SECTIONS.length + 1;
    switch (key.type) {
        case 'up': app.dashboardIdx = (app.dashboardIdx - 1 + total) % total; return 'continue';
        case 'down': app.dashboardIdx = (app.dashboardIdx + 1) % total; return 'continue';
        case 'enter': {
            if (app.dashboardIdx === MANAGER_SECTIONS.length) {
                app.confirmExit();
            } else {
                app.openSection = MANAGER_SECTIONS[app.dashboardIdx]?.id ?? null;
            }
            return 'continue';
        }
        case 'esc': app.confirmExit(); return 'continue';
        default: return 'continue';
    }
}
