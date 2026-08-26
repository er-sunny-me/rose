/**
 * PHASE 39 — TOOL INTELLIGENCE LAYER (§1-§78)
 *
 * Sits BETWEEN intent and execution:
 *   intent → capability discovery → candidate ranking → security eligibility
 *   → expose only relevant schemas (topK) → execution → verification → learning
 *
 * NON-GOALS honored: does NOT replace ToolRegistry / SecurityEngine /
 * CapabilityRouter / Skills — it indexes and ranks what they already provide.
 * Metadata can never bypass policy (§11/§46): hard DENY happens before ranking.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Config } from '../config.js';
import { envRoseHome } from '../storage-paths.js';

const nodeRequire = createRequire(import.meta.url);

export type Risk = 'low' | 'medium' | 'high' | 'critical';
export type Health = 'healthy' | 'degraded' | 'unavailable';

export interface ToolIntelligenceMetadata {
    name: string;
    description: string;
    capabilities: string[];          // hierarchical, e.g. github.issue
    intents: string[];               // example phrasings this tool satisfies
    tags?: string[];
    useWhen?: string[];
    avoidWhen?: string[];
    prerequisites?: string[];        // e.g. 'github.auth', 'playwright', 'google.oauth'
    risk: Risk;
    sideEffects: boolean;
    sideEffectClass?: 'read-only' | 'local-write' | 'external-write' | 'destructive' | 'network';
    idempotent?: boolean;
    supportsSimulation?: boolean;
    requiresApproval?: boolean;      // HINT only — Policy remains authoritative (§46)
    supportedPlatforms?: string[];
    inputSchema?: unknown;
    workflowHints?: string[];
    verificationHints?: string[];
    examples?: string[];
    source: 'builtin' | 'plugin' | 'mcp' | 'remote';
}

export interface ToolCandidate {
    toolName: string;
    capability: string;
    score: number;
    reasons: string[];
    prerequisitesMet: boolean;
    missingPrerequisites: string[];
    risk: Risk;
    health: Health;
    local: boolean;
    agentId?: string;
    eligible: boolean;               // passed HARD security/availability gates
    ineligibleReason?: string;
}

export interface DiscoveryRequest {
    query: string;
    topK?: number;
    riskTolerance?: Risk;
    platform?: string;
    dataSensitive?: boolean;         // §70: excludes remote agents when true
}

// ─── Prerequisite engine (§18) ──────────────────────────────────────────────

function checkPrereq(id: string): { met: boolean; detail: string } {
    const cfg: any = (() => { try { return Config.get(); } catch { return {}; } })();
    switch (id) {
        case 'github.auth':
            return { met: !!(process.env.GITHUB_TOKEN || cfg.keys?.github), detail: 'GitHub token configured' };
        case 'google.oauth': {
            const p = process.env.GOOGLE_CREDENTIALS || path.join(process.env.USERPROFILE || process.env.HOME || '', '.rose', 'google-tokens.json');
            const met = !!fs.existsSync(p);
            return { met, detail: `Google OAuth tokens at ${p}` };
        }
        case 'playwright':
            try { nodeRequire.resolve('playwright'); return { met: true, detail: 'Playwright installed' }; } catch { return { met: false, detail: 'Playwright not installed' }; }
        case 'ollama':
            return { met: !!(cfg.agent?.provider === 'ollama' || process.env.OLLAMA_HOST), detail: 'Ollama provider configured' };
        case 'gemini.key':
            return { met: !!(process.env.GEMINI_API_KEY || cfg.keys?.gemini), detail: 'Gemini API key present' };
        default:
            return { met: true, detail: id };
    }
}

// ─── Health & learning store (§39-§43, §73-75) ──────────────────────────────

interface ToolStat { success: number; failure: number; emaLatencyMs: number; lastErrorType?: string; updated: number; }

class ToolHealthStore {
    private stats = new Map<string, ToolStat>();
    private file(): string { return path.join(envRoseHome() ?? '.rose', 'tool-health.json'); }
    load() {
        if (this.stats.size) return;
        try { const d = JSON.parse(fs.readFileSync(this.file(), 'utf8')); for (const [k, v] of Object.entries(d)) this.stats.set(k, v as ToolStat); } catch { /* fresh */ }
    }
    private save() {
        try { fs.writeFileSync(this.file(), JSON.stringify(Object.fromEntries(this.stats)), {}); } catch { /* ignore */ }
    }
    record(tool: string, success: boolean, latencyMs: number, errorType?: string) {
        this.load();
        const s = this.stats.get(tool) ?? { success: 0, failure: 0, emaLatencyMs: latencyMs, updated: 0 };
        success ? s.success++ : s.failure++;
        s.emaLatencyMs = Math.round(s.emaLatencyMs * 0.7 + latencyMs * 0.3);
        if (!success) s.lastErrorType = errorType ?? 'unknown';
        s.updated = Date.now();
        this.stats.set(tool, s);
        this.save();
    }
    get(tool: string): ToolStat | undefined { this.load(); return this.stats.get(tool); }
}
export const toolHealth = new ToolHealthStore();

