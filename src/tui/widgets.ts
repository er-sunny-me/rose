/**
 * Phase 33 — Reusable TUI component system (spec 50).
 *
 * Widgets are pure functions of state -> frame fragments. No widget touches
 * the terminal directly; the App composes frames and the Screen diffs them.
 */
import { Theme, padEndVisible, visibleLength } from './theme.js';

/** A rendered frame fragment with optional click targets. */
export interface Fragment {
    lines: string[];
    /** Whole-row click targets. Key = row index relative to this fragment's first line. */
    rowHits?: Map<number, () => void>;
    /** Column-ranged click targets (buttons inside one row). */
    colHits?: Array<{ row: number; startCol: number; endCol: number; cb: () => void }>;
}

export function frag(lines: string[]): Fragment {
    return { lines };
}

// ─── Panels & boxes ─────────────────────────────────────────

export interface PanelOptions {
    title?: string;
    width: number;
    paddingY?: number;
}

function truncatePlain(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '~';
}

/** Draw a rounded box around `content` at exactly `width` columns. */
export function panel(t: Theme, content: string[], opts: PanelOptions): string[] {
    const border = t.palette.border;
    const titleColor = t.palette.accentBold;
    const w = Math.max(opts.width, 4);
    const inner = w - 2;
    const out: string[] = [];

    if (opts.title) {
        const titleText = ' ' + titleColor(truncatePlain(opts.title, inner - 4)) + ' ';
        const tl = Math.max(1, Math.floor((w - 2 - visibleLength(titleText)) / 2));
        out.push(
            border(t.icons.tls + t.icons.hLine.repeat(tl)) + titleText +
            border(t.icons.hLine.repeat(Math.max(0, w - 2 - tl - visibleLength(titleText))) + t.icons.trs)
        );
    } else {
        out.push(border(t.icons.tls + t.icons.hLine.repeat(w - 2) + t.icons.trs));
    }

    const pad = opts.paddingY ?? 0;
    for (let i = 0; i < pad; i++) out.push(border(t.icons.vLine) + ' '.repeat(inner) + border(t.icons.vLine));
    for (const line of content) {
        out.push(border(t.icons.vLine) + ' ' + padEndVisible(line, inner - 2) + ' ' + border(t.icons.vLine));
    }
    for (let i = 0; i < pad; i++) out.push(border(t.icons.vLine) + ' '.repeat(inner) + border(t.icons.vLine));
    out.push(border(t.icons.bls + t.icons.hLine.repeat(w - 2) + t.icons.brs));
    return out;
}

// ─── Lists & selects ────────────────────────────────────────

export interface SelectItem {
    label: string;
    hint?: string;
    value: string;
    disabled?: boolean;
    badge?: string;
}

/**
 * Single-select list. Hit rows are relative to the returned fragment; callers
 * offset them when embedding into larger frames.
 */
export function selectList(
    t: Theme,
    items: SelectItem[],
    selectedIdx: number,
    onSelect?: (value: string) => void
): Fragment {
    const lines: string[] = [];
    const rowHits = new Map<number, () => void>();

    items.forEach((item, i) => {
        const focused = i === selectedIdx;
        const cursor = item.disabled ? ' ' : (focused ? t.icons.selected : ' ');
        let label = cursor + ' ' + item.label;
        if (item.badge) label += '  ' + t.palette.dim(`(${item.badge})`);
        if (item.hint) label += '  ' + t.palette.dim(item.hint);

        const painter = item.disabled ? ((s: string) => t.palette.dim(s)) : (focused ? t.palette.accentBold : t.palette.text);
        lines.push(painter(label));

        if (!item.disabled && onSelect) {
            rowHits.set(i, () => {
                if (i === selectedIdx) onSelect(item.value);
            });
        }
    });

    return { lines, rowHits };
}

export function checkboxRow(t: Theme, on: boolean, label: string, onToggle?: () => void): Fragment {
    const box = on ? t.icons.checkboxOn : t.icons.checkboxOff;
    const painter = on ? t.palette.accent : t.palette.text;
    const line = painter(`${box} ${label}`);
    const rowHits = new Map<number, () => void>();
    if (onToggle) rowHits.set(0, onToggle);
    return { lines: [line], rowHits };
}

// ─── Text input ─────────────────────────────────────────────

export interface InputState {
    value: string;
    cursorPos: number;
    masked?: boolean;
    placeholder?: string;
    error?: string;
}

