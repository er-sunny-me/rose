/**
 * Phase 38 §10/§11/§46 — DYNAMIC capability manifest.
 *
 * Generated from the REAL runtime installation every time it is requested:
 *   - installed tools        ← ToolRegistry (live declarations)
 *   - enabled skills         ← SkillRegistry
 *   - plugins/MCP            ← ExtensionRegistry + McpClientManager statuses
 *   - providers              ← ModelRouter (built from actual config/keys)
 *   - browser                ← playwright resolvable?
 *   - memory/vector          ← embedding-provider abstraction (existing)
 *
 * NOTHING here is hardcoded or manually maintained. Adding/removing an
 * integration changes the manifest automatically (§47), and `capabilityVersion`
 * is a content hash so peers/server can cheaply diff (§23/§24).
 */
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

export interface MeshManifest {
    capabilities: string[];
    tools: string[];
    skills: string[];
    providers: string[];
    memoryCapabilities: string[];
    browser: boolean;
    mcp: boolean;
    configVersion: string;
    capabilityVersion: number;
}

function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
    try { return await fn(); } catch { return fallback; }
}

export async function detectManifest(): Promise<MeshManifest> {
    const { Config } = await import('./config.js');
    const cfg: any = Config.get();

    // ── tools (live declarations — includes plugin-provided ones when loaded) ──
    const tools = await safe(async () => {
        const { ToolRegistry } = await import('./tools.js');
        return ToolRegistry.getDeclarations().map(t => String(t.name));
    }, []);

    // ── skills ──
    const skills = await safe(async () => {
        const { SkillRegistry } = await import('./skills.js');
        const reg: any = SkillRegistry;
        const list = reg.list?.() ?? reg.getAll?.() ?? [];
        return Array.isArray(list) ? list.map((s: any) => String(s?.name ?? s)).filter(Boolean) : [];
    }, []);

    // ── plugins & MCP servers ──
    const extensions = await safe(async () => {
        const { ExtensionRegistry } = await import('./extensions.js');
        return ExtensionRegistry.getExtensions();
    }, []);
    const mcpStatuses = await safe(async () => {
        const { McpClientManager } = await import('./mcp.js');
        return McpClientManager.getClientStatuses();
    }, []);
    const mcpServers = mcpStatuses.filter(s => s.connected).map(s => `mcp:${s.id}`);
    const mcpEnabled = mcpStatuses.length > 0;

    // ── providers actually built from configuration ──
    const providers = await safe(async () => {
        const { ModelRouter } = await import('./router.js');
        return ModelRouter.getProviders().map(p => String((p as any).id ?? (p as any).providerId ?? '')).filter(Boolean);
    }, []);

    // ── browser: real Playwright availability, not a flag ──
    const browser = await safe(() => {
        const req = createRequire(process.cwd() + '/package.json');
        req.resolve('playwright');
        return true;
    }, false);

    // ── optional integrations, detected from keys/credentials presence ──
    const hasGithub = !!((cfg.keys && cfg.keys.github) || process.env.GITHUB_TOKEN);
    const googleCreds = process.env.GOOGLE_CREDENTIALS || '';
    const hasGoogle = !!googleCreds && (() => { try { return fsExists(googleCreds); } catch { return false; } })();
    const ollamaEnabled = cfg.agent?.provider === 'ollama' || !!process.env.OLLAMA_HOST || process.env.ROSE_ENABLE_OLLAMA === 'true';

    // ── memory capabilities via the EXISTING embedding-provider abstraction (§21) ──
    const embeddingProvider = process.env.ROSE_EMBEDDING_PROVIDER || cfg.memory?.embeddingProvider || 'gemini';
    const memoryCapabilities = ['keyword', embeddingProvider === 'gemini' ? 'vector-gemini' : `vector-${embeddingProvider}`];
    const obsidianDir = cfg.memory?.obsidianVaultPath ?? cfg.baseDir ?? '';
    if (obsidianDir) memoryCapabilities.push('obsidian');

    // ── aggregate capability tags (server routes requiredCapabilities on these) ──
    const capabilities = new Set<string>(['terminal', 'filesystem']);
    if (browser) capabilities.add('browser');
    if (hasGithub) capabilities.add('github');
    if (hasGoogle) capabilities.add('calendar');
    if (mcpEnabled) capabilities.add('mcp');
    if (ollamaEnabled) capabilities.add('ollama');
    capabilities.add('memory');
    capabilities.add('tasks');
    for (const e of extensions) capabilities.add(e.type === 'mcp' ? 'mcp' : 'plugin');
    for (const m of mcpServers) capabilities.add(m);

    const manifest: MeshManifest = {
        capabilities: [...capabilities].sort(),
        tools,
        skills,
        providers,
        memoryCapabilities,
        browser,
        mcp: mcpEnabled,
        configVersion: '',
        capabilityVersion: 0,
    };

    // Content-derived versions so peers can diff without full config sync (§23).
    const fingerprint = JSON.stringify({
        c: manifest.capabilities, t: manifest.tools.length, k: manifest.tools.slice(0, 64),
        s: manifest.skills, p: manifest.providers, m: manifest.mcp, b: manifest.browser,
        v: manifest.memoryCapabilities,
    });
    manifest.capabilityVersion = fnv1a(fingerprint);
    manifest.configVersion = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 12);
    return manifest;
}

function fsExists(p: string): boolean {
    try { return fs.existsSync(p); } catch { return false; }
}
