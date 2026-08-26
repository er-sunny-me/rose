import { Config } from '../config.js';
import { Telemetry } from '../telemetry.js';
import { CostEngine } from '../observability/cost.js';
import type { ModelProvider } from '../router.js';

/**
 * Phase 35 â€” OpenRouter provider.
 *
 * A first-class citizen of the existing provider architecture: same
 * ModelProvider contract as Gemini/Anthropic/OpenAI/Ollama, so health
 * circuit-breaker, fallback ordering, learned preferences, Security/Policy
 * gating of tool calls and observability all work unchanged. OpenRouter is a
 * REMOTE, external service â€” requests remain subject to Policy exactly like
 * every other cloud provider; nothing here bypasses Security.
 */

export type RoseErrorCategory =
    | 'AUTHENTICATION_FAILED'
    | 'INSUFFICIENT_CREDITS'
    | 'INVALID_MODEL'
    | 'RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'TIMEOUT'
    | 'MALFORMED_RESPONSE'
    | 'TOOL_CALL_FAILURE'
    | 'REQUEST_FAILED';

/** Normalized provider error carrying a machine-readable category + human message. */
export class RoseProviderError extends Error {
    constructor(public category: RoseErrorCategory, message: string, public retryAfterMs?: number) {
        super(message);
        this.name = 'RoseProviderError';
    }
}

export interface OpenRouterModelInfo {
    id: string;
    name?: string;
    contextLength?: number;
    supportsTools?: boolean;
    /** Image INPUT support (vision). Never assumed â€” read from the API only. */
    supportsVision?: boolean;
    modality?: string;
    /** USD per token as returned by OpenRouter pricing strings. Undefined when unknown. */
    pricingInputPerToken?: number;
    pricingOutputPerToken?: number;
}

export interface OpenRouterUsage {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    /** Cost in USD as computed by OpenRouter. Only recorded when the API reports it. */
    costUsd?: number;
}

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

