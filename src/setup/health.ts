/**
 * Phase 33 â€” Shared health-check suite (spec 41-43, 74).
 *
 * Used by BOTH the TUI Health Check screen and `rose doctor`. There is exactly
 * one diagnostic engine; every check reports what it actually verified and
 * never fakes success.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Config } from '../config.js';

export type CheckState = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
    id: string;
    label: string;
    state: CheckState;
    detail: string;
    fixHint?: string;
}

export interface HealthRunOptions {
    /** Probe the primary provider over the network (Test Connection / final check). */
    probeProvider?: boolean;
    /** Also check web panel port availability. */
    checkWebPort?: boolean;
    /** Abort signal for long-running probes. */
    signal?: AbortSignal;
    /** Live progress callback so UIs can show which check is running. */
    onProgress?: (label: string) => void;
}

const FETCH_TIMEOUT_MS = 4500;

export async function runHealthChecks(opts: HealthRunOptions = {}): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const cfg = Config.get();
    const progress = (label: string) => opts.onProgress?.(label);

    // Perf fix: start the network probe IMMEDIATELY and run local checks
    // while it is in flight — wall time ≈ max(local, probe) instead of sum.
    const probePromise: Promise<CheckResult> | null = opts.probeProvider
        ? probePrimaryProvider(opts.signal)
        : null;

    // 1. Configuration integrity
    progress('Checking configuration...');
    try {
        const raw = fs.readFileSync(path.join(Config.getGlobalDir(), 'config.json'), 'utf8');
        JSON.parse(raw);
        results.push({
            id: 'configuration', label: 'Configuration', state: 'pass',
            detail: `${Config.getGlobalDir()}${path.sep}config.json`,
        });
    } catch (e: any) {
        results.push({
            id: 'configuration', label: 'Configuration',
            state: cfg.agent?.provider ? 'warn' : 'fail',
            detail: e.code === 'ENOENT' ? 'No config file yet â€” defaults in use.' : `Unreadable: ${e.message}`,
            fixHint: 'Run `rose setup` to create a valid configuration.',
        });
    }

    // 2. Workspace
    progress('Checking workspace...');
    const ws = cfg.workspace?.path || process.cwd();
    try {
        fs.accessSync(ws, fs.constants.W_OK);
        results.push({ id: 'workspace', label: 'Workspace', state: 'pass', detail: ws });
    } catch {
        results.push({
            id: 'workspace', label: 'Workspace', state: 'fail',
            detail: `${ws} is not writable`, fixHint: 'Pick another workspace in `rose setup`.',
        });
    }

    // 3. Memory vault
    progress('Checking memory...');
    const vaultDir = path.join(process.cwd(), 'memory', 'vault');
    try {
        fs.mkdirSync(vaultDir, { recursive: true });
        fs.accessSync(vaultDir, fs.constants.W_OK);
        const count = countMarkdownFiles(vaultDir);
        results.push({ id: 'memory', label: 'Memory', state: 'pass', detail: `${count} entries in memory/vault` });
    } catch (e: any) {
        results.push({
            id: 'memory', label: 'Memory', state: 'fail', detail: `Vault not writable: ${e.message}`,
            fixHint: 'Check permissions on the working directory.',
        });
    }

    // 4. Event store
    progress('Checking event store...');
    const eventsDir = path.join(process.cwd(), '.gemini', 'events');
    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.accessSync(eventsDir, fs.constants.W_OK);
        const logFile = path.join(eventsDir, 'runtime.jsonl');
        const events = fs.existsSync(logFile)
            ? fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim()).length
            : 0;
        results.push({ id: 'eventstore', label: 'Event Store', state: 'pass', detail: `${events} durable events` });
    } catch (e: any) {
        results.push({
            id: 'eventstore', label: 'Event Store', state: 'fail', detail: `Not writable: ${e.message}`,
            fixHint: 'Rose records every action here; fix directory permissions.',
        });
    }

    // 5. Security engine self-test
    progress('Checking security...');
    try {
        const { SecurityEngine } = await import('../security.js');
        const sample = 'token ghp_abcdefghijklmnopqrstuvwxyz012345';
        const redacted = SecurityEngine.redactSecrets(sample);
        const ok = !redacted.includes('ghp_abcdefghijklmnop');
        results.push({
            id: 'security', label: 'Security',
            state: ok ? 'pass' : 'fail',
            detail: `Autonomy: ${SecurityEngine.autonomyMode}${ok ? ', secret redaction verified' : ', REDACTION SELF-TEST FAILED'}`,
            fixHint: ok ? undefined : 'Report this issue â€” outputs may leak secrets.',
        });
    } catch (e: any) {
        results.push({ id: 'security', label: 'Security', state: 'fail', detail: `Engine error: ${e.message}` });
    }

    // 6. Providers configured (no network)
    progress('Checking providers...');
    const hasKey = Boolean(cfg.keys.gemini || cfg.keys.anthropic || cfg.keys.openai || cfg.keys.openrouter);
    const proxyConfigured = cfg.agent.provider === 'proxy' || cfg.proxy.enabled;
    if (hasKey || proxyConfigured) {
        const which = [
            cfg.keys.gemini && 'Gemini',
            cfg.keys.anthropic && 'Anthropic',
            cfg.keys.openai && 'OpenAI',
            (cfg.keys.openrouter || process.env.OPENROUTER_API_KEY) && 'OpenRouter',
            proxyConfigured && 'Proxy',
        ].filter(Boolean).join(', ');
        results.push({ id: 'providers', label: 'Agent Runtime', state: 'pass', detail: `Providers configured: ${which}` });
    } else {
        results.push({
            id: 'providers', label: 'Agent Runtime', state: 'warn',
            detail: 'No provider configured yet',
            fixHint: 'Configure an AI provider in `rose setup`.',
        });
    }

    // 7. Live provider probe (already running in parallel — just await it)
    if (probePromise) {
        progress('Probing provider (network)...');
        results.push(await probePromise);
    }

    // 8. Tool registry (real count from the live registry)
    progress('Checking tool registry...');
    try {
        const { ToolRegistry } = await import('../tools.js');
        const count = ToolRegistry.getDeclarations().length;
        results.push({
            id: 'tools', label: 'Tool Registry',
            state: count > 0 ? 'pass' : 'warn',
            detail: `${count} tools registered`,
            fixHint: count > 0 ? undefined : 'Check extensions/MCP configuration.',
        });
    } catch (e: any) {
        results.push({ id: 'tools', label: 'Tool Registry', state: 'fail', detail: `Registry error: ${e.message}` });
    }

    // 9. Web control panel port
    if (opts.checkWebPort && cfg.web?.enabled) {
        const host = cfg.web.host || '127.0.0.1';
        const port = cfg.web.port || cfg.server.port || 3000;
        const free = await isPortFree(port, host);
        results.push({
            id: 'web', label: 'Web Control Panel',
            state: free ? 'pass' : 'warn',
            detail: `${host}:${port} ${free ? 'is available' : 'is already in use'}`,
            fixHint: free ? undefined : 'Choose another port in `rose setup`.',
        });
    }

    return results;
}

