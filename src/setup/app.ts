/**
 * Phase 33 — Rose Setup TUI application shell (full-screen, alternate buffer).
 *
 * Owns the frame loop, keyboard/mouse dispatch, modal stack and command
 * palette. Step screens live in steps.ts as pure state machines rendered
 * through this shell, so TUI, plain mode and the CLI share one configuration
 * service and there is never a second source of truth (spec 79, 119).
 */
import { Screen, KeyMsg } from '../tui/screen.js';
import { Theme, AppearanceConfig, DEFAULT_APPEARANCE } from '../tui/theme.js';
import { Fragment, panel, Spinner, statusRow, kvRow } from '../tui/widgets.js';
import { Config } from '../config.js';
import {
    DraftConfig, loadDraft, applyDraft, validateAll, FieldKey,
    diffAgainstCurrent, ConfigChange, maskSecret,
} from './configService.js';
import { CheckResult } from './health.js';
import { renderStepContent, createStepKeyHandler, StepNav } from './steps.js';
import { uiState } from './steps.js';
import { runHealthChecks, summarize as summarizeChecks } from './health.js';

export type StepId =
    | 'welcome' | 'provider' | 'workspace' | 'memory' | 'voice' | 'security'
    | 'appearance' | 'web' | 'review' | 'health' | 'complete';

interface StepDef { id: StepId; nav: string; }

export const WIZARD_STEPS: StepDef[] = [
    { id: 'welcome', nav: 'Welcome' },
    { id: 'provider', nav: 'AI Provider' },
    { id: 'workspace', nav: 'Workspace' },
    { id: 'memory', nav: 'Memory' },
    { id: 'voice', nav: 'Voice' },
    { id: 'security', nav: 'Security' },
    { id: 'appearance', nav: 'Appearance' },
    { id: 'web', nav: 'Web Control' },
    { id: 'review', nav: 'Review' },
    { id: 'health', nav: 'Health Check' },
    { id: 'complete', nav: 'Finish' },
];

export const MANAGER_SECTIONS: StepDef[] = [
    { id: 'provider', nav: 'AI Provider' },
    { id: 'workspace', nav: 'Workspace' },
    { id: 'memory', nav: 'Memory' },
    { id: 'voice', nav: 'Voice' },
    { id: 'security', nav: 'Security' },
    { id: 'appearance', nav: 'Appearance' },
    { id: 'web', nav: 'Web Control' },
];

export const STEP_NAV_LABELS: Record<StepId, string> = Object.fromEntries(
    [...WIZARD_STEPS].map(s => [s.id, s.nav])
) as Record<StepId, string>;

type Modal =
    | { kind: 'confirm'; title: string; messageLines: string[]; buttons: string[]; activeBtn: number; onPick: (idx: number) => void }
    | { kind: 'toast'; lines: string[]; expiresAt: number };

export interface SetupAppOptions {
    mode: 'wizard' | 'manager';
    debug?: boolean;
}

/** What the CLI should do after the TUI exits. */
export interface SetupOutcome {
    completed: boolean;
    launchRose: boolean;
}

const TOAST_MS = 2200;

/**
 * Shared UI state for every step renderer. Steps read/write this object;
 * they never touch the terminal themselves.
 */
export class SetupApp {
    screen = new Screen();
    theme: Theme;
    draft: DraftConfig;
    errors: Map<FieldKey, string> = new Map();
    dirty = false;
    debugMode = false;
    readonly mode: 'wizard' | 'manager';

    private steps: StepDef[];
    private currentIdx = 0;
    /** In manager mode: which section editor is open (null = dashboard). */
    public openSection: StepId | null = null;
    private modals: Modal[] = [];
    private spinner: Spinner;
    private paletteOpen = false;
    private paletteIdx = 0;