function resolveBaseUrl(explicit?: string): string {
    if (explicit) return explicit.replace(/\/$/, '');
    const cfgBase = Config.get().openrouter?.baseUrl;
    if (cfgBase) return cfgBase.replace(/\/$/, '');
    return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

/** Mask an API key for logs/diagnostics/status: prefix + asterisks + suffix. */
export function maskOpenRouterKey(key?: string | null): string {
    if (!key) return '(not configured)';
    if (key.length <= 8) return '*'.repeat(key.length);
    return key.slice(0, 5) + '*'.repeat(8) + key.slice(-4);
}

export class OpenRouterProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    /** Router-level discriminator so offline mode / doctor can identify us. */
    public providerId = 'openrouter';
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;

    /** Remote/external marker consumed by status & privacy-aware UIs (spec 21). */
    public readonly remote = true;

    private baseUrl: string;
    private model: string;

    /** Last normalized usage â€” surfaced by status/diagnostics and tests. */
    public lastUsage: OpenRouterUsage | null = null;
    /** Earliest time the next request is allowed after a Retry-After (rate limit). */
    public retryNotBefore = 0;

    constructor(modelId: string, tier?: string, badge?: string, baseUrl?: string) {
        // Accept both "vendor/model" and rose-style "openrouter/vendor/model".
        const raw = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
        this.model = raw;
        this.baseUrl = resolveBaseUrl(baseUrl);
        this.id = `openrouter/${raw}`;
        this.name = `${raw} (OpenRouter)`;
        this.tier = tier || 'External';
        this.badge = badge;
    }

    public static apiKey(): string | undefined {
        return Config.get().keys?.openrouter || process.env.OPENROUTER_API_KEY || undefined;
    }

    // â”€â”€â”€ Discovery (spec 5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * List models from OpenRouter's public /models endpoint and map them into
     * Rose capability metadata. Returns [] on failure â€” callers must still
     * work when the user names a valid model explicitly.
     */
    static async listModels(baseUrl?: string): Promise<OpenRouterModelInfo[]> {
        const url = resolveBaseUrl(baseUrl);
        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            const key = OpenRouterProvider.apiKey();
            if (key) headers['Authorization'] = `Bearer ${key}`;

            const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(8000) });
            if (!res.ok) return [];
            const data: any = await res.json();

            const models: OpenRouterModelInfo[] = [];
            for (const m of data?.data ?? []) {
                if (!m?.id) continue;
                models.push({
                    id: m.id,
                    name: m.name,
                    contextLength: Number.isFinite(m.context_length) ? m.context_length : undefined,
                    supportsTools: Array.isArray(m.supported_parameters)
                        ? m.supported_parameters.includes('tools')
                        : undefined,
                    supportsVision: Array.isArray(m.architecture?.input_modalities)
                        ? m.architecture.input_modalities.includes('image')
                        : (typeof m.architecture?.modality === 'string'
                            ? m.architecture.modality.split('->').pop()?.includes('image')
                            : undefined),
                    modality: m.architecture?.modality,
                    pricingInputPerToken: OpenRouterProvider.parsePricing(m.pricing?.prompt),
                    pricingOutputPerToken: OpenRouterProvider.parsePricing(m.pricing?.completion),
                });
                OpenRouterProvider.cacheInfo(models[models.length - 1], url);
            }
            return models;
        } catch {
            return [];
        }
    }

    private static parsePricing(v: unknown): number | undefined {
        const n = typeof v === 'string' ? parseFloat(v) : NaN;
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    }

    /** Capability metadata cache shared across instances (per endpoint). */
    private static infoCache = new Map<string, OpenRouterModelInfo>();

    private static cacheKey(modelId: string, baseUrl: string): string {
        return `${baseUrl}::${modelId}`;
    }

    private static cacheInfo(info: OpenRouterModelInfo, baseUrl: string): void {
        OpenRouterProvider.infoCache.set(OpenRouterProvider.cacheKey(info.id, baseUrl), info);
    }

    /** Capability lookup used by router eligibility + UI badges. */
    static getModelInfo(modelId: string): OpenRouterModelInfo | undefined {
        const raw = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
        for (const baseUrl of new Set([resolveBaseUrl(), DEFAULT_BASE])) {
            const hit = OpenRouterProvider.infoCache.get(OpenRouterProvider.cacheKey(raw, baseUrl));
            if (hit) return hit;
        }
        return undefined;
    }

    /** Test-only seam so unit tests can inject discovery metadata. */
    static __setModelInfoForTest(info: OpenRouterModelInfo, baseUrl = DEFAULT_BASE): void {
        OpenRouterProvider.cacheInfo(info, baseUrl);
    }

    // â”€â”€â”€ Request execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {
        if (this.health === 'OPEN') throw new RoseProviderError('PROVIDER_UNAVAILABLE', `Circuit Breaker OPEN for ${this.id}`);

        if (Date.now() < this.retryNotBefore) {
            const waitS = Math.ceil((this.retryNotBefore - Date.now()) / 1000);
            throw new RoseProviderError('RATE_LIMITED', `OpenRouter rate limit active â€” retry in ${waitS}s.`);
        }

        const apiKey = OpenRouterProvider.apiKey();
        if (!apiKey) {
            throw new RoseProviderError('AUTHENTICATION_FAILED',
                "Missing OpenRouter API key. Run 'rose setup' or add keys.openrouter / OPENROUTER_API_KEY.");
        }

        const body: any = {
            model: this.model,
            max_tokens: maxTokens,
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
            ],
            // Ask OpenRouter to compute usage incl. cost when it can (spec 11).
            usage: { include: true },
        };
        if ((roseTools as any)?.responseFormatJson) body.response_format = { type: 'json_object' };

        let res: Response;
        try {
            res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    // OpenRouter attribution headers (recommended convention).
                    'HTTP-Referer': 'https://github.com/er-sunny-me/rose',
                    'X-Title': 'Rose AI Agent Platform',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            });
        } catch (e: any) {
            this.bumpFailures();
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                throw new RoseProviderError('TIMEOUT', `OpenRouter request timed out after 120s.`);
            }
            throw new RoseProviderError('PROVIDER_UNAVAILABLE', `OpenRouter unreachable at ${this.baseUrl}: ${e.message}`);
        }

        if (!res.ok) throw await this.mapHttpError(res);

        let data: any;
        try {
            data = await res.json();
        } catch {
            this.bumpFailures();
            throw new RoseProviderError('MALFORMED_RESPONSE', 'OpenRouter returned non-JSON response body.');
        }

        this.failures = 0;
        this.health = 'HEALTHY';
        return this.normalizeCompletion(data);
    }

    /**
     * Streaming via SSE through the SAME provider contract â€” no second
     * streaming mechanism elsewhere. Deltas stream to `onDelta`; the resolved
     * value matches execute()'s shape so downstream parsers are unchanged.
     */
    async executeStream(
        messages: any[],
        system: string | undefined,
        maxTokens: number,
        onDelta: (text: string) => void,
        options?: { responseFormatJson?: boolean }
    ): Promise<any> {
        const apiKey = OpenRouterProvider.apiKey();
        if (!apiKey) throw new RoseProviderError('AUTHENTICATION_FAILED', "Missing OpenRouter API key.");

        const body: any = {
            model: this.model,
            max_tokens: maxTokens,
            stream: true,
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
            ],
            usage: { include: true },
        };
        if (options?.responseFormatJson) body.response_format = { type: 'json_object' };

        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/er-sunny-me/rose',
                'X-Title': 'Rose AI Agent Platform',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
        });

        if (!res.ok || !res.body) throw await this.mapHttpError(res);

        let content = '';
        let finishReason: string | null = null;
        let usage: any = null;
        let model = this.model;
        const toolAccumulator = new Map<number, { name: string; args: string }>();

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const { events, rest } = OpenRouterProvider.parseSSEChunk(buffer);
            buffer = rest;

            for (const evt of events) {
                if (evt === '[DONE]') continue;
                let parsed: any;
                try { parsed = JSON.parse(evt); } catch { continue; } // tolerate keepalives
                if (parsed.model) model = parsed.model;
                if (parsed.usage) usage = parsed.usage;

                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                    content += delta.content;
                    onDelta(delta.content);
                }
                if (Array.isArray(delta?.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        const acc = toolAccumulator.get(idx) ?? { name: '', args: '' };
                        if (tc.function?.name) acc.name += tc.function.name;
                        if (tc.function?.arguments) acc.args += tc.function.arguments;
                        toolAccumulator.set(idx, acc);
                    }
                }
                if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
            }
        }

        this.failures = 0;
        this.health = 'HEALTHY';

        const synthetic: any = {
            choices: [{
                message: {
                    role: 'assistant',
                    ...(content ? { content } : {}),
                    ...(toolAccumulator.size > 0
                        ? { tool_calls: [...toolAccumulator.entries()].map(([i, a]) => ({ index: i, function: { name: a.name, arguments: a.args } })) }
                        : {}),
                },
                finish_reason: finishReason,
            }],
            usage,
            model,
        };
        return this.normalizeCompletion(synthetic);
    }

    /**
     * Pure SSE parser: splits a buffer into complete `data:` event payloads
     * plus the unconsumed remainder. Unit-tested directly (spec 22).
     */
    static parseSSEChunk(buffer: string): { events: string[]; rest: string } {
        const events: string[] = [];
        const parts = buffer.split('\n');
        let rest = '';
        let current: string[] = [];
        for (const line of parts) {
            if (line.startsWith('data:')) {
                current.push(line.slice(5).trim());
            } else if (line.trim() === '' ) {
                if (current.length > 0) {
                    events.push(current.join('\n'));
                    current = [];
                }
            } else if (line.startsWith(':')) {
                // comment/keepalive â€” ignore
            } else {
                rest += line + '\n'; // incomplete multi-line frame boundary
            }
        }
        if (current.length > 0) rest += 'data:' + current.join('\n');
        return { events, rest };
    }

    // â”€â”€â”€ Normalization: tools, usage, cost â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Normalize an OpenAI-compatible completion into the shared reply shape.
     * Native tool_calls are converted into the project's existing ```tool
     * fenced-block protocol so the EXISTING parser â†’ Security â†’ ToolExecutor
     * path handles them unchanged (spec 7 â€” never bypasses Policy).
     */
    private normalizeCompletion(data: any): any {
        const choice = data.choices?.[0] ?? {};
        const msg = choice.message ?? {};

        let text: string = typeof msg.content === 'string' ? msg.content : '';

        const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const fenced: string[] = [];
        for (const tc of toolCalls) {
            const fnName = tc.function?.name;
            if (!fnName) continue;
            let args: any = {};
            try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments ?? {}); }
            catch {
                // Malformed args become a TOOL_CALL_FAILURE surfaced to the parser loop.
                fenced.push('```tool\n{"name": "__invalid_tool_call", "args": {"error": "malformed tool arguments"}}\n```');
                continue;
            }
            fenced.push('```tool\n' + JSON.stringify({ name: fnName, args }) + '\n```');
        }
        if (fenced.length > 0) {
            text = (text ? text + '\n\n' : '') + fenced.join('\n\n');
        }

        // Usage & cost â€” recorded only with API-provided numbers (spec 11).
        const u = data.usage ?? {};
        const details = u.prompt_tokens_details ?? {};
        const usage: OpenRouterUsage = {
            promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
            completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
            cachedTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined,
            costUsd: typeof u.cost === 'number' ? u.cost : undefined,
        };
        this.lastUsage = usage;

        Telemetry.recordEvent('model.usage', 'model', 'completed', undefined, {
            provider: 'openrouter',
            model: data.model ?? this.id,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            // Costs are never invented â€” absent when API omits them.
            costUsd: usage.costUsd,
        });
        if (typeof usage.costUsd === 'number') {
            CostEngine.recordCost(this.id, 'provider', usage.costUsd, 'USD');
        }

        return {
            content: [{ text }],
            choices: [{ message: { role: 'assistant', content: text }, finish_reason: choice.finish_reason }],
            model: data.model ?? this.id,
            usage,
            provider: 'openrouter',
        };
    }

    // â”€â”€â”€ Error mapping (spec 12) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private async mapHttpError(res: Response): Promise<RoseProviderError> {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* empty body */ }
        // Never echo credentials that might appear in echoed payloads.
        const apiKey = OpenRouterProvider.apiKey();
        if (apiKey) detail = detail.split(apiKey).join(maskOpenRouterKey(apiKey));

        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader
            ? (/^\d+$/.test(retryAfterHeader) ? parseInt(retryAfterHeader, 10) * 1000 : Math.max(0, new Date(retryAfterHeader).getTime() - Date.now()))
            : undefined;

        switch (res.status) {
            case 401:
            case 403:
                this.bumpFailures();
                return new RoseProviderError('AUTHENTICATION_FAILED',
                    `OpenRouter authentication failed (${res.status}). Check your API key â€” currently ${maskOpenRouterKey(apiKey)}.`);
            case 402:
                this.bumpFailures();
                return new RoseProviderError('INSUFFICIENT_CREDITS',
                    'OpenRouter credits/quota exhausted (402). Top up at openrouter.ai/credits.');
            case 404:
                this.bumpFailures();
                return new RoseProviderError('INVALID_MODEL',
                    `OpenRouter model "${this.model}" not found (404). Run \`rose models\` or check openrouter.ai/models. ${detail}`);
            case 429:
                this.bumpFailures();
                if (retryAfterMs && retryAfterMs > 0) this.retryNotBefore = Date.now() + retryAfterMs;
                else this.retryNotBefore = Date.now() + 5000; // conservative default backoff
                return new RoseProviderError('RATE_LIMITED',
                    `OpenRouter rate limited (429).${retryAfterHeader ? ` Retry-After: ${retryAfterHeader}.` : ''}`, retryAfterMs);
            default:
                if (res.status >= 500) {
                    this.bumpFailures();
                    return new RoseProviderError('PROVIDER_UNAVAILABLE', `OpenRouter server error (${res.status}). ${detail}`);
                }
                this.bumpFailures();
                return new RoseProviderError('REQUEST_FAILED', `OpenRouter request failed (${res.status}). ${detail}`);
        }
    }

    private bumpFailures(): void {
        this.failures++;
        if (this.failures > 3) this.health = 'OPEN';
        else this.health = 'DEGRADED';
    }
}

