/**
 * Phase 33 — Terminal control layer.
 *
 * Owns the alternate screen buffer, raw-mode input parsing (keyboard + SGR
 * mouse), resize events and the diff-based frame renderer. Every resource is
 * restored exactly once on exit — even after Ctrl+C or a crash (spec 8, 56).
 */
import { StringDecoder } from 'string_decoder';

export type KeyMsg =
    | { type: 'char'; text: string }
    | { type: 'enter' }
    | { type: 'esc' }
    | { type: 'tab' }
    | { type: 'shifttab' }
    | { type: 'up' }
    | { type: 'down' }
    | { type: 'left' }
    | { type: 'right' }
    | { type: 'backspace' }
    | { type: 'delete' }
    | { type: 'space' }
    | { type: 'ctrl'; name: 'c' | 'r' | 'l' | 'k' | 'd' }
    | { type: 'mouse'; x: number; y: number; action: 'click' | 'release' | 'scroll-up' | 'scroll-down' };

export class Screen {
    width = process.stdout.columns || 80;
    height = process.stdout.rows || 24;

    private rawMode = false;
    private running = false;
    private decoder = new StringDecoder('utf8');
    private pendingInput = '';
    private keyWaiters: Array<(k: KeyMsg) => void> = [];
    private dataListener: ((chunk: Buffer) => void) | null = null;
    private resizeListeners: Array<() => void> = [];
    private prevFrame: string[] = [];
    private stdinWasRaw = false;
    private exited = false;

    public static supportsInteractive(): boolean {
        return Boolean(process.stdout.isTTY && process.stdin.isTTY) && process.env.CI !== 'true';
    }

    public enter(): void {
        if (this.running || !process.stdout.isTTY) return;
        this.running = true;
        this.exited = false;
        this.width = process.stdout.columns || 80;
        this.height = process.stdout.rows || 24;

        // Alternate buffer + hide cursor + enable mouse tracking (button + SGR).
        process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h');
        process.stdout.write('\x1b[2J\x1b[H');

        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
            this.stdinWasRaw = process.stdin.isRaw;
            try {
                process.stdin.setRawMode(true);
                this.rawMode = true;
            } catch {
                /* non-TTY stdin — keyboard still works line-wise in degraded hosts */
            }
        }

        this.dataListener = (chunk: Buffer) => this.handleData(chunk);
        process.stdin.on('data', this.dataListener);
        try { process.stdin.resume(); } catch { /* stdin unavailable */ }

        process.stdout.on('resize', this.handleResize);