/** Overall readiness: required components must pass; warns degrade honestly (spec 42-43). */
export function summarize(results: CheckResult[]): { ready: boolean; degraded: boolean; failures: CheckResult[] } {
    const required = ['configuration', 'workspace', 'memory', 'eventstore', 'security'];
    const failedRequired = results.filter(r => required.includes(r.id) && r.state === 'fail');
    const warnings = results.filter(r => r.state === 'warn');
    return {
        ready: failedRequired.length === 0,
        degraded: failedRequired.length === 0 && warnings.length > 0,
        failures: [...failedRequired, ...warnings],
    };
}

/**
 * Probe the currently selected provider. Reports exactly what was checked;
 * a failure never becomes a pass (spec 19, 99).
 */
export async function probePrimaryProvider(signal?: AbortSignal): Promise<CheckResult> {
    const cfg = Config.get();
    return probeProvider({
        provider: cfg.agent.provider,
        model: cfg.agent.model,
        geminiKey: cfg.keys.gemini,
        anthropicKey: cfg.keys.anthropic,
        openaiKey: cfg.keys.openai,
        proxyUrl: cfg.proxy.url,
    }, signal);
}

export interface ProviderProbeInput {
    provider: 'gemini' | 'anthropic' | 'openai' | 'proxy' | 'ollama' | 'openrouter';
    model?: string;
    geminiKey?: string;
    anthropicKey?: string;
    openaiKey?: string;
    openrouterKey?: string;
    proxyUrl?: string;
}

