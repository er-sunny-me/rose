import { Telemetry } from './telemetry.js';
import { Secrets } from './security/secrets.js';
import { sseLines, jsonLines, type StreamChunk } from './providers/stream.js';
import chalk from 'chalk';
import { PreferenceManager } from './learning.js';
import { FailureInjector } from './reliability/injector.js';
import { Config } from './config.js';

export interface ModelRequirements {
    /** Phase 36 fix: Rose tool declarations passed through to providers. */
    tools?: any[];
    capabilities?: string[];
    maxTokens?: number;
    intent?: string;
    preferredModelId?: string;
}

export interface ModelProvider {
    /** Optional SSE streaming; routers fall back to buffered execute(). */
    stream?(messages: any[], system?: string, maxTokens?: number): AsyncGenerator<any>;
    id: string;
    name: string;
    tier?: string;
    badge?: string;
    providerId?: string;
    health: 'HEALTHY' | 'DEGRADED' | 'OPEN';
    failures: number;
    
    execute(messages: any[], system?: string, maxTokens?: number, roseTools?: any[]): Promise<any>;
}

/** Convert Rose uppercase-type declarations to JSON-Schema (OpenAI/Anthropic). */
function toJsSchema(params: any): any {
    if (!params) return { type: 'object', properties: {} };
    const walk = (node: any): any => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            const out: any = {};
            for (const [k, v] of Object.entries(node)) {
                out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : walk(v);
            }
            return out;
        }
        return node;
    };
    const copy = walk(params);
    if (!copy.properties) copy.properties = {};
    return copy;
}

// â”€â”€â”€ Google Gemini (Direct REST API) â”€â”€â”€
export class GeminiProvider implements ModelProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    public providerId?: string;
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;

    constructor(id: string, name: string, tier?: string, badge?: string, providerId?: string) {
        this.id = id;
        this.name = name;
        this.tier = tier;
        this.badge = badge;
        this.providerId = providerId || id;
    }

    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);
        
        if (FailureInjector.isActive('provider_outage')) {
            this.failures++;
            if (this.failures >= 3) this.health = 'OPEN';
            throw new Error(`[Lab] Simulated provider outage for ${this.id}`);
        }

        const apiKey = await Secrets.get('gemini-api-key', Config.get().keys?.gemini) ?? undefined;
        if (!apiKey) {
            throw new Error("Missing Gemini API Key. Run 'rose setup' or add keys.gemini in ~/.rose/config.json");
        }

        try {
            const contents = messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : m.role,
                parts: [{ text: m.content }]
            }));

            const body: any = {
                contents,
                generationConfig: { maxOutputTokens: maxTokens }
            };

            if (system) {
                body.systemInstruction = { parts: [{ text: system }] };
            }

            if (roseTools && roseTools.length > 0) {
                body.tools = [{ functionDeclarations: roseTools.map((t: any) => ({ name: t.name, description: t.description, parameters: toJsSchema(t.parameters) })) }];
            }

            const modelName = this.providerId || 'gemini-2.0-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Gemini API Error: ${text}`);
            }

            const data: any = await response.json();
            const parts = data.candidates?.[0]?.content?.parts || [];
            const resultText = parts.map((p: any) => p.text || '').join('');
            
            this.failures = 0;
            this.health = 'HEALTHY';
            
            // Return raw parts so functionCall entries are visible to the tool loop
            return {
                content: parts,
                choices: [{ message: { content: resultText } }]
            };
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw e;
        }
    }

    /** Gemini SSE streaming (streamGenerateContent). */
    public async *stream(messages: any[], system?: string, maxTokens: number = 8192): AsyncGenerator<any> {
        const apiKey = await Secrets.get('gemini-api-key', Config.get().keys?.gemini) ?? undefined;
        if (!apiKey) throw new Error('Missing Gemini API Key for streaming.');

        const contents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : m.role,
            parts: [{ text: m.content }]
        }));
        const body: any = { contents, generationConfig: { maxOutputTokens: maxTokens } };
        if (system) body.systemInstruction = { parts: [{ text: system }] };

        const modelName = this.providerId || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok || !response.body) throw new Error(`Gemini stream error ${response.status}`);

        for await (const payload of sseLines(response.body)) {
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) yield text;
            } catch { /* partial frames are skipped */ }
        }
        this.failures = 0;
        this.health = 'HEALTHY';
    }
}

