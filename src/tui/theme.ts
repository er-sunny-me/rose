/**
 * Phase 33 — Rose TUI Design System.
 *
 * Centralized design tokens shared by every TUI screen. All color output goes
 * through chalk, which automatically honors NO_COLOR=1 / FORCE_COLOR=0 and
 * degrades to plain text on non-color terminals (spec 51-54, 82).
 */
import chalk from 'chalk';

export type AccentName = 'rose' | 'blue' | 'purple' | 'green' | 'amber' | 'custom';
export type ThemeName = 'roseDark' | 'roseLight' | 'system';
export type Density = 'comfortable' | 'compact' | 'minimal';
export type AnimationMode = 'enabled' | 'reduced' | 'disabled';
export type UnicodeMode = 'auto' | 'on' | 'off';

export interface AppearanceConfig {
    theme: ThemeName;
    accent: AccentName;
    accentHex?: string; // only used when accent === 'custom'
    density: Density;
    animations: AnimationMode;
    unicode: UnicodeMode;
    highContrast?: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
    theme: 'roseDark',
    accent: 'rose',
    density: 'comfortable',
    animations: 'enabled',
    unicode: 'auto',
    highContrast: false,
};

/** Registered accents. Enumerated values keep escape-sequence injection out (spec 82). */
const ACCENTS: Record<Exclude<AccentName, 'custom'>, [number, number, number]> = {
    rose: [244, 63, 94],
    blue: [59, 130, 246],
    purple: [168, 85, 247],
    green: [34, 197, 94],
    amber: [245, 158, 11],
};

/** Validate a user-supplied hex accent before it may touch the terminal. */
export function isValidHexColor(hex: string): boolean {
    return /^#?[0-9a-fA-F]{6}$/.test(hex);
}

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

export interface ThemePalette {
    /** Primary brand / selection color painter. */
    accent: (s: string) => string;
    accentBold: (s: string) => string;
    title: (s: string) => string;
    text: (s: string) => string;
    dim: (s: string) => string;
    border: (s: string) => string;
    ok: (s: string) => string;
    warn: (s: string) => string;
    error: (s: string) => string;
    inverse: (s: string) => string;
}

export class Theme {
    readonly appearance: AppearanceConfig;
    readonly palette: ThemePalette;
    readonly icons: IconSet;

    constructor(appearance: Partial<AppearanceConfig> = {}) {
        this.appearance = { ...DEFAULT_APPEARANCE, ...appearance };
        this.palette = Theme.buildPalette(this.appearance);
        this.icons = Theme.buildIcons(this.appearance.unicode);
    }

    private static buildPalette(a: AppearanceConfig): ThemePalette {
        let rgb: [number, number, number];
        if (a.accent === 'custom' && a.accentHex && isValidHexColor(a.accentHex)) {
            rgb = hexToRgb(a.accentHex);
        } else if (a.accent === 'custom') {
            rgb = ACCENTS.rose; // malformed custom values fall back safely
        } else {
            rgb = ACCENTS[a.accent];
        }

        if (a.highContrast) {
            return {
                accent: (s) => chalk.bold.rgb(...rgb)(s),
                accentBold: (s) => chalk.bold.rgb(...rgb)(s),
                title: (s) => chalk.bold.white(s),
                text: (s) => chalk.white(s),
                dim: (s) => chalk.rgb(170, 170, 170)(s),
                border: (s) => chalk.rgb(200, 200, 200)(s),
                ok: (s) => chalk.bold.green(s),
                warn: (s) => chalk.bold.yellow(s),
                error: (s) => chalk.bold.red(s),
                inverse: (s) => chalk.inverse(s),
            };
        }

        const light = a.theme === 'roseLight';
        return {
            accent: (s) => chalk.rgb(...rgb)(s),
            accentBold: (s) => chalk.bold.rgb(...rgb)(s),
            title: (s) => (light ? chalk.black.bold(s) : chalk.bold(s)),
            text: (s) => (light ? chalk.black(s) : chalk.white(s)),
            dim: (s) => (light ? chalk.rgb(90, 90, 90)(s) : chalk.gray(s)),
            border: (s) => (light ? chalk.rgb(120, 120, 120)(s) : chalk.rgb(70, 70, 80)(s)),
            ok: (s) => (light ? chalk.green(s) : chalk.green(s)),
            warn: (s) => (light ? chalk.rgb(180, 120, 0)(s) : chalk.yellow(s)),
            error: (s) => (light ? chalk.rgb(190, 0, 40)(s) : chalk.red(s)),
            inverse: (s) => chalk.inverse(s),
        };
    }

    private static buildIcons(mode: UnicodeMode): IconSet {
        // Legacy Windows conhost without WT_SESSION/TERM_PROGRAM gets ASCII fallback.
        let supportsUnicode = true;
        if (mode === 'off') supportsUnicode = false;
        else if (mode === 'auto') {
            if (process.env.TERM === 'dumb') supportsUnicode = false;
            else if (process.platform === 'win32') {
                supportsUnicode = Boolean(
                    process.env.WT_SESSION ||
                    process.env.TERM_PROGRAM ||
                    process.env.ANSICON ||
                    process.env.ConEmuANSI
                );
            }
        }

        if (!supportsUnicode) {
            return new AsciiIcons();
        }
        return new UnicodeIcons();
    }

    /** Vertical spacing between sections for current density. */
    get sectionGap(): number {
        switch (this.appearance.density) {
            case 'comfortable': return 1;
            case 'compact': return 0;
            case 'minimal': return 0;
        }
    }