        // Last-resort restore if something calls process.exit without cleanup.
        this.installExitHooks();
    }

    /** Restore terminal state. Idempotent and safe to call from anywhere. */
    public exit(): void {
        if (this.exited || !this.running) return;
        this.exited = true;
        this.running = false;

        try { process.stdout.removeListener('resize', this.handleResize); } catch { /* ignore */ }
        if (this.dataListener) {
            try { process.stdin.removeListener('data', this.dataListener); } catch { /* ignore */ }
            this.dataListener = null;
        }
        if (this.rawMode && typeof process.stdin.setRawMode === 'function') {
            try { process.stdin.setRawMode(this.stdinWasRaw); } catch { /* ignore */ }
            this.rawMode = false;
        }
        // Show cursor, disable mouse, leave alternate buffer.
        try {
            process.stdout.write('\x1b[?25h');
            process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
            process.stdout.write('\x1b[?1049l');
        } catch { /* stdout may already be gone */ }
    }

    private handleResize = (): void => {
        this.width = process.stdout.columns || 80;
        this.height = process.stdout.rows || 24;
        this.prevFrame = []; // force full redraw at new size
        for (const cb of this.resizeListeners) cb();
    };

    public onResize(cb: () => void): void {
        this.resizeListeners.push(cb);
    }

    private installExitHooks(): void {
        process.once('exit', () => this.exit());
    }

    // ─── Input ──────────────────────────────────────────────

    private handleData(chunk: Buffer): void {
        this.pendingInput += this.decoder.write(chunk);
        while (true) {
            const msg = this.parseOne();
            if (!msg) break;
            this.dispatchKey(msg);
        }
    }

    /** Parse one key/mouse message from the pending buffer, or null if incomplete. */
    private parseOne(): KeyMsg | null {
        const buf = this.pendingInput;
        if (buf.length === 0) return null;

        // Escape sequences
        if (buf[0] === '\x1b') {
            if (buf.length === 1) {
                this.pendingInput = buf.slice(1);
                return { type: 'esc' };
            }
            if (buf[1] === '[') {
                const csiMatch = /^(\x1b\[)([0-9;<]*)([A-Za-z~])/.exec(buf);
                if (!csiMatch) return null; // wait for the rest of the sequence

                const params = csiMatch[2];
                const final = csiMatch[3];
                this.pendingInput = buf.slice(csiMatch[0].length);

                // SGR mouse: ESC [ < b ; x ; y M|m
                if (params.startsWith('<')) {
                    const parts = params.slice(1).split(';');
                    const b = parseInt(parts[0] || '0', 10);
                    const x = parseInt(parts[1] || '1', 10);
                    const y = parseInt(parts[2] || '1', 10);
                    let action: 'click' | 'release' | 'scroll-up' | 'scroll-down';
                    if (b === 64) action = 'scroll-up';
                    else if (b === 65) action = 'scroll-down';
                    else if (final === 'M') action = 'click';
                    else action = 'release';
                    return { type: 'mouse', x: Math.max(0, x - 1), y: Math.max(0, y - 1), action };
                }

                switch (final) {
                    case 'A': return { type: 'up' };
                    case 'B': return { type: 'down' };
                    case 'C': return { type: 'right' };
                    case 'D': return { type: 'left' };
                    case 'Z': return { type: 'shifttab' };
                    case '~':
                        if (params === '3') return { type: 'delete' };
                        if (params === '5') return null; // PgUp unused
                        if (params === '6') return null; // PgDn unused
                        return null;
                    default: return null; // consume unknown CSI quietly
                }
            }
            // Alt+key or other escapes we don't model — drop the ESC.
            this.pendingInput = buf.slice(1);
            return { type: 'esc' };
        }

        // Control keys
        const code = buf.charCodeAt(0);
        if (code === 13 || code === 10) {
            this.pendingInput = buf.slice(1);
            return { type: 'enter' };
        }
        if (code === 9) {
            this.pendingInput = buf.slice(1);
            return { type: 'tab' };
        }
        if (code === 127 || code === 8) {
            this.pendingInput = buf.slice(1);
            return { type: 'backspace' };
        }
        if (code === 3) { this.consume(1); return { type: 'ctrl', name: 'c' }; }
        if (code === 18) { this.consume(1); return { type: 'ctrl', name: 'r' }; }
        if (code === 12) { this.consume(1); return { type: 'ctrl', name: 'l' }; }
        if (code === 11) { this.consume(1); return { type: 'ctrl', name: 'k' }; }
        if (code === 4) { this.consume(1); return { type: 'ctrl', name: 'd' }; }
        if (code < 32) { this.consume(1); return null; } // other control chars ignored

        // Printable text (may be multi-byte UTF-8)
        let take = 1;
        if (code >= 0xD800 && code <= 0xDBFF) take = 2; // surrogate pair already decoded by StringDecoder
        const text = buf.slice(0, take);
        this.consume(take);
        if (text === ' ') return { type: 'space' };
        return { type: 'char', text };
    }

    private consume(n: number): void {
        this.pendingInput = this.pendingInput.slice(n);
    }

    private dispatchKey(msg: KeyMsg): void {
        const waiter = this.keyWaiters.shift();
        if (waiter) waiter(msg);
        else this.bufferedKeys.push(msg);
    }

    private bufferedKeys: KeyMsg[] = [];

    /** Await the next key/mouse event. */
    public readKey(): Promise<KeyMsg> {
        const buffered = this.bufferedKeys.shift();
        if (buffered) return Promise.resolve(buffered);
        return new Promise((resolve) => this.keyWaiters.push(resolve));
    }

    /** Non-blocking peek used by tests / plain mode. */
    public hasBufferedKeys(): boolean {
        return this.bufferedKeys.length > 0;
    }

    // ─── Output ─────────────────────────────────────────────

    /**
     * Diff-render a full frame. `lines` must contain exactly height rows;
     * each row is clipped to the current width to avoid horizontal overflow.
     */
    public render(lines: string[]): void {
        if (!this.running) return;
        const w = this.width;
        const h = this.height;

        const frame: string[] = [];
        for (let y = 0; y < h; y++) {
            const src = lines[y] ?? '';
            frame.push(clipToWidth(src, w));
        }

        const out: string[] = [];
        const maxLen = Math.max(frame.length, this.prevFrame.length);
        for (let y = 0; y < maxLen; y++) {
            const next = frame[y] ?? '';
            if (this.prevFrame[y] === next) continue;
            out.push(`\x1b[${y + 1};1H\x1b[2K` + next);
        }
        if (out.length > 0) {
            process.stdout.write(out.join(''));
            this.prevFrame = frame;
        }
    }

    public clearScreen(): void {
        process.stdout.write('\x1b[2J\x1b[H');
        this.prevFrame = [];
    }
}

/** ANSI-aware clipping so no line can overflow the terminal width (spec 9). */
export function clipToWidth(s: string, max: number): string {
    if (max <= 0) return '';
    let out = '';
    let vis = 0;
    let i = 0;
    while (i < s.length) {
        if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) {
                out += m[0];
                i += m[0].length;
                continue;
            }
            i++;
            continue;
        }
        if (vis >= max) break;
        out += s[i];
        vis++;
        i++;
    }
    return out;
}