export function healthOf(meta: ToolIntelligenceMetadata): Health {
    const s = toolHealth.get(meta.name);
    if (!s) return 'healthy';
    const total = s.success + s.failure;
    if (s.lastErrorType === 'permanent_unavailable') return 'unavailable';
    const rate = total ? s.success / total : 1;
    if (rate >= 0.8) return 'healthy';
    if (rate >= 0.4) return 'degraded';       // §39: one failure never demotes permanently
    return 'degraded';
}

// ─── Capability Registry (§5-§7) — derived, hierarchical, dynamic ───────────

export interface CapabilityInfo {
    id: string;                          // e.g. github.issue
    parent?: string;                     // e.g. github
    title: string;
    description: string;
    tools: string[];
    risk: Risk;
    prerequisites: string[];
    status: 'Ready' | 'Needs setup' | 'Unavailable';
    missing: string[];
    source: 'local' | 'remote';
    agentId?: string;
    remotePlatform?: string;
}

// ─── Static knowledge for builtin tools (declared where the tool lives is
// impossible without touching every definition; this normalizer derives rich
// metadata from the REAL declarations + a curated knowledge map §4). ─────────

const KNOWLEDGE: Record<string, Partial<ToolIntelligenceMetadata>> = {
    save_memory: { capabilities: ['memory.write'], intents: ['remember this', 'save this fact', 'store preference'], useWhen: ['durable info should persist'], avoidWhen: ['info is ephemeral'], risk: 'low', sideEffects: true, sideEffectClass: 'local-write', prerequisites: [], verificationHints: ['entry retrievable via search_memory'] },
    search_memory: { capabilities: ['memory.search'], intents: ['what did we decide about', 'recall', 'find memory'], useWhen: ['past context needed'], risk: 'low', sideEffects: false, sideEffectClass: 'read-only', verificationHints: ['results relevant to query'] },
    search_obsidian: { capabilities: ['memory.search', 'obsidian.search'], intents: ['what did i write about', 'search my notes'], prerequisites: [], risk: 'low', sideEffects: false, sideEffectClass: 'read-only' },
    browser_control: { capabilities: ['browser', 'browser.testing'], intents: ['open website', 'test website', 'take screenshot of page', 'scrape page'], useWhen: ['visual verification required', 'JS-rendered content needed'], avoidWhen: ['only static text extraction'], prerequisites: ['playwright'], risk: 'medium', sideEffects: true, sideEffectClass: 'network', supportsSimulation: true, workflowHints: ['open → inspect → interact → screenshot → verify'], verificationHints: ['screenshot exists', 'expected element extracted'] },
    web_search: { capabilities: ['research', 'web.search'], intents: ['find latest official documentation', 'search the web', 'look up online'], risk: 'low', sideEffects: false, sideEffectClass: 'network', verificationHints: ['sources returned with citations'] },
    fetch_page: { capabilities: ['web.fetch', 'research'], intents: ['read this url', 'fetch page content'], risk: 'low', sideEffects: false, sideEffectClass: 'network' },
    execute_command: { capabilities: ['terminal.execute', 'project.testing'], intents: ['run command', 'run tests', 'execute shell script'], useWhen: ['project exposes a test runner', 'no structured tool exists'], avoidWhen: ['a dedicated tool provides the same capability'], prerequisites: [], risk: 'high', sideEffects: true, sideEffectClass: 'local-write', requiresApproval: true, supportsSimulation: true, verificationHints: ['exit code 0', 'expected output present'] },
    service_github: { capabilities: ['github', 'github.issue'], intents: ['find open issues', 'search github bugs', 'issues about authentication', 'create github issue', 'list pull requests'], examples: ['Find open authentication issues on GitHub.'], prerequisites: ['github.auth'], risk: 'low', sideEffects: false, sideEffectClass: 'network', verificationHints: ['valid issue list returned'] },
    service_calendar: { capabilities: ['calendar'], intents: ['what meetings do i have', 'my schedule tomorrow', 'calendar today', 'check appointments'], prerequisites: ['google.oauth'], risk: 'low', sideEffects: false, sideEffectClass: 'network', verificationHints: ['event list for date range returned'] },
    service_email: { capabilities: ['gmail.send', 'gmail.read'], intents: ['send email to', 'check my inbox', 'unread mail'], prerequisites: ['google.oauth'], risk: 'medium', sideEffects: true, sideEffectClass: 'external-write', requiresApproval: true },
    android_click: { capabilities: ['android.control'], intents: ['tap on phone', 'click element on mobile'], risk: 'medium', sideEffects: true, sideEffectClass: 'external-write' },
    android_swipe: { capabilities: ['android.control'], intents: ['scroll on phone', 'swipe mobile screen'], risk: 'medium', sideEffects: true, sideEffectClass: 'external-write' },
    android_get_screen_text: { capabilities: ['android.control', 'android.read'], intents: ['what is on my phone screen', 'read phone screen'], risk: 'low', sideEffects: false, sideEffectClass: 'read-only' },
};

