import { Config } from '../config.js';

/**
 * Ollama local model provider.
 *
 * Implements the same ModelProvider contract as Gemini/Anthropic/OpenAI
 * providers in the router, so ModelRouter can treat it as just another
 * candidate: health circuit-breaker, fallback ordering and learned
 * preferences all work unchanged. Local models are providers â€” NOT trusted
 * system components; their tool calls still pass Policy/Security.
 */
export class OllamaProvider {
    public id: string;
    public name: string;
    public tier?: string;
    public badge?: string;
    public providerId = 'ollama';
    public health: 'HEALTHY' | 'DEGRADED' | 'OPEN' = 'HEALTHY';
    public failures = 0;

    private baseUrl: string;
    private model: string;

    constructor(model: string, tier?: string, badge?: string, baseUrl?: string) {
        const cfg = Config.get();
        this.baseUrl = (baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
        this.model = model;
        this.id = `ollama/${model}`;
        this.name = `${model} (local)`;
        this.tier = tier || 'Local';
        this.badge = badge;
        void cfg;
    }

    /** Query the daemon for installed models. Returns [] when offline. */
    static async listModels(baseUrl?: string): Promise<Array<{ name: string; size: number }>> {
        const url = (baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
        try {
            const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) return [];
            const data: any = await res.json();
            return (data.models || []).map((m: any) => ({ name: m.name, size: m.size ?? 0 }));
        } catch {
            return [];
        }
    }

    async execute(messages: any[], system?: string, maxTokens?: number): Promise<any> {
        // Normalize Anthropic-style [{role, content}] chat into /api/chat.
        const body = {
            model: this.model,
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                ...messages.map(m => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
                })),
            ],
            stream: false,
            options: maxTokens ? { num_predict: maxTokens } : undefined,
        };

        let res: Response;
        try {
            res = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            });
        } catch (e: any) {
            this.failures++;
            if (this.failures >= 1) this.health = 'DEGRADED';
            if (this.failures > 3) this.health = 'OPEN';
            throw new Error(`Ollama unreachable at ${this.baseUrl}: ${e.message}`);
        }

        if (!res.ok) {
            this.failures++;
            if (this.failures >= 1) this.health = 'DEGRADED';
            if (this.failures > 3) this.health = 'OPEN';
            throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
        }

        this.failures = 0;
        this.health = 'HEALTHY';
        const data: any = await res.json();

        // OpenAI-compatible response shape so the shared reply parser works.
        return {
            choices: [{
                message: {
                    role: 'assistant',
                    content: data?.message?.content ?? '',
                },
            }],
        };
    }
}