    // Per-step interactive state (owned by steps.ts conventions)
    providerListIdx = 0;
    modelListIdx = 0;
    workspaceOptionIdx = 0;
    pathInput = { value: '', cursorPos: 0 };
    securityIdx = 0;
    appearanceSectionIdx = 0;
    accentListIdx = 0;
    customAccentInput = { value: '', cursorPos: 0 };
    customAccentFocused = false;
    webEnableIdx = 0;
    webPortInput = { value: '', cursorPos: 0 };
    webPortStatus: 'unknown' | 'checking' | 'free' | 'busy' = 'unknown';
    webPortMessage = '';
    reviewOptionIdx = 0;
    healthResults: CheckResult[] = [];
    healthRunning = false;
    healthProgressLine = '';
    testRunning = false;
    testResult: CheckResult | null = null;
    obsidianTest: CheckResult | null = null;
    memoryStats = '';
    projectInfo = '';
    dashboardIdx = 0;

    /** Flat navigation model for the AI Provider screen (bugfix: stored on
     * the app instance so state survives regardless of module loading). */
    providerRows: Array<{ kind: 'provider' | 'cred' | 'model' | 'modelText' | 'action'; id?: string; value?: string; field?: string; btn?: number }> = [];
    prCursor = 0;
    prCursorInit = false;
    lastDiff: ConfigChange[] = [];
    lastApplyError: string | null = null;

    // Frame-level click registry, rebuilt every render
    private rowHits = new Map<number, () => void>();

    constructor(opts: SetupAppOptions) {
        this.mode = opts.mode;
        this.debugMode = Boolean(opts.debug);
        this.draft = loadDraft();
        // The live preview reflects the DRAFT, so the theme builds from it.
        this.theme = new Theme(this.draft.appearance);
        this.errors = validateAll(this.draft);
        this.spinner = new Spinner(this.theme);
        this.steps = opts.mode === 'wizard' ? WIZARD_STEPS : MANAGER_SECTIONS;
        this.webPortInput.value = String(this.draft.webPort);
    }

    refreshTheme(): void {
        // Rebuild from draft so unsaved appearance edits preview immediately (spec 32).
        this.theme = new Theme(this.draft.appearance);
        const label = this.spinner.label;
        this.spinner.stop();
        this.spinner = new Spinner(this.theme);
        if (label) this.startSpinner(label);
    }

    get currentStep(): StepId {
        return this.steps[this.currentIdx].id;
    }

    get viewId(): StepId | 'dashboard' {
        return this.mode === 'manager' ? (this.openSection ?? 'dashboard') : this.currentStep;
    }

    get stepPosition(): { index: number; total: number } {
        return { index: Math.min(this.currentIdx + 1, this.steps.length), total: this.steps.length };
    }

    // ─── Run loop ───────────────────────────────────────────

    async run(): Promise<SetupOutcome> {
        if (!Screen.supportsInteractive()) throw new Error('NON_INTERACTIVE');

        this.screen.enter();
        this.drawFrame();

        try {
            while (true) {
                let key: KeyMsg | null;
                if (this.spinner.label && this.theme.spinnerIntervalMs !== null) {
                    key = await Promise.race([
                        this.screen.readKey(),
                        sleep(this.theme.spinnerIntervalMs ?? 100).then(() => null),
                    ]);
                } else {
                    key = await this.screen.readKey();
                }

                if (key === null) {
                    this.drawFrame(); // animation tick
                    continue;
                }

                if (key.type === 'mouse') {
                    this.handleMouse(key.x, key.y, key.action);
                    this.drawFrame();
                    continue;
                }

                const nav = this.dispatch(key);
                this.drawFrame();

                if (this.requestExit || nav === 'exit') return { completed: this.setupJustCompleted, launchRose: false };
                if (nav === 'done') return { completed: true, launchRose: false };
                if (nav === 'launch') return { completed: true, launchRose: true };

                // Toast expiry sweep
                const now = Date.now();
                this.modals = this.modals.filter(m => m.kind === 'confirm' || m.expiresAt > now);
            }
        } finally {
            this.spinner.stop();
            this.screen.exit(); // guaranteed terminal restore (spec 8, 56)
        }
    }

    // ─── Dispatch ───────────────────────────────────────────

