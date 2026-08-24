import { Telemetry } from './telemetry.js';
import { PreferenceManager } from './learning.js';
import { FailureInjector } from './reliability/injector.js';
import { Config } from './config.js';

export interface ModelRequirements {
    capabilities?: string[];
    maxTokens?: number;
    intent?: string;
    preferredModelId?: string;
}

export interface ModelProvider {
    id: string;
    name: string;
    tier?: string;
    badge?: string;
    providerId?: string;
    health: 'HEALTHY' | 'DEGRADED' | 'OPEN';
    failures: number;
    
    execute(messages: any[], system?: string, maxTokens?: number): Promise<any>;
}

// ─── Google Gemini (Direct REST API) ───
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

    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);
        
        if (FailureInjector.isActive('provider_outage')) {
            this.failures++;
            if (this.failures >= 3) this.health = 'OPEN';
            throw new Error(`[Lab] Simulated provider outage for ${this.id}`);
        }

        const apiKey = Config.get().keys?.gemini || process.env.GEMINI_API_KEY;
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
            const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            this.failures = 0;
            this.health = 'HEALTHY';
            
            return {
                content: [{ text: resultText }],
                choices: [{ message: { content: resultText } }]
            };
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw e;
        }
    }
}

// ─── Anthropic Claude (Direct REST API) ───
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

    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);

        const apiKey = Config.get().keys?.anthropic || process.env.ANTHROPIC_API_KEY;
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

    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);

        const apiKey = Config.get().keys?.openai || process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("Missing OpenAI API Key. Run 'rose setup' or add keys.openai in ~/.rose/config.json");
        }

        try {
            const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;

            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: this.providerId,
                    max_tokens: maxTokens,
                    messages: msgs
                })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`OpenAI API Error: ${text}`);
            }

            const data: any = await response.json();
            const resultText = data.choices?.[0]?.message?.content || '';
            
            this.failures = 0;
            this.health = 'HEALTHY';
            
            return {
                content: [{ text: resultText }],
                choices: [{ message: { content: resultText } }]
            };
        } catch (e: any) {
            this.failures++;
            if (this.failures > 3) this.health = 'OPEN';
            else this.health = 'DEGRADED';
            throw e;
        }
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

    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {
        if (this.health === 'OPEN') throw new Error(`Circuit Breaker OPEN for ${this.id}`);
        
        const proxyUrl = Config.get().proxy?.url || 'http://localhost:8642';
        
        try {
            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;

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
            throw new Error(`Failed to reach proxy at ${proxyUrl} — is antigravity-proxy-ai running? Error: ${e.message}`);
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
    }

    public static getProviders(): ModelProvider[] {
        return this.providers;
    }

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
        
        for (const candidate of candidates) {
            if (candidate.health === 'OPEN') continue;

            const startTime = Date.now();
            Telemetry.recordEvent('model.request_started', 'model', 'started', undefined, { 
                model: candidate.id, 
                intent: requirements.intent 
            });

            try {
                const result = await candidate.execute(messages, system, requirements.maxTokens);
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
