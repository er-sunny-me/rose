import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Config } from '../config.js';

// ─────────────────────────────────────────────────────────────
// Layered command execution pipeline:
//
//   Command Intent
//     ↓
//   Denylist scan          (known-dangerous shapes)
//     ↓
//   Command Parser         (quote-aware tokenizer, operator detection)
//     ↓
//   Executable Allowlist   (per-command-class)
//     ↓
//   Argument Validation    (metacharacters, flags)
//     ↓
//   Working-Directory Jail (canonical path containment)
//     ↓
//   Environment Filtering  (secret-free allowlisted env)
//     ↓
//   Resource Limits        (timeout, output cap, process-group kill)
//     ↓
//   Execution              (shell:false preferred; shell only elevated)
// ─────────────────────────────────────────────────────────────

export type CommandClass = 'safe' | 'shell' | 'denied';
export type SandboxDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface ParsedCommand {
    executable: string;
    args: string[];
    /** Shell operators found in the raw string (| && ; > < & $() etc.) */
    operators: string[];
    /** True when the command resolves to a shell builtin (dir/copy/del/…). */
    isBuiltin: boolean;
}

export interface SandboxCheck {
    decision: SandboxDecision;
    commandClass: CommandClass;
    reason: string;
    parsed?: ParsedCommand;
}

export interface SandboxLimits {
    timeoutMs: number;
    maxOutputBytes: number;
}

export interface SandboxResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    truncated: boolean;
    timedOut: boolean;
}

export interface DryRunReport {
    command: string;
    workingDirectory: string;
    environmentScope: 'filtered' | 'full';
    executable: string;
    argumentCount: number;
    shellOperators: string[];
    usesShell: boolean;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    decision: SandboxDecision;
    reason: string;
}

const DEFAULT_LIMITS: SandboxLimits = {
    timeoutMs: 15_000,
    maxOutputBytes: 512 * 1024,
};

/**
 * Base executable allowlist. These are *starting points*, not universal
 * guarantees — each entry can still receive dangerous arguments, which the
 * denylist and argument validation catch. Extend per-deployment via the
 * ROSE_SANDBOX_EXTRA_ALLOWLIST env var (comma separated).
 */
const BASE_ALLOWLIST = new Set([
    // build / dev tooling
    'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'tsx', 'vite', 'vitest',
    'git', 'python', 'python3', 'pip', 'pytest', 'uv',
    // read-only inspection
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'which', 'whoami',
    'type', 'where', 'tasklist', 'ipconfig', 'ping', 'netstat', 'systeminfo',
    'pwd', 'tree', 'hostname', 'date',
]);

/** Windows cmd.exe builtins — require shell mode (elevated risk path). */
const WIN_BUILTINS = new Set(['dir', 'copy', 'move', 'del', 'rd', 'rmdir', 'md', 'mkdir', 'echo', 'ren', 'rename', 'set', 'cls']);
const POSIX_BUILTINS = new Set(['cd', 'export', 'source', 'alias', 'unset']);

/** Patterns that are denied outright, regardless of allowlist membership. */
const DENYLIST_PATTERNS: Array<{ id: string; pattern: RegExp; why: string }> = [
    { id: 'wipe-root', pattern: /\brm\s+(-[a-z]*\s+)*\/(\s|$)/i, why: 'recursive deletion of filesystem root' },
    { id: 'rm-rf-wildcard', pattern: /\brm\s+-rf?\s+(~|\*|\.\/?\s*$|\.\s*$)/i, why: 'unbounded recursive delete' },
    { id: 'format', pattern: /\bformat(\.com)?\b/i, why: 'disk formatting utility' },
    { id: 'shutdown', pattern: /\b(shutdown|reboot|halt|poweroff)(\.exe)?\b/i, why: 'system power control' },
    { id: 'diskpart', pattern: /\bdiskpart\b/i, why: 'partition manipulation' },
    { id: 'del-system', pattern: /\b(del|erase|rd|rmdir)\s+([a-z]:\\(windows|program files)|%windir%|c:\\windows)/i, why: 'deletion targeting system directories' },
    { id: 'pipe-to-shell', pattern: /(curl|wget)[^|]*\|\s*(sh|bash|zsh|powershell|iex)\b/i, why: 'remote code piped into a shell' },
    { id: 'ps-encoded', pattern: /powershell(\.exe)?\s+.*(-enc|-ec|encodedcommand)\b/i, why: 'encoded PowerShell payload' },
    { id: 'ps-download-cradle', pattern: /powershell(\.exe)?.*(downloadstring|downloadfile|invoke-expression|iex)\b/i, why: 'PowerShell download cradle' },
    { id: 'registry-write', pattern: /\breg(\.exe)?\s+(add|delete|import|restore)\b/i, why: 'Windows registry modification' },
    { id: 'credential-access', pattern: /\b(secedit|vaultcmd|netsh\s+trace|mimikatz)\b/i, why: 'credential/secret extraction tooling' },
    { id: 'schtasks-create', pattern: /\bschtasks(\.exe)?\s+\/create/i, why: 'persistent scheduled task creation' },
    { id: 'vssadmin-delete', pattern: /\bvssadmin(\.exe)?\s+delete\b/i, why: 'shadow copy deletion (ransomware behavior)' },
    { id: 'cipher-wipe', pattern: /\bcipher(\.exe)?\s+\/w/i, why: 'free-space wiping' },
    { id: 'bcdedit', pattern: /\bbcdedit(\.exe)?\b/i, why: 'boot configuration modification' },
];

