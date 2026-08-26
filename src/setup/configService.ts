/**
 * Phase 33 â€” Configuration service.
 *
 * The single source of truth for setup state. TUI, plain mode and the CLI all
 * go through this module; no UI writes configuration directly (spec 69-71,
 * 76-79). Flow: Current Config -> Draft -> Validate -> Apply -> Persist.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config, AppConfig } from '../config.js';
import { AppearanceConfig, isValidHexColor } from '../tui/theme.js';

export const VOICE_NAME_OPTIONS = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'] as const;

export const SETUP_VERSION = 1;
export const CONFIGURATION_VERSION = 1;

/** Everything the wizard edits. Kept separate from persisted config until Apply. */
export interface DraftConfig {
    env: AppConfig['env'];
    agentName: string;
    provider: 'gemini' | 'anthropic' | 'openai' | 'proxy' | 'ollama' | 'openrouter';
    model: string;
    geminiKey: string;
    anthropicKey: string;
    openaiKey: string;
    openrouterKey: string;
    proxyUrl: string;
    requireApprovals: boolean;
    allowFederation: boolean;
    autonomy: 'safe' | 'balanced' | 'autonomous';
    webEnabled: boolean;
    webHost: string;
    webPort: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    workspacePath: string;
    // Voice (Gemini Live) preferences
    voiceName: string;
    defaultMic: string;
    screenShare: boolean;
    screenIntervalMs: number;
    memoryLearning: boolean;
    obsidianVaultPath: string;
    maxEntriesPerType: number;
    appearance: AppearanceConfig;
}

/** Load current persistent configuration into an editable draft (spec 61). */
export function loadDraft(): DraftConfig {
    const cfg = Config.get();
    return {
        env: cfg.env === 'production' ? 'production' : 'development',
        agentName: cfg.agent.name || 'Rose',
        provider: cfg.agent.provider || 'proxy',
        model: cfg.agent.model || defaultModelFor(cfg.agent.provider || 'proxy'),
        geminiKey: cfg.keys.gemini || '',
        anthropicKey: cfg.keys.anthropic || '',
        openaiKey: cfg.keys.openai || '',
        openrouterKey: cfg.keys.openrouter || '',
        proxyUrl: cfg.proxy.url || 'http://localhost:8642',
        requireApprovals: cfg.security.requireApprovals !== false,
        allowFederation: cfg.security.allowFederation === true,
        autonomy: cfg.security.autonomy ?? (cfg.security.requireApprovals ? 'balanced' : 'autonomous'),
        webEnabled: cfg.web?.enabled ?? false,
        webHost: cfg.web?.host ?? '127.0.0.1',
        webPort: cfg.web?.port ?? cfg.server.port ?? 3000,
        logLevel: cfg.observability.logLevel || 'info',
        workspacePath: cfg.workspace?.path ?? process.cwd(),
        voiceName: cfg.voice?.voiceName || process.env.VOICE_NAME || 'Puck',
        defaultMic: cfg.voice?.defaultMic || process.env.DEFAULT_MIC || '',
        screenShare: cfg.voice?.screenShare ?? (process.env.ENABLE_SCREEN_SHARE === 'true'),
        screenIntervalMs: cfg.voice?.screenIntervalMs ?? parseInt(process.env.SCREEN_CAPTURE_INTERVAL_MS || '2000', 10),
        memoryLearning: cfg.memory?.learningEnabled !== false,
        obsidianVaultPath: cfg.memory?.obsidianVaultPath ?? '',
        maxEntriesPerType: cfg.memory?.maxEntriesPerType ?? 500,
        appearance: {
            theme: cfg.appearance?.theme ?? 'roseDark',
            accent: cfg.appearance?.accent ?? 'rose',
            accentHex: cfg.appearance?.accentHex,
            density: cfg.appearance?.density ?? 'comfortable',
            animations: cfg.appearance?.animations ?? 'enabled',
            unicode: cfg.appearance?.unicode ?? 'auto',
            highContrast: cfg.appearance?.highContrast ?? false,
        },
    };
}