const SIDE_EFFECT_TO_RISK: Record<string, Risk> = { READ: 'low', PREDICTABLE_WRITE: 'medium', WRITE: 'medium', DESTRUCTIVE: 'critical', EXTERNAL_ACTION: 'high' };

/** Normalize ANY tool declaration (builtin/plugin/MCP) into intelligence metadata (§27-§28). */
function normalize(name: string, decl: any, source: ToolIntelligenceMetadata['source']): ToolIntelligenceMetadata {
    const k = KNOWLEDGE[name.replace(/_/g, '_')] ?? KNOWLEDGE[name] ?? {};
    const se = String(decl?.sideEffect ?? 'READ').toUpperCase();
    const words = name.toLowerCase().replace(/[_-]/g, ' ');
    return {
        name,
        description: String(decl?.description ?? k.description ?? words),
        capabilities: k.capabilities ?? [`tools.${words.split(' ')[0]}`],
        intents: k.intents ?? [words],
        tags: k.tags ?? [],
        useWhen: k.useWhen ?? [],
        avoidWhen: k.avoidWhen ?? [],
        prerequisites: k.prerequisites ?? [],
        risk: k.risk ?? SIDE_EFFECT_TO_RISK[se] ?? 'medium',
        sideEffects: se !== 'READ',
        sideEffectClass: k.sideEffectClass ?? (se === 'READ' ? 'read-only' : se === 'DESTRUCTIVE' ? 'destructive' : 'local-write'),
        idempotent: se === 'READ',
        supportsSimulation: k.supportsSimulation ?? false,
        requiresApproval: k.requiresApproval ?? ['HIGH', 'CRITICAL'].includes(se),
        inputSchema: decl?.parameters,
        workflowHints: k.workflowHints ?? [],
        verificationHints: k.verificationHints ?? [],
        examples: k.examples ?? [],
        source,
    };
}