// â”€â”€â”€ Anthropic Claude (Direct REST API) â”€â”€â”€
export class AnthropicProvider implements ModelProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    public providerId?: string;
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;
    
    constructor(id: string, name: string, tier?: string, badge?: string, providerId?: string) {
        this.id = id;
        this.name = name;
        this.tier = tier;
        this.badge = badge;
        this.providerId = providerId || id;
    }

    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);

        const apiKey = await Secrets.get('anthropic-api-key', Config.get().keys?.anthropic) ?? undefined;
        if (!apiKey) {
            throw new Error("Missing Anthropic API Key. Run 'rose setup' or add keys.anthropic in ~/.rose/config.json");
        }

        try {
            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;

            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ name: t.name, description: t.description, input_schema: toJsSchema(t.parameters) }));
            }

            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Anthropic API Error: ${text}`);
            }

            const data = await response.json();
            this.failures = 0;
            this.health = 'HEALTHY';
            return data;
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw e;
        }
    }

    /** Anthropic SSE streaming (stream: true). */
    public async *stream(messages: any[], system?: string, maxTokens: number = 8192): AsyncGenerator<any> {
        const apiKey = await Secrets.get('anthropic-api-key', Config.get().keys?.anthropic) ?? undefined;
        if (!apiKey) throw new Error('Missing Anthropic API Key for streaming.');

        const body: any = {
            model: this.providerId,
            max_tokens: maxTokens,
            messages,
            stream: true,
        };
        if (system) body.system = system;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok || !response.body) throw new Error(`Anthropic stream error ${response.status}`);

        for await (const payload of sseLines(response.body)) {
            if (!payload || payload === '[DONE]') continue;
            try {
                const evt = JSON.parse(payload);
                if (evt.type === 'content_block_delta' && evt.delta?.text) yield evt.delta.text;
            } catch { /* skip partial */ }
        }
        this.failures = 0;
        this.health = 'HEALTHY';
    }
}

// ─── OpenAI GPT (Direct REST API) ───
export class OpenAIProvider implements ModelProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    public providerId?: string;
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;
    
    constructor(id: string, name: string, tier?: string, badge?: string, providerId?: string) {
        this.id = id;
        this.name = name;
        this.tier = tier;
        this.badge = badge;
        this.providerId = providerId || id;
    }

    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);

        const apiKey = await Secrets.get('openai-api-key', Config.get().keys?.openai) ?? undefined;
        if (!apiKey) {
            throw new Error("Missing OpenAI API Key. Run 'rose setup' or add keys.openai in ~/.rose/config.json");
        }

        try {
            const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;

            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: msgs
            };
            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsSchema(t.parameters) } }));
            }

            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`OpenAI API Error: ${text}`);
            }

            const data: any = await response.json();
            
            this.failures = 0;
            this.health = 'HEALTHY';
            
            // Return raw response so tool_calls are preserved for the tool loop
            return data;
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw e;
        }
    }

    /** OpenAI-compatible SSE streaming (also used by OpenRouter). */
    public async *stream(messages: any[], system?: string, maxTokens: number = 8192): AsyncGenerator<any> {
        const apiKey = await Secrets.get('openai-api-key', Config.get().keys?.openai) ?? undefined;
        if (!apiKey) throw new Error('Missing OpenAI API Key for streaming.');

        const chatMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: this.providerId,
                messages: chatMessages,
                max_tokens: maxTokens,
                stream: true,
            }),
        });
        if (!response.ok || !response.body) throw new Error(`OpenAI stream error ${response.status}`);

        for await (const payload of sseLines(response.body)) {
            if (!payload || payload === '[DONE]') continue;
            try {
                const evt = JSON.parse(payload);
                const delta = evt.choices?.[0]?.delta?.content;
                if (delta) yield delta;
            } catch { /* skip partial */ }
        }
        this.failures = 0;
        this.health = 'HEALTHY';
    }
}

// ─── Antigravity Proxy (localhost:8642) ───
export class ProxyProvider implements ModelProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    public providerId?: string;
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;
    
    constructor(id: string, name: string, tier?: string, badge?: string, providerId?: string) {
        this.id = id;
        this.name = name;
        this.tier = tier;
        this.badge = badge;
        this.providerId = providerId || id;
    }

    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);
        
        const proxyUrl = Config.get().proxy?.url || 'http://localhost:8642';
        
        try {
            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;

            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsSchema(t.parameters) } }));
            }

            const response = await fetch(`${proxyUrl}/v1/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Proxy Error (${response.status}): ${text}`);
            }

            const data = await response.json();
            
            this.failures = 0;
            this.health = 'HEALTHY';
            
            return data;
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw new Error(`Failed to reach proxy at ${proxyUrl} â€” is antigravity-proxy-ai running? Error: ${e.message}`);
        }
    }
}

export class ModelRouter {
    private static providers: ModelProvider[] = [];
    
    public static async initialize() {
        const cfg = Config.get();
        const primary = cfg.agent?.provider || 'proxy';

        // Build providers list based on user's primary provider
        this.providers = [];
        
        if (primary === 'gemini') {
            this.providers.push(new GeminiProvider('gemini-2.0-flash', 'Gemini 2.0 Flash', 'Fast', undefined, 'gemini-2.0-flash'));
            this.providers.push(new GeminiProvider('gemini-2.0-pro-exp', 'Gemini 2.0 Pro Exp', 'Smart', undefined, 'gemini-2.0-pro-exp'));
        } else if (primary === 'anthropic') {
            this.providers.push(new AnthropicProvider('claude-3-5-sonnet', 'Claude 3.5 Sonnet', 'Thinking', undefined, 'claude-3-5-sonnet-20241022'));
            this.providers.push(new AnthropicProvider('claude-3-opus', 'Claude 3 Opus', 'Powerful', undefined, 'claude-3-opus-20240229'));
            this.providers.push(new AnthropicProvider('claude-3-5-haiku', 'Claude 3.5 Haiku', 'Fast', undefined, 'claude-3-5-haiku-20241022'));
        } else if (primary === 'openai') {
            this.providers.push(new OpenAIProvider('gpt-4o', 'GPT-4o', 'Smart', undefined, 'gpt-4o'));
            this.providers.push(new OpenAIProvider('gpt-4o-mini', 'GPT-4o Mini', 'Fast', undefined, 'gpt-4o-mini'));
            this.providers.push(new OpenAIProvider('gpt-4-turbo', 'GPT-4 Turbo', 'Powerful', undefined, 'gpt-4-turbo'));
        } else if (primary === 'openrouter') {
            // Phase 35: discovery-driven registration. No fake model list â€”
            // models come from OpenRouter's /models endpoint; when discovery
            // fails we still register the explicitly configured model.
            const { OpenRouterProvider } = await import('./providers/openrouter.js');
            const configured = cfg.agent?.model?.startsWith('openrouter/')
                ? cfg.agent.model
                : (cfg.agent?.model ? `openrouter/${cfg.agent.model}` : 'openrouter/anthropic/claude-3.5-sonnet');

            try {
                const models = await OpenRouterProvider.listModels();
                const usable = models.filter(m => m.supportsTools !== false);
                // Prefer capable, larger-context models; cap the registry size.
                const picked = usable.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0)).slice(0, 6);
                for (const m of picked) {
                    const tier = (m.supportsVision ? 'Vision' : (m.supportsTools ? 'Smart' : 'Fast'));
                    this.providers.push(new OpenRouterProvider(m.id, tier, m.name));
                }
                console.log(chalk.gray(`[ROUTER] OpenRouter: ${models.length} models discovered (${picked.length} registered).`));
            } catch {
                console.warn('[ROUTER] Could not discover OpenRouter models.');
            }
            ModelRouter.openrouterModule = { OpenRouterProvider };

            if (!this.providers.some(p => p.id === configured)) {
                // Discovery failed or model missing from top-N: explicit config still works.
                this.providers.unshift(new OpenRouterProvider(configured, 'External'));
            }
        } else {
            // Proxy (default) - fetch models LIVE from proxy
            const proxyUrl = cfg.proxy?.url || 'http://localhost:8642';
            try {
                const response = await fetch(`${proxyUrl}/v1/models`);
                if (response.ok) {
                    const data: any = await response.json();
                    if (data.data && Array.isArray(data.data)) {
                        for (const m of data.data) {
                            this.providers.push(new ProxyProvider(m.id, m.description || m.id, 'Proxy', undefined, m.id));
                        }
                    }
                }
            } catch (e) {
                // Proxy not reachable - add fallback hardcoded models
                console.warn('[ROUTER] Could not fetch models from proxy. Using defaults.');
            }
            
            // If no models were fetched, add basic fallbacks
            if (this.providers.length === 0) {
                this.providers.push(new ProxyProvider('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Thinking', undefined, 'claude-sonnet-4-6'));
                this.providers.push(new ProxyProvider('gemini-2.5-flash', 'Gemini 2.5 Flash', 'Fast', undefined, 'gemini-2.5-flash'));
            }
        }

        // Also add fallback providers from other sources if keys are available
        if (primary !== 'proxy') {
            this.providers.push(new ProxyProvider('proxy-claude', 'Proxy Claude (Fallback)', 'Fallback', undefined, 'claude-sonnet-4-6'));
        }
        if (primary !== 'gemini' && cfg.keys?.gemini) {
            this.providers.push(new GeminiProvider('gemini-2.0-flash', 'Gemini Flash (Fallback)', 'Fallback', undefined, 'gemini-2.0-flash'));
        }
        // Phase 35: OpenRouter joins the fallback chain whenever a key exists â€”
        // position in the chain stays user-configured (primary first), never hardcoded.
        if (primary !== 'openrouter' && (cfg.keys?.openrouter || process.env.OPENROUTER_API_KEY)) {
            const { OpenRouterProvider } = await import('./providers/openrouter.js');
            const fbModel = cfg.agent?.model?.startsWith('openrouter/')
                ? cfg.agent.model
                : `openrouter/${cfg.agent?.model || 'anthropic/claude-3.5-sonnet'}`;
            this.providers.push(new OpenRouterProvider(fbModel, 'Fallback'));
        }

        // Phase 34: Ollama local models â€” appended as fallback tier so simple
        // tasks can run locally while complex ones stay on remote providers.
        if (process.env.ROSE_ENABLE_OLLAMA !== 'false') {
            try {
                const { OllamaProvider } = await import('./providers/ollama.js');
                const models = await OllamaProvider.listModels();
                for (const m of models.slice(0, 3)) {
                    this.providers.push(new (OllamaProvider as any)(m.name, 'Local', undefined));
                }
                if (models.length > 0) {
                    console.log(chalk.gray(`[ROUTER] Ollama: ${models.length} local model(s) available (${models.map(m => m.name).join(', ')})`));
                } else {
                    console.log(chalk.gray('[ROUTER] Ollama: Offline'));
                }
            } catch {
                console.log(chalk.gray('[ROUTER] Ollama: Offline'));
            }
        }

        // Offline mode: strip providers that require the internet unless they
        // are the only option remaining.
        if (process.env.ROSE_OFFLINE === 'true') {
            const localOnly = this.providers.filter(p => p.providerId === 'ollama');
            if (localOnly.length > 0) this.providers = localOnly;
        }
    }

    public static getProviders(): ModelProvider[] {
        return this.providers;
    }
    /**
     * Phase 36: streaming route. ONE pipeline consumed by CLI, API and SDK.
     * Falls back to buffered execute() for providers without native streaming.
     */
    public static async *routeStream(requirements: ModelRequirements, messages: any[], system?: string): AsyncGenerator<StreamChunk> {
        const cfg = Config.get();
        const preferredModelId = requirements.preferredModelId || cfg.agent?.model || this.providers[0]?.id;
        const candidates = this.providers.filter(p => p.health !== 'OPEN');
        const ordered = [
            ...candidates.filter(p => p.id === preferredModelId),
            ...candidates.filter(p => p.id !== preferredModelId),
        ];

        if (ordered.length === 0) {
            yield { type: 'error', content: 'No providers available' } as StreamChunk;
            return;
        }

        yield { type: 'status', content: `routing to ${ordered[0].name}` };

        for (const candidate of ordered) {
            try {
                if (candidate.stream) {
                    for await (const delta of candidate.stream(messages, system, requirements.maxTokens)) {
                        if (delta) yield { type: 'text.delta', content: typeof delta === 'string' ? delta : String(delta) };
                    }
                } else {
                    const result = await candidate.execute(messages, system, requirements.maxTokens);
                    let text = '';
                    if (result?.content && Array.isArray(result.content)) {
                        text = result.content.map((p: any) => p.text || '').join('');
                    } else if (result?.choices?.[0]?.message?.content) {
                        text = result.choices[0].message.content;
                    }
                    if (text) yield { type: 'text.delta', content: text };
                }
                Telemetry.recordEvent('model.stream', 'model', 'completed');
                yield { type: 'done' };
                return;
            } catch (e: any) {
                Telemetry.recordEvent('model.stream_failed', 'model', 'failed', undefined, { error: e.message, provider: candidate.id });
                yield { type: 'status', content: `${candidate.name} failed (${String(e.message).slice(0, 80)}), falling back...` };
                continue;
            }
        }
        yield { type: 'error', content: 'All providers failed during streaming' };
    }

    /**
     * Phase 35: context window of the given model when the provider exposes
     * it. The Context Manager clamps its budget with this â€” one source of
     * truth for token logic, no duplication.
     */
    public static getContextLimit(modelId?: string): number | undefined {
        const id = modelId || Config.get().agent?.model;
        if (!id) return undefined;
        if (id.startsWith('openrouter/')) {
            const mod = ModelRouter.openrouterModule as
                | { OpenRouterProvider?: { getModelInfo(id: string): { contextLength?: number } | undefined } }
                | null;
            return mod?.OpenRouterProvider?.getModelInfo(id)?.contextLength;
        }
        return undefined;
    }

    /** Injected by initialize() so getContextLimit works without re-importing. */
    private static openrouterModule: unknown = null;

    public static async route(requirements: ModelRequirements, messages: any[], system?: string): Promise<any> {
        const cfg = Config.get();
        let preferredModelId = requirements.preferredModelId || cfg.agent?.model || this.providers[0]?.id;
        
        if (!requirements.preferredModelId) {
            if (requirements.capabilities?.includes('fast')) {
                const fast = this.providers.find(p => p.tier === 'Fast');
                if (fast) preferredModelId = fast.id;
            } else if (requirements.capabilities?.includes('reasoning')) {
                const smart = this.providers.find(p => p.tier === 'Smart' || p.tier === 'Thinking' || p.tier === 'Powerful');
                if (smart) preferredModelId = smart.id;
            }

            const learnedPreference = PreferenceManager.getPreference('preferred_model');
            if (learnedPreference && this.providers.find(p => p.id === learnedPreference)) {
                preferredModelId = learnedPreference;
            }
        }

        const candidates = this.providers.filter(p => p.id === preferredModelId).concat(this.providers.filter(p => p.id !== preferredModelId));

        // Phase 35: capability matching (spec 19). When a task requires a
        // capability like vision, models that advertise it are tried first;
        // providers with unknown capability stay eligible so non-OpenRouter
        // fallbacks keep working.
        if (requirements.capabilities?.includes('vision')) {
            const visionCapable = (p: ModelProvider): boolean => {
                if (!p.id.startsWith('openrouter/')) return true; // capability unknown â†’ still eligible
                const mod = ModelRouter.openrouterModule as
                    | { OpenRouterProvider?: { getModelInfo(id: string): { supportsVision?: boolean } | undefined } }
                    | null;
                const info = mod?.OpenRouterProvider?.getModelInfo(p.id);
                return info ? info.supportsVision === true : false;
            };
            const eligible = candidates.filter(visionCapable);
            if (eligible.length > 0 && eligible.length < candidates.length) {
                const rest = candidates.filter(p => !eligible.includes(p));
                candidates.length = 0;
                candidates.push(...eligible, ...rest);
            }
        }
        
        for (const candidate of candidates) {
            if (candidate.health === 'OPEN') continue;

            const startTime = Date.now();
            Telemetry.recordEvent('model.request_started', 'model', 'started', undefined, { 
                model: candidate.id, 
                intent: requirements.intent 
            });

            try {
                const result = await candidate.execute(messages, system, requirements.maxTokens, requirements.tools);
                Telemetry.recordEvent('model.request_completed', 'model', 'completed', Date.now() - startTime);
                return result;
            } catch (err: any) {
                Telemetry.recordEvent('model.request_failed', 'model', 'failed', Date.now() - startTime, { error: err.message });
                console.warn(`[ROUTER] ${candidate.id} failed, attempting fallback...`);
                // Continue to next fallback candidate
            }
        }
        
        throw new Error("All providers failed. Check your API keys with 'rose setup' or ensure antigravity-proxy-ai is running.");
    }
}