const SHELL_OPERATORS = ['&&', '||', '|&', '|', '>', '>>', '<', '&', ';'];

function getExtraAllow(): Set<string> {
    const parts = [
        ...(process.env.ROSE_SANDBOX_EXTRA_ALLOWLIST || '').split(','),
        ...((Config.get().security as any)?.sandboxAllowlist || []),
    ];
    return new Set(parts.map(s => String(s).trim().toLowerCase()).filter(Boolean));
}

/**
 * URL-opening commands ("start https://…", macOS `open`, Linux `xdg-open`)
 * are allowed WITHOUT full allowlist membership — but ONLY when every
 * argument is a plain http(s) URL. `start notepad.exe` still requires
 * approval like any other unlisted executable.
 */
function isUrlOpenOnly(executableBase: string, args: string[]): boolean {
    const openers = process.platform === 'win32'
        ? ['start']
        : process.platform === 'darwin'
            ? ['open']
            : ['xdg-open'];
    if (!openers.includes(executableBase)) return false;
    // Skip the optional window-title placeholder: start "" https://…
    const rest = args.filter(a => a !== '""' && a !== "''");
    return rest.length > 0 && rest.every(a => /^https?:\/\//i.test(a));
}

/** Quote-aware tokenizer (double + single quotes, Windows carets ignored). */
export function tokenize(raw: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

/** Find unquoted shell operators present in the raw string. */
export function findShellOperators(raw: string): string[] {
    const found: string[] = [];
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        const rest = raw.slice(i);
        const op = SHELL_OPERATORS.find(o => rest.startsWith(o));
        if (op) {
            if (!found.includes(op)) found.push(op);
            i += op.length - 1;
            continue;
        }
        // Command substitution / expansion
        if ((ch === '$' && raw[i + 1] === '(') || ch === '`') {
            if (!found.includes('command-substitution')) found.push('command-substitution');
        }
    }
    return found;
}

export function scanDenylist(raw: string): { id: string; why: string } | null {
    for (const entry of DENYLIST_PATTERNS) {
        if (entry.pattern.test(raw)) return { id: entry.id, why: entry.why };
    }
    return null;
}

/**
 * Canonicalise a path and verify it stays inside one of the allowed roots,
 * resolving symlinks/junctions to their real target first.
 */
export function isPathInsideAllowedRoots(candidate: string, allowedRoots: string[]): boolean {
    try {
        // Reject UNC paths outright (\\server\share) — outside any local root.
        if (/^\\\\[^\\]/.test(candidate)) return false;

        const resolved = path.resolve(candidate);
        let real: string;
        try {
            real = fs.realpathSync(resolved);
        } catch {
            // Path may not exist yet (e.g. cwd creation); canonicalise the parent.
            const parent = path.dirname(resolved);
            try {
                real = path.join(fs.realpathSync(parent), path.basename(resolved));
            } catch {
                return false;
            }
        }

        const normalizedReal = path.normalize(real).toLowerCase().replace(/[\\/]+$/, '');
        return allowedRoots.some(root => {
            const r = fs.realpathSync(path.resolve(root)).toLowerCase();
            return normalizedReal === r || normalizedReal.startsWith(r + path.sep.toLowerCase());
        });
    } catch {
        return false;
    }
}

export interface SandboxOptions {
    /** Directory the command will run in. Defaults to process.cwd(). */
    cwd?: string;
    /** Extra directories commands may operate in (defaults: workspace root). */
    additionalRoots?: string[];
    limits?: Partial<SandboxLimits>;
}

export interface SandboxVerdict extends SandboxCheck {
    limits: SandboxLimits;
    cwd: string;
    allowedRoots: string[];
    /** Filtered environment actually handed to the child process. */
    childEnv: NodeJS.ProcessEnv;
    dryRunReport: DryRunReport;
}

/**
 * Full static evaluation of a command intent. No process is started here.
 */
export function evaluateCommand(rawCommand: string, options: SandboxOptions = {}): SandboxVerdict {
    const cwd = path.resolve(options.cwd || process.cwd());
    const allowedRoots = [Security_getWorkspaceRoot(), ...(options.additionalRoots || [])];
    const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };

    const base: Omit<SandboxVerdict, 'decision' | 'commandClass' | 'reason'> = {
        limits,
        cwd,
        allowedRoots,
        childEnv: filterEnvironment(),
        dryRunReport: {
            command: rawCommand,
            workingDirectory: cwd,
            environmentScope: 'filtered',
            executable: '',
            argumentCount: 0,
            shellOperators: [],
            usesShell: false,
            riskLevel: 'medium',
            decision: 'DENY',
            reason: '',
        },
    };

    const finalize = (decision: SandboxDecision, commandClass: CommandClass, reason: string, parsed?: ParsedCommand): SandboxVerdict => ({
        ...base,
        decision,
        commandClass,
        reason,
        parsed,
        dryRunReport: {
            ...base.dryRunReport,
            executable: parsed?.executable ?? '',
            argumentCount: Math.max(0, (parsed?.args.length ?? 1) - 0),
            shellOperators: parsed?.operators ?? findShellOperators(rawCommand),
            usesShell: parsed?.isBuiltin ?? false,
            riskLevel: classifyRisk(parsed?.operators ?? [], commandClass),
            decision,
            reason,
        },
    });

    if (!rawCommand || !rawCommand.trim()) {
        return finalize('DENY', 'denied', 'empty command');
    }

    // Layer 1: denylist
    const denyHit = scanDenylist(rawCommand);
    if (denyHit) {
        return finalize('DENY', 'denied', `denied pattern "${denyHit.id}": ${denyHit.why}`);
    }

    // Layer 2: parse
    const operators = findShellOperators(rawCommand);
    const tokens = tokenize(rawCommand);
    if (tokens.length === 0) {
        return finalize('DENY', 'denied', 'no tokens after parsing');
    }

    const executableRaw = tokens[0];
    const executableBase = path.basename(executableRaw).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
    const isWin = process.platform === 'win32';
    const isBuiltin = isWin ? WIN_BUILTINS.has(executableBase) : POSIX_BUILTINS.has(executableBase);

    const parsed: ParsedCommand = {
        executable: executableBase,
        args: tokens.slice(1),
        operators,
        isBuiltin,
    };

    // Layer 2b: shell operators force the elevated shell class
    if (operators.length > 0 && !operators.every(o => o === '>' || o === '>>')) {
        // Pipes/chains/substitution are rejected outright: too easy to smuggle.
        return finalize('DENY', 'denied', `shell operators not permitted (${operators.join(', ')})`, parsed);
    }

    // Layer 3: allowlist (plus the narrow URL-opener exception)
    const allow = new Set([...BASE_ALLOWLIST, ...getExtraAllow()]);
    if (!allow.has(executableBase)) {
        // Opening an http(s) URL in the user's browser is a narrow, auditable
        // action — allowed even though `start`/`open` themselves are not on
        // the general allowlist.
        if (isUrlOpenOnly(executableBase, parsed.args)) {
            return finalize('ALLOW', 'safe', 'opens an http(s) URL in the system browser', parsed);
        }
        if (!isBuiltin) {
            return finalize(
                executableBase === 'sudo' || executableBase === 'runas'
                    ? 'DENY'
                    : 'REQUIRE_APPROVAL',
                'shell',
                `"${executableBase}" is not on the executable allowlist`,
                parsed
            );
        }
        // Builtins go through cmd/sh -> elevated risk, need explicit approval
        return finalize('REQUIRE_APPROVAL', 'shell', `shell builtin "${executableBase}" runs through cmd.exe`, parsed);
    }

    // Layer 4: argument sanity — redirect targets must stay inside the jail
    if (operators.some(o => o === '>' || o === '>>')) {
        const lastArg = parsed.args[parsed.args.length - 1] || '';
        if (!isPathInsideAllowedRoots(lastArg.startsWith('/') ? lastArg : path.join(cwd, lastArg), allowedRoots)) {
            return finalize('DENY', 'denied', 'redirect target escapes the working-directory jail', parsed);
        }
    }

    // Layer 5: working-directory jail
    if (!isPathInsideAllowedRoots(cwd, allowedRoots)) {
        return finalize('DENY', 'denied', `working directory ${cwd} is outside the permitted workspace`, parsed);
    }

    const decision: SandboxDecision = 'ALLOW';
    return finalize(decision, 'safe', 'passed all sandbox layers', parsed);
}