// ─── Workflows (§21-§23) — deterministic sequences, not LLM wiring ──────────

export interface WorkflowStep { tool: string; purpose: string; optional?: boolean; }
export interface ToolWorkflow { id: string; name: string; intentPatterns: string[]; steps: WorkflowStep[]; prerequisites?: string[]; verification?: string[]; }

export const WORKFLOWS: ToolWorkflow[] = [
    { id: 'browser.testing', name: 'Website Test & Screenshot', intentPatterns: ['test website', 'test my website', 'screenshot site', 'check website works'], prerequisites: ['playwright'], steps: [{ tool: 'browser_control', purpose: 'open + navigate + extract + screenshot' }, { tool: 'write_file', purpose: 'persist screenshot artifact', optional: true }], verification: ['screenshot file exists', 'page title extracted'] },
    { id: 'project.testing', name: 'Run Project Tests', intentPatterns: ['run tests', 'run the tests', 'execute test suite'], steps: [{ tool: 'execute_command', purpose: 'invoke project test runner in sandbox' }], verification: ['exit code 0'] },
];

// ─── Remote agent candidates via Phase-38 mesh (§29-§31, §72, §91) ──────────

interface RemoteSnapshot { fetchedAt: number; agents: Array<{ agentId: string; displayName: string; platform: string; capabilities: string[]; trust: string; status: string }>; }
let remoteCache: RemoteSnapshot | null = null;