    private dispatch(key: KeyMsg): StepNav {
        if (this.modals.some(m => m.kind === 'confirm')) return this.dispatchModal(key);
        if (this.paletteOpen) return this.dispatchPalette(key);

        switch (key.type) {
            case 'ctrl':
                if (key.name === 'c') { this.confirmExit(); return 'continue'; }
                if (key.name === 'k') { this.openPalette(); return 'continue'; }
                if (key.name === 'r') {
                    this.draft = loadDraft();
                    this.dirty = false;
                    this.errors = validateAll(this.draft);
                    this.toast('Draft reset to saved configuration.');
                    return 'continue';
                }
                if (key.name === 'l') return 'continue'; // next tick redraws
                return 'continue';
            case 'esc':
                if (this.viewId === 'dashboard') { this.confirmExit(); return 'continue'; }
                if (this.mode === 'manager') { this.openSection = null; return 'continue'; }
                return this.stepBack();
            case 'tab': {
                if (this.mode === 'wizard' && this.currentStep !== 'complete') return this.stepForward();
                return 'continue';
            }
            default:
                return createStepKeyHandler(this)(key);
        }
    }

    private dispatchModal(key: KeyMsg): StepNav {
        const idx = this.modals.findIndex(m => m.kind === 'confirm');
        const modal = this.modals[idx] as Extract<Modal, { kind: 'confirm' }>;
        switch (key.type) {
            case 'left': modal.activeBtn = Math.max(0, modal.activeBtn - 1); return 'continue';
            case 'right': modal.activeBtn = Math.min(modal.buttons.length - 1, modal.activeBtn + 1); return 'continue';
            case 'shifttab': modal.activeBtn = (modal.activeBtn - 1 + modal.buttons.length) % modal.buttons.length; return 'continue';
            case 'tab': modal.activeBtn = (modal.activeBtn + 1) % modal.buttons.length; return 'continue';
            case 'enter': case 'space': {
                this.modals.splice(idx, 1);
                modal.onPick(modal.activeBtn);
                return 'continue';
            }
            case 'esc':
                this.modals.splice(idx, 1);
                return 'continue';
            case 'char':
                if (key.text.toLowerCase() === 'y') { this.modals.splice(idx, 1); modal.onPick(0); return 'continue'; }
                if (key.text.toLowerCase() === 'n') { this.modals.splice(idx, 1); return 'continue'; }
                return 'continue';
            case 'ctrl':
                if (key.name === 'c') { this.modals.splice(idx, 1); return 'exit'; }
                return 'continue';
            default: return 'continue';
        }
    }

    private dispatchPalette(key: KeyMsg): StepNav {
        const items = this.paletteItems();
        switch (key.type) {
            case 'up': this.paletteIdx = Math.max(0, this.paletteIdx - 1); return 'continue';
            case 'down': this.paletteIdx = Math.min(items.length - 1, this.paletteIdx + 1); return 'continue';
            case 'enter': case 'tab': {
                const item = items[this.paletteIdx];
                this.paletteOpen = false;
                item.run();
                return 'continue';
            }
            case 'esc': this.paletteOpen = false; return 'continue';
            case 'ctrl': if (key.name === 'k') this.paletteOpen = false; return 'continue';
            default: return 'continue';
        }
    }

    // ─── Navigation API used by steps ───────────────────────

    stepForward(): StepNav {
        if (this.currentIdx < this.steps.length - 1) this.currentIdx++;
        return 'continue';
    }

    stepBack(): StepNav {
        if (this.currentIdx > 0) this.currentIdx--;
        else this.confirmExit();
        return 'continue';
    }

    goTo(id: StepId): void {
        const idx = this.steps.findIndex(s => s.id === id);
        if (idx >= 0) this.currentIdx = idx;
    }

    markDirty(): void { this.dirty = true; }

    toast(lines: string | string[]): void {
        this.modals.push({
            kind: 'toast',
            lines: Array.isArray(lines) ? lines : [lines],
            expiresAt: Date.now() + TOAST_MS,
        });
    }

    confirm(title: string, messageLines: string[], buttons: string[], onPick: (idx: number) => void): void {
        this.modals.push({ kind: 'confirm', title, messageLines, buttons, activeBtn: 0, onPick });
    }