export function defaultModelFor(provider: DraftConfig['provider']): string {
    switch (provider) {
        case 'gemini': return 'gemini-2.0-flash';
        case 'anthropic': return 'claude-3-5-sonnet-20241022';
        case 'openai': return 'gpt-4o';
        // Rose-style provider prefix; OpenRouter discovery refines this list live.
        case 'openrouter': return 'openrouter/anthropic/claude-3.5-sonnet';
        default: return 'claude-sonnet-4-6';
    }
}

// â”€â”€â”€ Validation (spec 62-63) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type FieldKey =
    | 'agentName' | 'model' | 'proxyUrl'
    | 'geminiKey' | 'anthropicKey' | 'openaiKey' | 'openrouterKey'
    | 'webHost' | 'webPort'
    | 'workspacePath' | 'obsidianVaultPath' | 'maxEntriesPerType'
    | 'voiceName' | 'screenIntervalMs';

export function validateField(draft: DraftConfig, key: FieldKey): string | null {
    switch (key) {
        case 'agentName':
            if (!draft.agentName.trim()) return 'Agent name is required.';
            if (draft.agentName.length > 40) return 'Keep the name under 40 characters.';
            return null;
        case 'model':
            if (!draft.model.trim()) return 'A model id is required.';
            return null;
        case 'proxyUrl': {
            if (!/^https?:\/\//.test(draft.proxyUrl)) return 'Proxy URL must start with http:// or https://';
            try { new URL(draft.proxyUrl); } catch { return 'Proxy URL is not a valid URL.'; }
            return null;
        }
        case 'geminiKey':
            if (!draft.geminiKey) return null; // optional unless selected
            if (draft.geminiKey.length < 20) return 'That key looks too short to be a Gemini API key.';
            return null;
        case 'anthropicKey':
            if (!draft.anthropicKey && draft.provider === 'anthropic') return 'An Anthropic API key is required for this provider.';
            return null;
        case 'openaiKey':
            if (!draft.openaiKey && draft.provider === 'openai') return 'An OpenAI API key is required for this provider.';
            return null;
        case 'voiceName':
            return VOICE_NAME_OPTIONS.includes(draft.voiceName as any) ? null : 'Pick one of the listed voices.';
        case 'screenIntervalMs': {
            const n = Number(draft.screenIntervalMs);
            if (!Number.isInteger(n) || n < 500 || n > 60000) return 'Screen interval must be 500-60000 ms.';
            return null;
        }
        case 'openrouterKey':
            if (!draft.openrouterKey && draft.provider === 'openrouter') return 'An OpenRouter API key is required for this provider.';
            return null;
        case 'webHost':
            if (draft.webHost !== '127.0.0.1' && draft.webHost !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(draft.webHost)) {
                return 'Use a valid IP address or hostname.';
            }
            if (draft.webHost === '0.0.0.0') return 'Binding to all interfaces is not recommended. Use 127.0.0.1.';
            return null;
        case 'webPort': {
            const p = Number(draft.webPort);
            if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be between 1 and 65535.';
            return null;
        }
        case 'workspacePath':
            return validateDirectoryPath(draft.workspacePath);
        case 'obsidianVaultPath':
            if (!draft.obsidianVaultPath) return null;
            return validateDirectoryPath(draft.obsidianVaultPath);
        case 'maxEntriesPerType': {
            const n = Number(draft.maxEntriesPerType);
            if (!Number.isInteger(n) || n < 10 || n > 100000) return 'Retention must be between 10 and 100000.';
            return null;
        }
    }
}

function validateDirectoryPath(p: string): string | null {
    if (!p.trim()) return 'A path is required.';
    const expanded = expandTilde(p.trim());
    if (path.isAbsolute(expanded)) return null;
    return 'Enter an absolute path.';
}

export function validateAll(draft: DraftConfig): Map<FieldKey, string> {
    const keys: FieldKey[] = [
        'agentName', 'model', 'proxyUrl', 'geminiKey', 'anthropicKey', 'openaiKey', 'openrouterKey', 'voiceName', 'screenIntervalMs',
        'webHost', 'webPort', 'workspacePath', 'obsidianVaultPath', 'maxEntriesPerType',
    ];
    const errors = new Map<FieldKey, string>();
    for (const k of keys) {
        const err = validateField(draft, k);
        if (err) errors.set(k, err);
    }
    // Provider-specific requirement
    if (draft.provider === 'gemini' && !draft.geminiKey && !envCredentialDetected('gemini')) {
        errors.set('geminiKey', 'Gemini requires an API key.');
    }
    return errors;
}

export function envCredentialDetected(provider: 'gemini' | 'anthropic' | 'openai' | 'openrouter'): boolean {
    switch (provider) {
        case 'gemini': return Boolean(process.env.GEMINI_API_KEY);
        case 'anthropic': return Boolean(process.env.ANTHROPIC_API_KEY);
        case 'openai': return Boolean(process.env.OPENAI_API_KEY);
        case 'openrouter': return Boolean(process.env.OPENROUTER_API_KEY);
    }
}

// â”€â”€â”€ Path helpers (cross-platform, spec 21) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function expandTilde(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/' ) || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

export function resolveWorkspacePath(p: string): string {
    return path.resolve(expandTilde(p.trim()));
}

export interface ProjectDetection {
    detected: boolean;
    name?: string;
    kind?: string;
}

/** Detect a project in a directory without modifying anything (spec 22). */
export function detectProject(dir: string): ProjectDetection {
    try {
        const abs = resolveWorkspacePath(dir);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { detected: false };
        const has = (f: string) => fs.existsSync(path.join(abs, f));
        if (has('package.json')) {
            let name = path.basename(abs);
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
                if (typeof pkg.name === 'string') name = pkg.name;
            } catch { /* unreadable package.json still counts as a project */ }
            return { detected: true, name, kind: 'npm project' };
        }
        if (has('.git')) return { detected: true, name: path.basename(abs), kind: 'git repository' };
        if (has('.rose') || has('gemini.config.json')) return { detected: true, name: path.basename(abs), kind: 'Rose workspace' };
        return { detected: false };
    } catch {
        return { detected: false };
    }
}