function classifyRisk(operators: string[], commandClass: CommandClass): 'low' | 'medium' | 'high' | 'critical' {
    if (commandClass === 'denied') return 'critical';
    if (commandClass === 'shell') return operators.length > 0 ? 'critical' : 'high';
    return 'low';
}

/**
 * Environment allowlisting — strips every variable that could carry secrets
 * (API keys, tokens, passwords) and unusual internals. Keeps the minimum a
 * child toolchain needs to run.
 */
const ENV_ALLOWLIST = new Set([
    // runtime essentials
    'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PUBLIC',
    'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM', 'TERM_PROGRAM',
    'NODE_OPTIONS', 'NODE_ENV', 'FORCE_COLOR', 'CI',
]);

const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|credential|auth)/i;

export function filterEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const filtered: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        if (ENV_ALLOWLIST.has(k.toUpperCase()) && !SECRET_KEY_PATTERN.test(k)) {
            filtered[k] = v;
        }
    }
    return filtered;
}

// Avoid a circular import with security.ts at module-load time.
function Security_getWorkspaceRoot(): string {
    try {
        // Lazy require would break ESM; read the exported static via dynamic
        // import cache instead. In practice security.ts initializes first.
        // Fall back to cwd when unavailable (e.g. unit tests).
        const g = globalThis as any;
        return g.__roseWorkspaceRoot || process.cwd();
    } catch {
        return process.cwd();
    }
}