    /** Blank padding rows inside panels. */
    get panelPadding(): number {
        switch (this.appearance.density) {
            case 'comfortable': return 1;
            default: return 0;
        }
    }

    /** Spinner frame interval in ms honoring animation preferences (spec 31). */
    get spinnerIntervalMs(): number | null {
        switch (this.appearance.animations) {
            case 'enabled': return 80;
            case 'reduced': return 320;
            case 'disabled': return null;
        }
    }
}

export interface IconSet {
    logo: string;
    selected: string;   // list cursor
    radioOn: string;
    radioOff: string;
    checkboxOn: string;
    checkboxOff: string;
    check: string;
    warn: string;
    cross: string;
    info: string;
    bullet: string;
    arrowUp: string;
    arrowDown: string;
    cursor: string;     // text input caret
    tls: string; trs: string; bls: string; brs: string; // rounded box corners
    hLine: string; vLine: string;
    teeRight: string; teeLeft: string;
}

class UnicodeIcons implements IconSet {
    logo = '\u{1F339}'; // 🌹
    selected = '❯'; // ❯
    radioOn = '●';  // ●
    radioOff = '○'; // ○
    checkboxOn = '[x]';
    checkboxOff = '[ ]';
    check = '✓';
    warn = '⚠';
    cross = '✗';
    info = 'ℹ';
    bullet = '•';
    arrowUp = '↑';
    arrowDown = '↓';
    cursor = '│';
    tls = '╭'; trs = '╮'; bls = '╰'; brs = '╯';
    hLine = '─'; vLine = '│';
    teeRight = '├'; teeLeft = '┤';
}

class AsciiIcons implements IconSet {
    logo = 'ROSE';
    selected = '>';
    radioOn = '(*)';
    radioOff = '( )';
    checkboxOn = '[x]';
    checkboxOff = '[ ]';
    check = '+';
    warn = '!';
    cross = 'x';
    info = 'i';
    bullet = '-';
    arrowUp = '^';
    arrowDown = 'v';
    cursor = '|';
    tls = '+'; trs = '+'; bls = '+'; brs = '+';
    hLine = '-'; vLine = '|';
    teeRight = '+'; teeLeft = '+';
}

// ─── Visible-width text helpers (ANSI-aware + Unicode-width aware) ──────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, '');
}

/**
 * Display width of one code point. BUGFIX for glitchy layouts with Hindi and
 * emoji: combining marks (Devanagari matras/virama, accents, variation
 * selectors) render as ZERO cells, while East-Asian/emoji glyphs render as
 * TWO cells. Counting UTF-16 units broke every panel border.
 */
export function charWidth(cp: number): number {
    // Zero-width: combining diacriticals, Devanagari sign clusters,
    // generic extenders, variation selectors, ZWJ/ZWNJ, control chars.
    if (
        (cp >= 0x0300 && cp <= 0x036f) ||
        (cp >= 0x0900 && cp <= 0x0903) ||   // Devanagari signs (incl. candrabindu/visarga)
        (cp >= 0x093a && cp <= 0x094f) ||   // nukta, matras, virama
        (cp >= 0x0951 && cp <= 0x0957) ||
        cp === 0x0962 || cp === 0x0963 ||
        (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) ||
        (cp >= 0x20d0 && cp <= 0x20ff) ||
        cp === 0x200c || cp === 0x200d ||   // ZWNJ / ZWJ
        (cp >= 0xfe00 && cp <= 0xfe0f) ||   // variation selectors
        (cp >= 0xfe20 && cp <= 0xfe2f) ||
        cp === 0x00ad ||
        (cp >= 0x0001 && cp <= 0x001f)
    ) {
        return 0;
    }

    // Double-width: CJK, Hangul, fullwidth forms, most emoji blocks.
    if (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xa960 && cp <= 0xa97f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe19) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f680 && cp <= 0x1f6ff) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa70 && cp <= 0x1faff) ||
        cp === 0x2329 || cp === 0x232a ||
        cp === 0x303f
    ) {
        return 2;
    }

    return 1;
}

/** Visible display columns of a styled string. */
export function visibleLength(s: string): number {
    let total = 0;
    let inAnsi = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\x1b') { inAnsi = true; continue; }
        if (inAnsi) {
            if (ch === 'm') inAnsi = false;
            continue;
        }
        const cp = s.codePointAt(i)!;
        total += charWidth(cp);
        if (cp > 0xffff) i++;
    }
    return total;
}

/** Truncate to at most `max` visible columns without breaking escape sequences. */
export function truncateVisible(s: string, max: number): string {
    if (max <= 0) return '';
    let out = '';
    let vis = 0;
    let inAnsi = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inAnsi) {
            out += ch;
            if (ch === 'm') inAnsi = false;
            continue;
        }
        if (ch === '\x1b') { inAnsi = true; out += ch; continue; }
        if (vis >= max) break;
        const cp = s.codePointAt(i)!;
        out += s.slice(i, i + (cp > 0xffff ? 2 : 1));
        vis += charWidth(cp);
        if (cp > 0xffff) i++;
    }
    return out;
}

export function padEndVisible(s: string, width: number): string {
    const pad = width - visibleLength(s);
    return pad > 0 ? s + ' '.repeat(pad) : truncateVisible(s, width);
}

/** Center within width, accounting for ANSI codes. */
export function centerVisible(s: string, width: number): string {
    const len = visibleLength(s);
    if (len >= width) return truncateVisible(s, width);
    const left = Math.floor((width - len) / 2);
    return ' '.repeat(left) + s;
}