// â”€â”€â”€ Setup state / first-run detection (spec 2, 45-46) â”€â”€â”€â”€â”€â”€

const CONFIG_FILE = () => path.join(Config.getGlobalDir(), 'config.json');

export function configFileExists(): boolean {
    return fs.existsSync(CONFIG_FILE());
}

/**
 * True when the user has completed setup at least once. Existing pre-Phase-33
 * installations with a usable configuration are migrated automatically so the
 * wizard never re-opens for them (spec 46).
 */
export function hasCompletedSetup(): boolean {
    if (!configFileExists()) {
        // Environment credentials alone count as configured (CI users).
        return Boolean(
            (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)
        );
    }
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
        if (raw.setup?.completedAt) return true;
        // Migration heuristic: any explicit provider choice in an existing file.
        if (raw.agent?.provider || raw.proxy?.url) return true;
        return false;
    } catch {
        return false; // corrupt config -> treat as needing setup (it will back up first)
    }
}

export function needsSetupMigration(): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
        return Boolean(raw.setup) && Number(raw.setup.version) < SETUP_VERSION;
    } catch {
        return false;
    }
}

// â”€â”€â”€ Diff (spec 37) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ConfigChange {
    label: string;
    before: string;
    after: string;
}

/** Human-readable diff of persisted vs draft values. Secrets are masked. */
export function diffAgainstCurrent(draft: DraftConfig): ConfigChange[] {
    const cur = Config.get();
    const changes: ConfigChange[] = [];

    const push = (label: string, before: unknown, after: unknown) => {
        const b = String(before ?? '');
        const a = String(after ?? '');
        if (b !== a) changes.push({ label, before: b, after: a });
    };

    push('Provider', cur.agent.provider, draft.provider);
    push('Model', cur.agent.model, draft.model);
    push('Gemini key', maskSecret(cur.keys.gemini), maskSecret(draft.geminiKey));
    push('Anthropic key', maskSecret(cur.keys.anthropic), maskSecret(draft.anthropicKey));
    push('OpenAI key', maskSecret(cur.keys.openai), maskSecret(draft.openaiKey));
    push('OpenRouter key', maskSecret(cur.keys.openrouter), maskSecret(draft.openrouterKey));
    push('Proxy URL', cur.proxy.url, draft.proxyUrl);
    push('Autonomy', cur.security.autonomy ?? (cur.security.requireApprovals ? 'balanced' : 'balanced'), draft.autonomy);
    push('Web panel', cur.web?.enabled === true ? `on (${cur.web.host ?? '127.0.0.1'}:${cur.web.port ?? cur.server.port})` : 'off',
        draft.webEnabled ? `${draft.webHost}:${draft.webPort}` : 'off');
    push('Theme', cur.appearance?.theme ?? 'roseDark', draft.appearance.theme);
    push('Accent', cur.appearance?.accent ?? 'rose', draft.appearance.accent + (draft.appearance.accentHex ? ` ${maskSecret(draft.appearance.accentHex)}` : ''));
    push('Density', cur.appearance?.density ?? 'comfortable', draft.appearance.density);
    push('Animations', cur.appearance?.animations ?? 'enabled', draft.appearance.animations);
    push('Workspace', cur.workspace?.path ?? '(not set)', draft.workspacePath);
    push('Obsidian vault', maskSecret(cur.memory?.obsidianVaultPath), maskSecret(draft.obsidianVaultPath));
    push('Learning memory', cur.memory?.learningEnabled === false ? 'disabled' : 'enabled', draft.memoryLearning ? 'enabled' : 'disabled');
    push('Log level', cur.observability.logLevel, draft.logLevel);

    return changes;
}