/** Publish the workspace boundary so the sandbox jail can enforce it. */
export function setWorkspaceBoundary(root: string): void {
    (globalThis as any).__roseWorkspaceRoot = path.resolve(root);
}

function killProcessTree(child: ReturnType<typeof spawn>, platform: string): void {
    try {
        if (platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
            try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

/**
 * Execute a command that has already been approved by evaluateCommand().
 * Prefers shell:false (argv array). Builtins run through the platform shell
 * because they have no standalone executable.
 */
export async function executeApproved(verdict: SandboxVerdict): Promise<SandboxResult> {
    const started = Date.now();
    const parsed = verdict.parsed!;
    const isWin = process.platform === 'win32';

    let file: string;
    let args: string[];
    if (parsed.isBuiltin) {
        file = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
        args = isWin ? ['/d', '/s', '/c', verdict.dryRunReport.command] : ['-c', verdict.dryRunReport.command];
    } else {
        file = parsed.executable;
        args = parsed.args.map(a => a);
    }

    return new Promise<SandboxResult>((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;

        const child = spawn(file, args, {
            cwd: verdict.cwd,
            env: verdict.childEnv,
            shell: false,
            windowsHide: true,
            detached: !isWin, // own process group on POSIX for tree-kill
        });

        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child, process.platform);
        }, verdict.limits.timeoutMs);

        const cap = (chunks: Buffer[], incoming: Buffer, maxBytes: number): Buffer[] => {
            if (stdoutBytes + stderrBytes >= maxBytes) {
                truncated = true;
                child.stdout?.pause();
                child.stderr?.pause();
                return chunks;
            }
            chunks.push(incoming);
            return chunks;
        };

        child.stdout?.on('data', (d: Buffer) => { stdoutBytes += d.length; cap(stdoutChunks, d, verdict.limits.maxOutputBytes); });
        child.stderr?.on('data', (d: Buffer) => { stderrBytes += d.length; cap(stderrChunks, d, verdict.limits.maxOutputBytes); });

        const finish = (exitCode: number | null, signal: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
                exitCode,
                signal,
                durationMs: Date.now() - started,
                truncated,
                timedOut,
            });
        };

        child.on('error', (err) => {
            stderrChunks.push(Buffer.from(`spawn error: ${err.message}`));
            finish(null, 'SPAWN_ERROR');
        });
        child.on('close', (code, signal) => finish(code, signal));
    });
}

/** Convenience wrapper used by the tool layer. */
export interface RunOutcome extends SandboxResult {
    decision: SandboxDecision;
    reason: string;
    auditId: string;
}

export async function runSandboxed(rawCommand: string, options: SandboxOptions = {}): Promise<RunOutcome> {
    const verdict = evaluateCommand(rawCommand, options);
    const auditId = crypto.randomBytes(6).toString('hex');

    if (verdict.decision !== 'ALLOW') {
        return {
            stdout: '',
            stderr: `[sandbox] ${verdict.decision}: ${verdict.reason}`,
            exitCode: null,
            signal: null,
            durationMs: 0,
            truncated: false,
            timedOut: false,
            decision: verdict.decision,
            reason: verdict.reason,
            auditId,
        };
    }

    const result = await executeApproved(verdict);
    return { ...result, decision: 'ALLOW', reason: verdict.reason, auditId };
}