    confirmExit(): void {
        if (!this.dirty) { this.requestExit = true; return; }
        this.confirm('Unsaved changes', [
            'You have unsaved configuration changes.',
            '',
            'Save changes before exiting?',
        ], ['Save & Exit', 'Discard', 'Cancel'], (btn) => {
            if (btn === 2) return;               // Cancel -> stay
            if (btn === 1) { this.requestExit = true; return; } // Discard
            void this.applyAndThen(() => { this.requestExit = true; });
        });
    }

    requestExit = false;
    /** Set by the Complete screen when the user chooses to launch Rose. */
    setupJustCompleted = false;

    /** Test hook: is a confirmation modal currently on the stack? */
    hasConfirmModalForTest(): boolean {
        return this.modals.some(m => m.kind === 'confirm');
    }

    openPalette(): void { this.paletteOpen = true; this.paletteIdx = 0; }

    private paletteItems(): Array<{ label: string; run: () => void }> {
        const jumpTo = this.mode === 'wizard'
            ? WIZARD_STEPS.map(s => ({ label: `Go to ${s.nav}`, run: () => this.goTo(s.id) }))
            : MANAGER_SECTIONS.map(s => ({ label: `Go to ${s.nav}`, run: () => { this.openSection = s.id; } }));
        return [
            ...jumpTo,
            { label: 'Run Health Check', run: () => { void this.runHealthScan().then(() => { if (this.mode === 'wizard') this.goTo('health'); }); } },
            { label: this.dirty ? 'Save changes' : 'Save (no changes)', run: () => { if (this.dirty) void this.applyAndThen(() => this.toast('Configuration saved.')); else this.toast('No unsaved changes.'); } },
            { label: 'Reset draft to saved config', run: () => { this.draft = loadDraft(); this.dirty = false; this.toast('Draft reset.'); } },
            { label: 'Exit setup', run: () => this.confirmExit() },
        ];
    }

    // ─── Save / apply / health ──────────────────────────────

    async applyAndThen(after?: () => void): Promise<StepNav> {
        this.errors = validateAll(this.draft);
        if (this.errors.size > 0) {
            const summary = [...this.errors.values()].slice(0, 2);
            this.toast(['Cannot save — fix validation errors:', ...summary]);
            return 'continue';
        }
        this.startSpinner('Applying configuration...');
        const result = await applyDraft(this.draft);
        this.stopSpinner();

        if (result.ok) {
            this.dirty = false;
            this.lastDiff = [];
            this.lastApplyError = null;
            this.refreshTheme();
            this.toast([
                'Configuration applied.',
                result.backupPath ? `Backup kept: ${shortenHome(result.backupPath)}` : '',
            ].filter(Boolean));
            this.drawFrame(); // paint result without waiting for a keypress
            after?.();
        } else {
            this.lastApplyError = result.error || 'Unknown failure.';
            this.confirm('Apply failed', [
                result.error || 'The configuration could not be written.',
                '',
                result.rolledBack ? 'Your previous configuration was restored.' : 'Configuration was not changed.',
            ], ['OK'], () => {});
        }
        return 'continue';
    }

    async runHealthScan(): Promise<void> {
        if (this.healthRunning) return;
        this.healthRunning = true;
        this.healthResults = [];
        this.healthProgressLine = 'Initializing checks...';
        try {
            this.healthResults = await runHealthChecks({
                probeProvider: true,
                checkWebPort: this.draft.webEnabled,
                onProgress: (label: string) => { this.healthProgressLine = label; this.drawFrame(); },
            });
            this.healthProgressLine = '';
        } finally {
            this.healthRunning = false;
            this.drawFrame(); // final results visible without a keypress
        }
    }

    startSpinner(label: string): void {
        const interval = this.theme.spinnerIntervalMs;
        this.spinner.start(label, interval ?? null);
    }

    stopSpinner(): void { this.spinner.stop(); }

    // ─── Rendering ──────────────────────────────────────────