/** Mask any secret-ish value for display: keep at most a short prefix. */
export function maskSecret(value?: string | null): string {
    if (!value) return '(not set)';
    if (value.length <= 6) return '*'.repeat(value.length);
    return value.slice(0, 3) + '*'.repeat(Math.min(12, value.length - 4)) + value.slice(-2);
}

// â”€â”€â”€ Apply pipeline (spec 38, 40, 70-71) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ApplyResult {
    ok: boolean;
    error?: string;
    backupPath?: string;
    rolledBack?: boolean;
}

/**
 * Validate -> backup -> atomic write -> verify -> rollback on failure.
 * Memory vaults, learning data and projects are NEVER touched here:
 * this only rewrites ~/.rose/config.json (spec 4).
 */
export async function applyDraft(draft: DraftConfig): Promise<ApplyResult> {
    const errors = validateAll(draft);
    if (errors.size > 0) {
        const first = errors.values().next().value as string | undefined;
        return { ok: false, error: `Configuration is invalid: ${first ?? 'unknown field error'}` };
    }

    const globalDir = Config.getGlobalDir();
    const configPath = path.join(globalDir, 'config.json');
    const backupPath = path.join(globalDir, 'backups', `config-pre-apply.json`);

    let hadExisting = fs.existsSync(configPath);
    if (hadExisting) {
        try {
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.copyFileSync(configPath, backupPath);
        } catch (e: any) {
            return { ok: false, error: `Could not back up existing configuration: ${e.message}` };
        }
    }

    // Build next config on top of current values so untouched fields survive.
    const next = buildPersistedConfig(draft);

    // Perf fix: the versioned setup-completion marker is embedded in the SAME
    // atomic write instead of a second full-file write right after.
    next.setup = {
        version: SETUP_VERSION,
        completedAt: next.setup?.completedAt ?? new Date().toISOString(),
        configurationVersion: CONFIGURATION_VERSION,
    };

    // Atomic write: temp file then rename (crash-safe, spec 40).
    try {
        fs.mkdirSync(globalDir, { recursive: true });
        const tmp = configPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(tmp, configPath);
    } catch (e: any) {
        return { ok: false, error: `Failed to write configuration: ${e.message}`, rolledBack: false };
    }

    // Verify by re-parsing from disk.
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed.agent?.provider !== draft.provider) throw new Error('verification mismatch');
    } catch (e: any) {
        // Rollback (spec 71): restore the previous valid configuration.
        if (hadExisting && fs.existsSync(backupPath)) {
            try {
                const tmp = configPath + '.restore';
                fs.copyFileSync(backupPath, tmp);
                fs.renameSync(tmp, configPath);
            } catch { /* best effort */ }
        } else {
            try { fs.unlinkSync(configPath); } catch { /* ignore */ }
        }
        Config.reload();
        return { ok: false, error: `Verification failed (${e.message}). Configuration was not changed.`, rolledBack: true };
    }

    Config.reload();
    return { ok: true, backupPath: hadExisting ? backupPath : undefined };
}

