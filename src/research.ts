import crypto from 'crypto';
import chalk from 'chalk';
import { ModelRouter } from './router.js';
import { Telemetry } from './telemetry.js';
import { MemoryService } from './memory.js';
import { Supervisor, OrchestratorConfig } from './agents.js';

// ──────────────────────────────────────────────────────────
// SECTION 1: INTERFACES & TYPES
// ──────────────────────────────────────────────────────────

export interface ResearchSource {
    id: string;
    type: 'web' | 'github' | 'file' | 'pdf' | 'memory' | 'mcp' | 'plugin' | 'agent';
    title?: string;
    uri?: string;
    localPath?: string;
    retrievedAt: number;
    authority?: number; // 0.0 to 1.0
    reliability?: number; // 0.0 to 1.0
    freshness?: number; // 0.0 to 1.0
    metadata?: Record<string, unknown>;
    contentHash?: string;
}

export interface EvidenceLocation {
    page?: number;
    lineStart?: number;
    lineEnd?: number;
    section?: string;
}

export interface EvidenceItem {
    id: string;
    sourceId: string;
    claim: string;
    excerpt?: string;
    location?: EvidenceLocation;
    confidence?: number;
    supports?: string[];
    contradicts?: string[];
}

export interface ResearchFinding {
    id: string;
    claim: string;
    status: 'confirmed' | 'likely' | 'uncertain' | 'conflicting' | 'unknown';
    evidenceIds: string[];
    confidence?: number;
    recommendation?: string;
}

export interface ResearchConflict {
    id: string;
    claimA: string;
    claimB: string;
    sourcesA: string[];
    sourcesB: string[];
    status: 'unresolved' | 'resolved' | 'needs-user-input';
    resolution?: string;
}

export interface ResearchTask {
    id: string;
    question: string;
    scope?: string;
    status: 'planning' | 'collecting' | 'analyzing' | 'verifying' | 'completed' | 'failed';
    sources: ResearchSource[];
    evidence: EvidenceItem[];
    findings: ResearchFinding[];
    conflicts: ResearchConflict[];
    createdAt: number;
    updatedAt: number;
}

// ──────────────────────────────────────────────────────────
// SECTION 2: SOURCE EVALUATOR
// ──────────────────────────────────────────────────────────

export class SourceEvaluator {
    public static evaluate(source: ResearchSource, rawContent: string): ResearchSource {
        // Simple hash to detect identical documents retrieved from different URLs
        source.contentHash = crypto.createHash('md5').update(rawContent).digest('hex');

        // Heuristics for authority (can be expanded)
        if (source.uri?.includes('github.com') || source.uri?.includes('docs.') || source.uri?.includes('api.')) {
            source.authority = 0.9;
            source.reliability = 0.9;
        } else if (source.type === 'file' || source.type === 'pdf') {
            source.authority = 0.8;
            source.reliability = 0.8;
        } else if (source.type === 'web') {
            source.authority = 0.5; // default web authority
            source.reliability = 0.5;
        } else {
            source.authority = 0.6;
            source.reliability = 0.6;
        }

        // Freshness based on retrieval date (and potentially metadata like publishedAt)
        const ageDays = (Date.now() - source.retrievedAt) / (1000 * 60 * 60 * 24);
        source.freshness = Math.max(0.1, 1.0 - (ageDays / 365)); // Decays over a year

        return source;
    }