/** Parametric probe so the wizard can test *draft* credentials before saving. */
export async function probeProvider(input: ProviderProbeInput, signal?: AbortSignal): Promise<CheckResult> {
    const { provider } = input;
    try {
        switch (provider) {
            case 'gemini': {
                const key = input.geminiKey;
                if (!key) {
                    return failProbe(provider, 'No Gemini API key configured.', 'Add your key in `rose setup`.');
                }
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`, {
                    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) {
                    const body = await safeErrorBody(res);
                    if (res.status === 400 || res.status === 401 || res.status === 403) {
                        return failProbe(provider, `Authentication failed (${res.status}).`, 'Check your Gemini API key.');
                    }
                    return failProbe(provider, `Gemini API returned ${res.status}: ${body}`);
                }
                const data: any = await res.json();
                const models: string[] = (data.models || []).map((m: any) => String(m.name || '').replace('models/', ''));
                const model = input.model || '';
                const selectedOk = models.includes(model);
                const liveAvailable = models.some(m => m.toLowerCase().includes('live'));
                const details: string[] = [
                    'authentication ok',
                    selectedOk ? `model ${model} available` : `model ${model} NOT found`,
                    liveAvailable ? 'live-capable model present' : 'no live-capable model visible',
                ];
                return {
                    id: 'provider-probe', label: PROVIDER_LABELS[provider],
                    state: selectedOk ? 'pass' : 'warn',
                    detail: details.join('; '),
                    fixHint: selectedOk ? undefined : 'Set a valid Gemini model.',
                };
            }
            case 'anthropic': {
                const key = input.anthropicKey;
                if (!key) return failProbe(provider, 'No Anthropic API key configured.', 'Add your key in `rose setup`.');
                const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
                    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) {
                    if (res.status === 401) return failProbe(provider, 'Authentication failed (401).', 'Check your Anthropic API key.');
                    return failProbe(provider, `Anthropic API returned ${res.status}.`);
                }
                return passProbe(provider, 'authentication ok, models endpoint reachable');
            }
            case 'openai': {
                const key = input.openaiKey;
                if (!key) return failProbe(provider, 'No OpenAI API key configured.', 'Add your key in `rose setup`.');
                const res = await fetch('https://api.openai.com/v1/models', {
                    headers: { Authorization: `Bearer ${key}` },
                    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) {
                    if (res.status === 401) return failProbe(provider, 'Authentication failed (401).', 'Check your OpenAI API key.');
                    return failProbe(provider, `OpenAI API returned ${res.status}.`);
                }
                return passProbe(provider, 'authentication ok, models endpoint reachable');
            }
            case 'openrouter': {
                const key = input.openrouterKey;
                if (!key) return failProbe(provider, 'No OpenRouter API key configured.', 'Add your key in `rose setup`.');
                const base = (Config.get().openrouter?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
                const res = await fetch(`${base}/models`, {
                    headers: { Authorization: `Bearer ${key}` },
                    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) {
                    if (res.status === 401 || res.status === 403) {
                        return failProbe(provider, `Authentication failed (${res.status}).`, 'Check your OpenRouter API key.');
                    }
                    if (res.status === 402) {
                        return failProbe(provider, 'Credits/quota exhausted (402).', 'Top up at openrouter.ai/credits.');
                    }
                    return failProbe(provider, `OpenRouter API returned ${res.status}.`);
                }
                try {
                    const data: any = await res.json();
                    const models: any[] = data?.data ?? [];
                    // The configured model may be rose-prefixed ("openrouter/vendor/model").
                    const wanted = (input.model || '').replace(/^openrouter\//, '');
                    const found = models.find(m => m.id === wanted);
                    if (wanted && !found) {
                        return {
                            id: 'provider-probe', label: PROVIDER_LABELS[provider],
                            state: 'warn',
                            detail: `authentication ok; model "${wanted}" not found in catalog (${models.length} models)`,
                            fixHint: 'Pick a valid model in `rose setup` or via discovery.',
                        };
                    }
                    const ctx = found?.context_length ? `, ${Math.round(found.context_length / 1000)}k context` : '';
                    const tools = Array.isArray(found?.supported_parameters) && found.supported_parameters.includes('tools') ? ', tool calling' : '';
                    return passProbe(provider, `authentication ok; model ${wanted} available${ctx}${tools}`);
                } catch {
                    return passProbe(provider, 'authentication ok (catalog unreadable)');
                }
            }
            case 'proxy':
            default: {
                const url = (input.proxyUrl || 'http://localhost:8642').replace(/\/$/, '');
                const res = await fetch(`${url}/v1/models`, {
                    signal: signal ?? AbortSignal.timeout(3000),
                }).catch(() => null);
                if (!res || !res.ok) {
                    return failProbe(provider, `Proxy not reachable at ${url}.`, 'Start antigravity-proxy-ai or pick a direct provider.');
                }
                return passProbe(provider, `proxy reachable at ${url}, models listed`);
            }
        }
    } catch (e: any) {
        if (e.name === 'AbortError' || e.name === 'TimeoutError') {
            return failProbe(provider, `Connection timed out after ${FETCH_TIMEOUT_MS}ms.`);
        }
        return failProbe(provider, `Network error: ${e.message}`, 'Check your internet connection.');
    }
}

const PROVIDER_LABELS: Record<string, string> = {
    gemini: 'Gemini',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    proxy: 'Antigravity Proxy',
};

function passProbe(id: string, detail: string): CheckResult {
    return { id: 'provider-probe', label: PROVIDER_LABELS[id] ?? id, state: 'pass', detail };
}
function failProbe(id: string, detail: string, fixHint?: string): CheckResult {
    return { id: 'provider-probe', label: PROVIDER_LABELS[id] ?? id, state: 'fail', detail, fixHint };
}

async function safeErrorBody(res: Response): Promise<string> {
    try {
        const text = await res.text();
        return text.slice(0, 200);
    } catch {
        return '(no body)';
    }
}

/** True when nothing is listening on host:port right now. */
export function isPortFree(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => {
            srv.close(() => resolve(true));
        });
        try {
            srv.listen(port, host);
        } catch {
            resolve(false);
        }
    });
}

/** Suggest the next available port starting from `start` (spec 34). */
export async function findFreePort(start: number, host: string, maxTries = 50): Promise<number | null> {
    for (let p = start; p < start + maxTries; p++) {
        if (await isPortFree(p, host)) return p;
    }
    return null;
}

function countMarkdownFiles(dir: string): number {
    let count = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) count += countMarkdownFiles(full);
            else if (entry.name.endsWith('.md')) count++;
        }
    } catch { /* unreadable subtree */ }
    return count;
}