/** Convert a draft into the full persisted configuration shape. */
export function buildPersistedConfig(draft: DraftConfig): AppConfig {
    const cur = Config.get();
    const cfg: AppConfig = JSON.parse(JSON.stringify(cur)); // deep clone current

    cfg.env = draft.env;
    cfg.agent.name = draft.agentName.trim() || 'Rose';
    cfg.agent.model = draft.model;
    cfg.agent.provider = draft.provider;

    cfg.keys = cfg.keys || {};
    if (draft.geminiKey) cfg.keys.gemini = draft.geminiKey; else delete cfg.keys.gemini;
    if (draft.anthropicKey) cfg.keys.anthropic = draft.anthropicKey; else delete cfg.keys.anthropic;
    if (draft.openaiKey) cfg.keys.openai = draft.openaiKey; else delete cfg.keys.openai;
    if (draft.openrouterKey) cfg.keys.openrouter = draft.openrouterKey; else delete cfg.keys.openrouter;

    cfg.proxy.enabled = draft.provider === 'proxy';
    cfg.proxy.url = draft.proxyUrl;

    cfg.security.requireApprovals = draft.autonomy !== 'autonomous';
    cfg.security.allowFederation = draft.allowFederation;
    cfg.security.autonomy = draft.autonomy;

    cfg.server.port = draft.webPort;
    cfg.observability.logLevel = draft.logLevel;

    cfg.voice = { voiceName: draft.voiceName, defaultMic: draft.defaultMic, screenShare: draft.screenShare, screenIntervalMs: draft.screenIntervalMs };
    cfg.workspace = { ...(cfg.workspace || {}), path: resolveWorkspacePath(draft.workspacePath) };
    cfg.memory = {
        learningEnabled: draft.memoryLearning,
        obsidianVaultPath: draft.obsidianVaultPath ? resolveWorkspacePath(draft.obsidianVaultPath) : undefined,
        maxEntriesPerType: draft.maxEntriesPerType,
    };
    cfg.appearance = draft.appearance;
    cfg.web = { enabled: draft.webEnabled, host: draft.webHost, port: draft.webPort };

    return cfg;
}

/** Versioned completion marker (spec 45). Never a bare boolean. */
export function markSetupComplete(): void {
    const cfg = Config.get();
    cfg.setup = {
        version: SETUP_VERSION,
        completedAt: new Date().toISOString(),
        configurationVersion: CONFIGURATION_VERSION,
    };
    persistSetupState(cfg);
}

export function clearSetupState(): void {
    const cfg = Config.get();
    delete cfg.setup;
    persistSetupState(cfg);
}

function persistSetupState(cfg: AppConfig): void {
    const globalDir = Config.getGlobalDir();
    fs.mkdirSync(globalDir, { recursive: true });
    const configPath = path.join(globalDir, 'config.json');
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
}