export function textInput(t: Theme, s: InputState, width: number): string[] {
    const shown = s.masked ? '*'.repeat(s.value.length) : s.value;
    const before = shown.slice(0, s.cursorPos);
    const atCursor = shown[s.cursorPos] ?? '';
    const after = shown.slice(s.cursorPos + 1);
    const caret = t.palette.accentBold(t.icons.cursor);

    let field: string;
    if (!s.value && s.placeholder) {
        field = t.palette.dim(truncatePlain(s.placeholder, width - 4));
    } else {
        field = fitWithCaret(before, atCursor, after, caret, width - 4);
    }

    const lines = [t.palette.border('[') + padEndVisible(field, width - 4) + t.palette.border(']')];
    if (s.error) lines.push(t.palette.error(`${t.icons.cross} ${s.error}`));
    return lines;
}

function fitWithCaret(before: string, at: string, after: string, caret: string, max: number): string {
    // Keep the caret visible: trim tail first, then head.
    let b = before;
    let a = after;
    while (b.length + 1 + a.length > max && a.length > 0) a = a.slice(0, -1);
    while (b.length + 1 + a.length > max && b.length > 0) b = b.slice(1);
    return b + caret + at + a;
}

export const passwordInput = textInput;

// ─── Buttons ────────────────────────────────────────────────

/**
 * Horizontal button row. Returns the composed line plus column ranges so the
 * App can translate clicks into activations.
 */
export function buttonRow(
    t: Theme,
    labels: string[],
    activeIdx: number,
    onActivate?: (idx: number) => void
): Fragment {
    const parts: string[] = [];
    const colHits: Array<{ row: number; startCol: number; endCol: number; cb: () => void }> = [];
    let col = 0;

    labels.forEach((label, i) => {
        const active = i === activeIdx;
        const btn = active ? t.palette.inverse(` ${label} `) : t.palette.text(` ${label} `);
        const start = col;
        const end = start + visibleLength(btn);
        parts.push(btn);
        col = end + 3;
        if (onActivate && !active) {
            colHits.push({ row: 0, startCol: start - 1, endCol: end + 1, cb: () => onActivate(i) });
        }
    });

    return colHits.length > 0
        ? { lines: [parts.join('   ')], colHits }
        : { lines: [parts.join('   ')] };
}

// ─── Status / key-value rows ────────────────────────────────

export type HealthState = 'pass' | 'warn' | 'fail' | 'idle';

export function statusDot(t: Theme, state: HealthState): string {
    switch (state) {
        case 'pass': return t.palette.ok(t.icons.radioOn);
        case 'warn': return t.palette.warn(t.icons.radioOn);
        case 'fail': return t.palette.error(t.icons.cross);
        default: return t.palette.dim(t.icons.radioOff);
    }
}

export function statusRow(t: Theme, label: string, state: HealthState, detail: string, labelWidth = 24): string {
    const dot = statusDot(t, state);
    const labelPart = padEndVisible(label, labelWidth);
    const color = state === 'fail' ? t.palette.error : state === 'warn' ? t.palette.warn : t.palette.text;
    return dot + ' ' + labelPart + color(detail);
}

export function kvRow(t: Theme, key: string, value: string, keyWidth = 22): string {
    const k = padEndVisible(key + ':', keyWidth);
    return t.palette.dim(k) + t.palette.text(value);
}

export function heading(t: Theme, text: string): string {
    return t.palette.title(text.toUpperCase());
}

export function progressBar(t: Theme, pct: number, width: number): string {
    const clamped = Math.max(0, Math.min(1, pct));
    const filled = Math.round(clamped * width);
    const bar = t.palette.accent('#'.repeat(filled)) + t.palette.dim('.'.repeat(width - filled));
    return `[${bar}] ${Math.round(clamped * 100)}%`;
}

// ─── Spinner ────────────────────────────────────────────────

const SPINNER_FRAMES_UNICODE = ['|', '/', '-', '\\'];
const SPINNER_BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
    private frame = 0;
    private timer: NodeJS.Timeout | null = null;
    public label = '';

    constructor(private themeRef: Theme) {}

    get current(): string {
        const frames = this.themeRef.appearance.animations === 'disabled'
            ? SPINNER_FRAMES_UNICODE
            : SPINNER_BRAILLE;
        return frames[this.frame % frames.length];
    }

    renderLine(): string {
        if (!this.label) return '';
        return this.themeRef.palette.accent(this.current) + ' ' + this.themePaletteSafe(this.label);
    }

    private themePaletteSafe(s: string): string {
        return this.themeRef.palette.text(s);
    }

    start(label: string, intervalMs: number | null): void {
        this.label = label;
        this.stopTimer();
        if (intervalMs !== null) {
            this.timer = setInterval(() => { this.frame++; }, intervalMs);
            this.timer.unref?.();
        }
    }

    stop(): void {
        this.label = '';
        this.stopTimer();
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