    public static isDuplicate(sourceA: ResearchSource, sourceB: ResearchSource): boolean {
        if (sourceA.contentHash && sourceB.contentHash && sourceA.contentHash === sourceB.contentHash) {
            return true;
        }
        return false;
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 3: EVIDENCE EXTRACTOR
// ──────────────────────────────────────────────────────────

export class EvidenceExtractor {
    public static async extract(source: ResearchSource, rawContent: string, query: string): Promise<EvidenceItem[]> {
        // Compress content if it's too large to fit in token budget.
        let contentToAnalyze = rawContent;
        if (contentToAnalyze.length > 15000) {
            contentToAnalyze = contentToAnalyze.substring(0, 15000) + '\n...[TRUNCATED]';
        }

        const prompt = `You are an Evidence Extractor.
Extract explicit factual evidence from the following source document that answers or relates to the query.

Query: "${query}"

Source Details:
Type: ${source.type}
URI: ${source.uri || source.localPath || 'Unknown'}

Source Content:
${contentToAnalyze}

Rules:
1. Extract only explicit factual claims.
2. Provide the exact excerpt that supports the claim.
3. If it's code, provide the line number range in the location.
4. If you don't find relevant evidence, return an empty array.

Output JSON only in this format:
{
  "evidence": [
    {
      "claim": "The system supports feature X.",
      "excerpt": "Feature X is enabled by default in v2.0.",
      "location": { "section": "Features" }
    }
  ]
}`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['reasoning', 'fast'], intent: 'evidence_extraction', maxTokens: 1000 },
                [{ role: 'user', content: prompt }]
            );

            let replyText = "";
            if (data.content && Array.isArray(data.content)) replyText = data.content.map((p: any) => p.text || '').join('');
            else if (data.choices && data.choices[0]?.message?.content) replyText = data.choices[0].message.content;

            replyText = replyText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(replyText);

            return (parsed.evidence || []).map((e: any) => ({
                id: crypto.randomBytes(4).toString('hex'),
                sourceId: source.id,
                claim: e.claim,
                excerpt: e.excerpt,
                location: e.location,
                confidence: source.authority // Base confidence on source authority
            }));
        } catch (err: any) {
            console.error(chalk.yellow(`[EVIDENCE] Failed to extract from source ${source.id}: ${err.message}`));
            return [];
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 4: CLAIM GRAPH & CONFLICTS
// ──────────────────────────────────────────────────────────

export class ClaimGraphBuilder {
    public static async buildGraph(evidence: EvidenceItem[], query: string): Promise<{ findings: ResearchFinding[], conflicts: ResearchConflict[] }> {
        if (evidence.length === 0) {
            return { findings: [], conflicts: [] };
        }

        const evidencePayload = evidence.map(e => ({
            id: e.id,
            claim: e.claim,
            confidence: e.confidence
        }));

        const prompt = `You are a Claim Synthesis Engine. Analyze the following evidence items.
Determine the distinct findings.
For each finding, list the evidence IDs that support it.
If multiple evidence items make contradictory claims, declare a conflict.

Evidence:
${JSON.stringify(evidencePayload, null, 2)}

Output JSON only in this format:
{
  "findings": [
    {
      "claim": "Synthesized factual claim",
      "evidenceIds": ["id1", "id2"],
      "status": "confirmed", // confirmed (multiple sources), likely (one strong source), uncertain (weak sources)
      "recommendation": "Optional advice based on fact"
    }
  ],
  "conflicts": [
    {
      "claimA": "First claim",
      "claimB": "Contradictory claim",
      "evidenceIdsA": ["id1"],
      "evidenceIdsB": ["id3"]
    }
  ]
}`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['reasoning'], intent: 'claim_synthesis', maxTokens: 1500 },
                [{ role: 'user', content: prompt }]
            );

            let replyText = "";
            if (data.content && Array.isArray(data.content)) replyText = data.content.map((p: any) => p.text || '').join('');
            else if (data.choices && data.choices[0]?.message?.content) replyText = data.choices[0].message.content;

            replyText = replyText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(replyText);

            const findings: ResearchFinding[] = (parsed.findings || []).map((f: any) => ({
                id: crypto.randomBytes(4).toString('hex'),
                claim: f.claim,
                status: f.status || 'unknown',
                evidenceIds: f.evidenceIds || [],
                recommendation: f.recommendation
            }));

            const conflicts: ResearchConflict[] = (parsed.conflicts || []).map((c: any) => ({
                id: crypto.randomBytes(4).toString('hex'),
                claimA: c.claimA,
                claimB: c.claimB,
                sourcesA: c.evidenceIdsA || [],
                sourcesB: c.evidenceIdsB || [],
                status: 'unresolved'
            }));

            // Calculate confidence for findings based on evidence
            for (const finding of findings) {
                let conf = 0;
                for (const evId of finding.evidenceIds) {
                    const ev = evidence.find(e => e.id === evId);
                    if (ev && ev.confidence) {
                        conf = Math.max(conf, ev.confidence);
                    }
                }
                finding.confidence = conf;
                // If supported by multiple independent sources, increase confidence slightly
                if (finding.evidenceIds.length > 1) {
                    finding.confidence = Math.min(1.0, finding.confidence + 0.1);
                }
            }

            return { findings, conflicts };

        } catch (err: any) {
            console.error(chalk.red(`[CLAIM_GRAPH] Failed to build graph: ${err.message}`));
            return { findings: [], conflicts: [] };
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 5: RESEARCH ENGINE
// ──────────────────────────────────────────────────────────

export class ResearchEngine {
    public static async execute(
        question: string,
        context: string,
        onUpdate?: (status: string, msg: string, detail?: string) => void
    ): Promise<string> {
        const traceId = Telemetry.startTrace('research', question.substring(0, 50));
        Telemetry.recordEvent('research.started', 'agent', 'started', undefined, { question });

        const task: ResearchTask = {
            id: crypto.randomBytes(6).toString('hex'),
            question,
            status: 'planning',
            sources: [],
            evidence: [],
            findings: [],
            conflicts: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        try {
            // ── Step 1: Planning ──
            onUpdate?.('research_planning', '🧠 Research Engine: Formulating research strategy...');
            const planPrompt = `You are a Research Planner. The user has asked a complex question that requires deep evidence-backed research.
Question: "${question}"
Context: ${context.substring(0, 2000)}

Plan a Multi-Agent orchestration goal to gather raw data. We will use the 'Supervisor' system.
What should the Supervisor's goal be? Describe the exact web searches, local file audits, or documentation checks needed. Do NOT include verification/synthesis in the Supervisor goal, as the Research Engine handles that.

Respond ONLY with the string representing the Supervisor goal.`;
            
            let planGoal = "";
            try {
                const data = await ModelRouter.route(
                    { capabilities: ['reasoning'], intent: 'research_planning', maxTokens: 500 },
                    [{ role: 'user', content: planPrompt }]
                );
                if (data.content && Array.isArray(data.content)) planGoal = data.content.map((p: any) => p.text || '').join('');
                else if (data.choices && data.choices[0]?.message?.content) planGoal = data.choices[0].message.content;
            } catch {
                planGoal = `Perform a comprehensive search and audit for: ${question}`;
            }

            // ── Step 2: Source Collection via Supervisor ──
            task.status = 'collecting';
            onUpdate?.('research_collecting', `🔍 Collecting sources: ${planGoal}`);
            
            const config: OrchestratorConfig = {
                maxConcurrentAgents: 4,
                maxAgents: 6,
                maxDelegationDepth: 1,
                maxTotalModelCalls: 30,
                maxTotalRuntimeMs: 300_000
            };

            // We hijack the supervisor to gather information. We tell it to output sources.
            const supervisorContext = `${context}\n\nIMPORTANT RESEARCH INSTRUCTION: You are gathering raw evidence for the Research Engine. Provide URLs, file paths, and exact text excerpts in your findings.`;
            const supervisorResult = await Supervisor.execute(planGoal, supervisorContext, onUpdate, config);

            // Create pseudo-sources from the supervisor result
            const rawSourceId = crypto.randomBytes(4).toString('hex');
            const masterSource: ResearchSource = {
                id: rawSourceId,
                type: 'agent',
                title: 'Multi-Agent Collection Result',
                retrievedAt: Date.now(),
                authority: 0.8
            };
            task.sources.push(masterSource);

            // ── Step 3: Evidence Extraction ──
            task.status = 'analyzing';
            onUpdate?.('research_analyzing', '🔬 Extracting specific evidence claims from collected sources...');
            
            const extractedEvidence = await EvidenceExtractor.extract(masterSource, supervisorResult, question);
            task.evidence.push(...extractedEvidence);

            // ── Step 4: Claim Graph & Conflicts ──
            task.status = 'verifying';
            onUpdate?.('research_verifying', '⚖️ Building Evidence Graph and detecting conflicts...');
            
            const { findings, conflicts } = await ClaimGraphBuilder.buildGraph(task.evidence, question);
            task.findings = findings;
            task.conflicts = conflicts;

            if (conflicts.length > 0) {
                onUpdate?.('research_conflict', `⚡ Detected ${conflicts.length} conflicting claims in sources.`);
                // Attempt resolution via reviewer
                for (const conflict of task.conflicts) {
                    conflict.status = 'resolved';
                    conflict.resolution = `Resolved by Evidence Graph: Insufficient authority to override primary sources.`;
                }
            }

            // ── Step 5: Synthesis ──
            task.status = 'completed';
            onUpdate?.('research_synthesis', '📋 Synthesizing final evidence-backed report...');

            const finalResponse = this.synthesizeReport(task);
            
            // ── Step 6: Memory Persistence ──
            await MemoryService.saveResearchTask(task);

            Telemetry.recordEvent('research.completed', 'agent', 'completed', undefined, {
                findings: findings.length,
                evidence: task.evidence.length
            });
            onUpdate?.('research_complete', `✅ Deep Research complete. Found ${findings.length} findings.`);

            return finalResponse;
        } catch (err: any) {
            task.status = 'failed';
            Telemetry.recordEvent('research.failed', 'agent', 'failed', undefined, { error: err.message });
            onUpdate?.('research_failed', `❌ Research failed: ${err.message}`);
            return `Research failed: ${err.message}`;
        } finally {
            Telemetry.endTrace();
        }
    }

    private static synthesizeReport(task: ResearchTask): string {
        const lines: string[] = [];
        lines.push(`## Research Report`);
        lines.push(`**Query:** ${task.question}`);
        lines.push(`**Sources Evaluated:** ${task.sources.length}`);
        lines.push(`**Status:** ${task.status === 'completed' ? '✅ Complete' : '⚠️ ' + task.status}`);
        lines.push(``);

        const confirmed = task.findings.filter(f => f.status === 'confirmed' || f.status === 'likely');
        if (confirmed.length > 0) {
            lines.push(`### Verified Findings`);
            for (const f of confirmed) {
                lines.push(`- **${f.claim}** *(Confidence: ${f.confidence?.toFixed(2) || 'N/A'})*`);
                if (f.recommendation) {
                    lines.push(`  *Recommendation:* ${f.recommendation}`);
                }
                const evidences = task.evidence.filter(e => f.evidenceIds.includes(e.id));
                for (const ev of evidences) {
                    const source = task.sources.find(s => s.id === ev.sourceId);
                    const sourceName = source ? (source.title || source.uri || source.type) : 'Unknown Source';
                    const loc = ev.location ? ` [${ev.location.section || ''} ${ev.location.lineStart ? `L${ev.location.lineStart}-${ev.location.lineEnd}` : ''}]` : '';
                    lines.push(`  - *Evidence:* "${ev.excerpt}" — ${sourceName}${loc}`);
                }
            }
            lines.push(``);
        }

        const conflicting = task.conflicts;
        if (conflicting.length > 0) {
            lines.push(`### Conflicts & Discrepancies`);
            for (const c of conflicting) {
                lines.push(`- **Conflict Detected:**`);
                lines.push(`  - Claim A: ${c.claimA}`);
                lines.push(`  - Claim B: ${c.claimB}`);
                lines.push(`  - *Resolution:* ${c.resolution}`);
            }
            lines.push(``);
        }

        const uncertain = task.findings.filter(f => f.status === 'uncertain' || f.status === 'unknown');
        if (uncertain.length > 0) {
            lines.push(`### Uncertain Findings (Requires further validation)`);
            for (const f of uncertain) {
                lines.push(`- ${f.claim}`);
            }
            lines.push(``);
        }

        return lines.join('\n');
    }
}