    /**
     * Fit step content into `availRows` with scroll anchoring so the focused
     * control is always visible on small terminals.
     */
    private fitContent(view: StepId | 'dashboard', f: Fragment, availRows: number): Fragment {
        const key = 'scroll.' + view;
        let sc = uiState.get<number>(this, key, 0);
        const total = f.lines.length;

        // Reset scroll when switching views.
        if (uiState.get<string>(this, 'scroll.view', '') !== view) {
            sc = 0;
            uiState.set(this, 'scroll.view', view);
        }

        const anchor = uiState.get<number>(this, 'focusRow', -1);
        if (anchor >= 0) {
            if (anchor < sc) sc = anchor;
            if (anchor >= sc + availRows) sc = anchor - availRows + 1;
        }
        const maxScroll = Math.max(0, total - availRows);
        if (sc > maxScroll) sc = maxScroll;
        if (sc < 0) sc = 0;
        uiState.set(this, key, sc);

        const lines = f.lines.slice(sc, sc + availRows);
        const rowHits = new Map<number, () => void>();
        f.rowHits?.forEach((cb, rel) => {
            const v = rel - sc;
            if (v >= 0 && v < lines.length && !rowHits.has(v)) rowHits.set(v, cb);
        });
        return { lines, rowHits };
    }

    /** Compose (but do not paint) the current frame. Exposed for tests. */
    composeFrame(w: number, h: number): string[] {
        const t = this.theme;
        this.rowHits = new Map();

        if (w < 46 || h < 16) {
            return tooSmallFrame(t, w, h);
        }

        const header = this.buildHeader(w);
        const footer = this.buildFooter(w);
        const bodyHeight = Math.max(4, h - header.length - footer.length);

        let body: string[];
        const view = this.viewId;

        if (view === 'complete') {
            body = this.renderFullWidth(renderStepContent(this, 'complete', Math.min(w - 8, 92), bodyHeight), w, bodyHeight);
        } else if (!this.optsWide(w)) {
            // Small/medium: single centered panel (spec 88)
            const contentW = Math.min(w - 6, 96);
            const rawFrag = renderStepContent(this, view, contentW, bodyHeight);
            const avail = Math.max(3, bodyHeight - 2 - 2 * t.panelPadding);
            const frag = this.fitContent(view, rawFrag, avail);
            body = this.registerAndPad(frag, header.length, Math.floor((w - contentW) / 2), t);
        } else {
            const sidebarW = this.mode === 'wizard' ? Math.min(24, Math.max(18, Math.floor(w * 0.2))) : 0;
            const previewW = view === 'appearance' ? Math.min(36, Math.floor(w * 0.28)) : 0;
            const contentW = w - sidebarW - (sidebarW ? 3 : 0) - previewW - (previewW ? 2 : 0) - 2;

            const avail = Math.max(3, bodyHeight - 2 - 2 * t.panelPadding);
            const contentFrag = this.fitContent(view, renderStepContent(this, view, contentW, bodyHeight), avail);

            const columns: string[][] = [];
            if (sidebarW > 0) {
                columns.push(panel(t, this.renderSidebarLines(), { width: sidebarW, title: 'GET STARTED' }));
            }

            const contentTopOffset = header.length + 1 + t.panelPadding; // panel border row
            contentFrag.rowHits?.forEach((cb, rel) => {
                if (!this.rowHits.has(contentTopOffset + rel)) this.rowHits.set(contentTopOffset + rel, cb);
            });

            const contentPanel = panel(t, contentFrag.lines, {
                width: contentW,
                paddingY: t.panelPadding,
                title: this.panelTitleFor(view),
            });
            columns.push(contentPanel);

            if (previewW > 0) {
                columns.push(this.renderPreview(previewW));
            }
            body = columnsReduce(columns, 2);
        }

        let frame = [...header, ...body.slice(0, bodyHeight)];
        while (frame.length < h - footer.length) frame.push('');
        frame = [...frame, ...footer];

        frame = this.overlayConfirm(t, frame, w, h);
        frame = this.overlayToast(t, frame, w, h);
        if (this.paletteOpen) frame = this.overlayPalette(t, frame, w, h);
        if (this.spinner.label) {
            const spin = ' ' + this.spinner.renderLine();
            frame[h - 1] = spin.slice(0, w);
        }
        return frame;
    }