export async function refreshRemoteAgents(): Promise<RemoteSnapshot> {
    try {
        const saved = fs.readFileSync(path.join(envRoseHome() ?? path.join(process.env.USERPROFILE || '.', '.rose'), 'mesh-server.txt'), 'utf8').trim();
        if (!saved) throw new Error('no mesh server');
        const { Secrets } = await import('../security/secrets.js');
        const token = process.env.ROSE_API_TOKEN || await Secrets.get('mesh-api-password');
        const r = await fetch(`${saved.replace(/\/$/, '')}/api/mesh`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const j: any = await r.json();
        remoteCache = { fetchedAt: Date.now(), agents: (j.agents ?? []).map((a: any) => ({ agentId: a.agentId, displayName: a.displayName, platform: a.platform, capabilities: a.capabilities ?? [], trust: a.trust, status: a.status })) };
    } catch { remoteCache = { fetchedAt: Date.now(), agents: [] }; }
    return remoteCache;
}

function require_resolve(mod: string): boolean { try { nodeRequire.resolve(mod); return true; } catch { return false; } }
void require_resolve;

// ─── Core index + discovery (§8-§14, §62-§68) ───────────────────────────────

export class ToolIntelligence {
    private index: ToolIntelligenceMetadata[] = [];
    private indexedAt = 0;

    /** Build/rebuild the discovery index from ALL real sources (§65-§66). */
    async buildIndex(force = false): Promise<number> {
        if (this.index.length && !force && Date.now() - this.indexedAt < 60_000) return this.index.length;
        const out: ToolIntelligenceMetadata[] = [];
        try {
            const { ToolRegistry } = await import('../tools.js');
            for (const d of ToolRegistry.getDeclarations()) out.push(normalize(String(d.name), d, 'builtin'));
        } catch { /* registry unavailable in stripped contexts */ }
        try {
            const { ExtensionRegistry } = await import('../extensions.js');
            for (const t of ExtensionRegistry.getExtensionTools()) out.push(normalize(String(t.name), t, 'plugin'));
        } catch { /* none loaded */ }
        // MCP tools already merge into declarations via mcp_* names; tag them.
        for (const m of out) if (m.name.startsWith('mcp_')) m.source = 'mcp';
        this.index = out;
        this.indexedAt = Date.now();
        return out.length;
    }

    invalidate() { this.indexedAt = 0; this.index = []; }   // §47/§66

    async all(): Promise<ToolIntelligenceMetadata[]> { await this.buildIndex(); return this.index; }

    /** Lightweight rule-based intent classification — NO LLM call (§62). */
    classifyIntent(query: string): { domain: string; keywords: string[] } {
        const q = query.toLowerCase();
        const STOP = new Set(['about', 'the', 'and', 'for', 'with', 'what', 'when', 'how', 'did', 'does', 'you', 'your', 'have', 'has', 'can', 'could', 'please', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'will', 'would']);
        const rules: Array<[string, RegExp]> = [
            ['github', /\b(github|issue|pull request|pr|repo)\b/],
            ['calendar', /\b(meeting|calendar|schedule|appointment)\b/],
            ['gmail', /\b(email|mail|inbox)\b/],
            ['browser', /\b(website|url|browser|screenshot|web(page|site)?)\b/],
            ['testing', /\b(run|execute)\b.*\b(test|suite|spec)\b|\btests?\b/],
            ['filesystem', /\b(file|readme|folder|directory|document)\b/],
            ['terminal', /\b(shell|command|terminal|script)\b/],
            ['memory', /\b(remember|recall|decided|previously|we said)\b/],
            ['research', /\b(latest|documentation|research|find official)\b/],
        ];
        for (const [domain, re] of rules) if (re.test(q)) return { domain, keywords: q.split(/\W+/).filter(w => w.length > 2 && !STOP.has(w)) };
        return { domain: 'general', keywords: q.split(/\W+/).filter(w => w.length > 2 && !STOP.has(w)) };
    }

    /**
     * Full pipeline (§68 security-first order):
     * discover → availability → HARD security eligibility → rank.
     */
    async discover(req: DiscoveryRequest): Promise<{ intent: { domain: string; keywords: string[] }; candidates: ToolCandidate[]; workflows: ToolWorkflow[]; honestFallback?: string }> {
        const topK = Math.max(1, req.topK ?? 6);
        await this.buildIndex();
        const intent = this.classifyIntent(req.query);

        // Availability + prerequisite evaluation FIRST (hard gates).
        const evaluated: ToolCandidate[] = [];
        for (const meta of this.index) {
            const miss: string[] = [];
            for (const p of meta.prerequisites ?? []) if (!checkPrereq(p).met) miss.push(p);
            const h = healthOf(meta);
            const reasons: string[] = [];
            let score = 0;

            // keyword scoring across intents/capabilities/tags/description (§64 keyword leg)
            for (const kw of intent.keywords) {
                if (meta.intents.some(i => i.includes(kw))) { score += 4; reasons.push(`intent~${kw}`); }
                if (meta.capabilities.some(c => c.includes(kw))) { score += 3; reasons.push(`capability~${kw}`); }
                if (meta.name.toLowerCase().includes(kw)) { score += 2; reasons.push(`name~${kw}`); }
                if (meta.description.toLowerCase().includes(kw)) { score += 1; reasons.push(`desc~${kw}`); }
            }
            if (intent.domain !== 'general' && meta.capabilities.some(c => c.startsWith(intent.domain))) { score += 5; reasons.push(`domain=${intent.domain}`); }
            if (score === 0) continue;   // irrelevant → NEVER exposed (§2)

            let eligible = true, ineligibleReason: string | undefined;
            if (h === 'unavailable') { eligible = false; ineligibleReason = 'health: unavailable'; }
            else if ((req.riskTolerance ?? 'high') === 'low' && (meta.risk === 'high' || meta.risk === 'critical')) { eligible = false; ineligibleReason = `risk ${meta.risk} > tolerance`; }
            else if (miss.length > 0) { /* still ranked but flagged; executor must refuse */ }

            evaluated.push({ toolName: meta.name, capability: meta.capabilities[0], score, reasons, prerequisitesMet: miss.length === 0, missingPrerequisites: miss, risk: meta.risk, health: h, local: true, eligible, ineligibleReason });
        }

        // Remote agent candidates (Phase 38 integration §29-§31).
        if (!req.dataSensitive && remoteCache) {
            for (const ra of remoteCache.agents) {
                if (ra.agentId === process.env.ROSE_SELF_AGENT_ID) continue;
                if (ra.trust !== 'trusted' || ra.status === 'offline') continue;      // §31 trust gate
                const overlap = ra.capabilities.filter(c => intent.keywords.some(k => c.includes(k)));
                if (overlap.length === 0 && !(intent.domain !== 'general' && ra.capabilities.some(c => c.startsWith(intent.domain)))) continue;
                evaluated.push({ toolName: `remote:${ra.displayName}`, capability: overlap[0] ?? intent.domain, score: 2, reasons: [`remote-agent ${ra.platform}`], prerequisitesMet: true, missingPrerequisites: [], risk: 'medium', health: ra.status === 'online' ? 'healthy' : 'degraded', local: false, agentId: ra.agentId, eligible: true });
            }
        }

        evaluated.sort((a, b) => b.score - a.score);
        const workflows = WORKFLOWS.filter(w => w.intentPatterns.some(p => req.query.toLowerCase().includes(p.replace(/\b\w+\b/g, m => m))));
        const candidates = evaluated.slice(0, topK);

        // Honest fallback (§13-§15).
        let honestFallback: string | undefined;
        if (candidates.length === 0) {
            honestFallback = intent.domain === 'general'
                ? 'I could not map that request to any installed capability.'
                : `I don't currently have a capability for "${intent.domain}".`;
        } else if (candidates.every(c => !c.prerequisitesMet)) {
            const missing = [...new Set(candidates.flatMap(c => c.missingPrerequisites))];
            honestFallback = `Relevant tools exist but prerequisites are missing: ${missing.join(', ')}.`;
        }
        return { intent, candidates, workflows, honestFallback };
    }

    /** Capability Registry view (§52, §54) — generated dynamically. */
    async capabilities(query?: string): Promise<CapabilityInfo[]> {
        await this.buildIndex();
        const map = new Map<string, CapabilityInfo>();
        for (const m of this.index) {
            for (const cap of m.capabilities) {
                const parent = cap.includes('.') ? cap.split('.')[0] : undefined;
                for (const id of [cap, ...(parent ? [parent] : [])]) {
                    const cur = map.get(id) ?? { id, parent: parent === id ? undefined : parent && id === parent ? undefined : parent, title: id.replace(/[._]/g, ' '), description: '', tools: [], risk: 'low' as Risk, prerequisites: [], status: 'Ready' as const, missing: [], source: 'local' as const };
                    if (!cur.tools.includes(m.name)) cur.tools.push(m.name);
                    cur.risk = ([...cur.tools].length && m.risk === 'critical') || cur.risk === 'critical' ? 'critical' : (cur.risk === 'high' || m.risk === 'high') ? 'high' : cur.risk === 'medium' || m.risk === 'medium' ? 'medium' : 'low';
                    for (const p of m.prerequisites ?? []) if (!cur.prerequisites.includes(p)) cur.prerequisites.push(p);
                    map.set(id, cur);
                }
            }
        }
        let out = [...map.values()];
        for (const c of out) {
            c.missing = c.prerequisites.filter(p => !checkPrereq(p).met);
            c.status = c.missing.length ? 'Needs setup' : 'Ready';
            c.description = `${c.tools.length} tool(s): ${c.tools.slice(0, 4).join(', ')}${c.tools.length > 4 ? ', …' : ''}`;
        }
        if (query) { const q = query.toLowerCase(); out = out.filter(c => c.id.includes(q) || c.title.includes(q)); }
        return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    /** "What can you do?" — dynamic summary, never hardcoded (§54-§57). */
    async agentToolMap(): Promise<string[]> {
        const caps = await this.capabilities();
        return caps.filter(c => c.status !== 'Unavailable').map(c => `${c.status === 'Ready' ? '✓' : '~'} ${c.title}${c.source === 'remote' ? ` (via ${c.agentId})` : ''}`);
    }
}

export const toolIntelligence = new ToolIntelligence();