    drawFrame(): void {
        this.screen.render(this.composeFrame(this.screen.width, this.screen.height));
    }

    private optsWide(w: number): boolean {
        return w >= 78 && !(this.viewId === 'complete');
    }

    private registerAndPad(frag: Fragment, headerLen: number, pad: number, t: Theme): string[] {
        const topOffset = headerLen + 1 + t.panelPadding;
        frag.rowHits?.forEach((cb, rel) => {
            if (!this.rowHits.has(topOffset + rel)) this.rowHits.set(topOffset + rel, cb);
        });
        const width = Math.min(this.screen.width - 6, 96);
        const boxed = panel(t, frag.lines, { width, paddingY: t.panelPadding, title: this.panelTitleFor(this.viewId) });
        const sp = ' '.repeat(Math.max(0, pad));
        return boxed.map(l => sp + l);
    }

    private renderFullWidth(frag: Fragment, w: number, _h: number): string[] {
        const t = this.theme;
        frag.rowHits?.forEach((cb, rel) => {
            const topOffset = 3 + 1; // header(3) + border
            if (!this.rowHits.has(topOffset + rel)) this.rowHits.set(topOffset + rel, cb);
        });
        const boxed = panel(t, frag.lines, { width: Math.min(w - 8, 92), paddingY: t.panelPadding, title: this.panelTitleFor('complete') });
        const pad = Math.max(0, Math.floor((w - Math.min(w - 8, 92)) / 2));
        const sp = ' '.repeat(pad);
        return boxed.map(l => sp + l);
    }

    private panelTitleFor(view: StepId | 'dashboard'): string | undefined {
        if (view === 'dashboard') return 'ROSE SETTINGS';
        return (STEP_NAV_LABELS[view] || '').toUpperCase() || undefined;
    }

    private buildHeader(w: number): string[] {
        const t = this.theme;
        const logoText = t.icons.logo === 'ROSE' ? 'ROSE' : `${t.icons.logo} ROSE`;
        const subtitle = this.mode === 'wizard' ? 'Your AI Agent. Your Rules.' : 'Settings';
        const pos = this.headerRightLabel();

        const leftPart = ` ${t.palette.accentBold(logoText)}  ${t.palette.dim(subtitle)} `;
        const rightPart = ` ${t.palette.dim(pos)} `;
        const gap = Math.max(1, w - visibleLen(leftPart) - visibleLen(rightPart));
        const line = truncateVisible(leftPart + ' '.repeat(gap) + rightPart, w);
        return [line, t.palette.border('─'.repeat(Math.min(w, 200))), ''];
    }

    private headerRightLabel(): string {
        if (this.mode === 'wizard') {
            const { index, total } = this.stepPosition;
            return `SETUP ${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
        }
        if (this.dirty) return 'UNSAVED CHANGES';
        return 'CONFIGURED · Ctrl+K menu';
    }

    private buildFooter(w: number): string[] {
        const t = this.theme;
        const hints = this.currentHints()
            .map(h => `${t.palette.dim(h.key)} ${t.palette.text(h.action)}`)
            .join('   ');
        return [t.palette.border('─'.repeat(Math.min(w, 200))), ' ' + truncateVisible(hints, w - 2)];
    }

    private currentHints(): Array<{ key: string; action: string }> {
        if (this.mode === 'manager' && !this.openSection) {
            return [
                { key: '↑↓', action: 'Navigate' }, { key: 'Enter', action: 'Configure' },
                { key: 'Ctrl+K', action: 'Menu' }, { key: 'Ctrl+S→n/a', action: '' },
                { key: 'Esc/Ctrl+C', action: 'Exit' },
            ].filter(h => h.action);
        }
        const base = [
            { key: '↑↓', action: 'Navigate' }, { key: 'Enter', action: 'Select' }, { key: 'Tab', action: 'Next' },
            { key: 'Esc', action: 'Back' }, { key: 'Ctrl+K', action: 'Menu' }, { key: 'Ctrl+C', action: 'Exit' },
        ];
        if (this.viewId === 'health') base.push({ key: 'R', action: 'Retry' });
        if (this.dirty) base.unshift({ key: '●', action: 'Unsaved changes' });
        return base;
    }

    private renderSidebarLines(): string[] {
        const t = this.theme;
        return this.steps.map((s, i) => {
            const active = i === this.currentIdx;
            const done = i < this.currentIdx && s.id !== 'complete' ? this.sectionDone(s.id) : (s.id === 'health' && this.healthResults.length > 0);
            const icon = active ? t.icons.radioOn : done ? t.palette.ok(t.icons.check) : t.icons.radioOff;
            const painter = active ? ((x: string) => t.palette.accentBold(x)) : ((x: string) => t.palette.text(x));
            return painter(`${icon} ${s.nav}`);
        });
    }

    sectionDone(id: StepId): boolean {
        switch (id) {
            case 'welcome': return this.currentIdx > 0;
            case 'provider':
                return Boolean(this.draft.provider) &&
                    (this.draft.provider !== 'gemini' || Boolean(this.draft.geminiKey) || Boolean(process.env.GEMINI_API_KEY));
            case 'workspace': return Boolean(this.draft.workspacePath);
            case 'memory': return true;
            case 'voice': return Boolean(this.draft.voiceName);
            case 'security': return Boolean(this.draft.autonomy);
            case 'appearance': return true;
            case 'web': return true;
            case 'health': return this.healthResults.length > 0 && summarizeSafe(this.healthResults).ready;
            default: return false;
        }
    }

    private renderPreview(width: number): string[] {
        const t = this.theme;
        const lines = [
            statusRow(t, 'Agent Ready', 'pass', '', 20),
            statusRow(t, 'Task Complete', 'pass', '', 20),
            statusRow(t, 'Approval Required', 'warn', '', 20),
            statusRow(t, 'Connection Lost', 'fail', '', 20),
            '',
            kvRow(t, 'Theme', this.draft.appearance.theme, 10),
            kvRow(t, 'Accent', accentLabel(this.draft.appearance), 10),
            kvRow(t, 'Density', this.draft.appearance.density, 10),
            kvRow(t, 'Motion', this.draft.appearance.animations, 10),
        ];
        return panel(t, lines, { width, title: 'Live Preview', paddingY: t.panelPadding });
    }

    // ─── Mouse ──────────────────────────────────────────────

    private handleMouse(x: number, y: number, action: 'click' | 'release' | 'scroll-up' | 'scroll-down'): void {
        if (action === 'scroll-up') { createStepKeyHandler(this)({ type: 'up' }); return; }
        if (action === 'scroll-down') { createStepKeyHandler(this)({ type: 'down' }); return; }
        if (action === 'release') return;
        const cb = this.rowHits.get(y);
        if (cb) cb();
    }

    // ─── Modal / palette overlays ───────────────────────────

    private overlayConfirm(t: Theme, frame: string[], w: number, h: number): string[] {
        const modal = this.modals.find(m => m.kind === 'confirm') as Extract<Modal, { kind: 'confirm' }> | undefined;
        if (!modal) return frame;

        const btnLine = modal.buttons
            .map((b, i) => i === modal.activeBtn ? t.palette.inverse(` ${b} `) : t.palette.text(` ${b} `))
            .join('   ');
        const lines = [
            t.palette.title(modal.title),
            '',
            ...modal.messageLines.map(l => t.palette.text(l)),
            '',
            btnLine,
        ];
        const box = panel(t, lines, { width: Math.min(66, w - 8), title: 'Confirm', paddingY: 0 });
        return overlayCentered(frame, w, h, box);
    }

    private overlayToast(t: Theme, frame: string[], w: number, h: number): string[] {
        const toast = this.modals.find(m => m.kind === 'toast') as Extract<Modal, { kind: 'toast' }> | undefined;
        if (!toast) return frame;
        const box = panel(t, toast.lines.map(l => t.palette.text(l)), { width: Math.min(64, w - 10), title: 'Notice', paddingY: 0 });
        const left = Math.max(0, w - Math.max(...box.map(b => visibleLen(b))) - 2);
        const top = Math.max(0, h - box.length - 3);
        const out = frame.slice();
        for (let i = 0; i < box.length && top + i < h; i++) {
            out[top + i] = ' '.repeat(left) + box[i];
        }
        return out;
    }

    private overlayPalette(t: Theme, frame: string[], w: number, h: number): string[] {
        const items = this.paletteItems();
        const lines = [
            t.palette.title('COMMAND PALETTE'),
            '',
            ...items.map((it, i) => {
                const sel = i === this.paletteIdx;
                const cursor = sel ? t.palette.accentBold(t.icons.selected + ' ') : '  ';
                return cursor + (sel ? t.palette.accent(it.label) : t.palette.text(it.label));
            }),
            '',
            t.palette.dim('↑↓ navigate · Enter run · Esc close'),
        ];
        return overlayCentered(frame, w, h, panel(t, lines, { width: Math.min(46, w - 8), paddingY: 0 }));
    }
}

// ─── Module-level helpers ───────────────────────────────────

function columnsReduce(columns: string[][], gap: number): string[] {
    const rows = Math.max(...columns.map(c => c.length));
    const widths = columns.map(c => Math.max(0, ...c.map(l => visibleLen(l))));
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        columns.forEach((col, ci) => {
            const l = col[r] ?? '';
            line += l + ' '.repeat(gap + Math.max(0, widths[ci] - visibleLen(l)));
        });
        out.push(line.replace(/\s+$/, ''));
    }
    return out;
}

function overlayCentered(frame: string[], w: number, h: number, box: string[]): string[] {
    const out = frame.slice();
    const boxW = Math.max(...box.map(b => visibleLen(b)));
    const top = Math.max(0, Math.floor((h - box.length) / 2) - 1);
    const left = Math.max(0, Math.floor((w - boxW) / 2));
    for (let i = 0; i < box.length && top + i < h; i++) {
        const basePlain = stripAnsi(out[top + i] ?? '');
        const prefix = basePlain.slice(0, left);
        out[top + i] = prefix + box[i];
    }
    return out;
}

function tooSmallFrame(t: Theme, w: number, h: number): string[] {
    const msg1 = t.palette.title('Rose Setup requires a larger terminal window.');
    const msg2 = t.palette.dim(`Current size: ${w} x ${h}. Minimum: 46 x 16.`);
    const msg3 = t.palette.dim('Resize your terminal, or run: rose setup --plain');
    const out: string[] = [];
    const mid = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
        if (y === mid - 1) out.push(centerPlain(msg1, w));
        else if (y === mid) out.push(centerPlain(msg2, w));
        else if (y === mid + 1) out.push(centerPlain(msg3, w));
        else out.push('');
    }
    return out;
}

function centerPlain(s: string, w: number): string {
    const left = Math.max(0, Math.floor((w - visibleLen(s)) / 2));
    return ' '.repeat(left) + s;
}

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLen(s: string): number {
    return stripAnsi(s).length;
}

function truncateVisible(s: string, max: number): string {
    if (visibleLen(s) <= max) return s;
    let out = '';
    let vis = 0;
    for (let i = 0; i < s.length && vis < max - 1; i++) {
        if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) { out += m[0]; i += m[0].length - 1; continue; }
            continue;
        }
        out += s[i];
        vis++;
    }
    return out + '…';
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export function shortenHome(p: string): string {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (home && p.startsWith(home)) return '~' + p.slice(home.length);
    return p;
}

function summarizeSafe(results: CheckResult[]): { ready: boolean } {
    return summarizeChecks(results);
}

function accentLabel(a: AppearanceConfig): string {
    return a.accent + (a.accentHex ? ` (${a.accentHex})` : '');
}

/** Read persisted appearance without touching runtime systems. */
function currentAppearance(): AppearanceConfig {
    try {
        const app = Config.get().appearance;
        return { ...DEFAULT_APPEARANCE, ...(app || {}) };
    } catch {
        return { ...DEFAULT_APPEARANCE };
    }
}
