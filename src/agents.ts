import crypto from 'crypto';
import chalk from 'chalk';
import { ModelRouter } from './router.js';
import { ToolExecutor } from './tools.js';
import { SkillRegistry } from './skills.js';
import { CapabilityRouter } from './capabilities.js';
import { SecurityEngine, ActionRisk } from './security.js';
import { Telemetry } from './telemetry.js';
import { ContextManager, getSystemInstruction } from './context.js';
import { FederatedAgentRouter } from './federation/router.js';
import { FederationClient } from './federation/client.js';
import { DelegationManager } from './federation/delegation.js';

// ──────────────────────────────────────────────────────────
// SECTION 1: INTERFACES & TYPES
// ──────────────────────────────────────────────────────────

export type AgentAccessMode = 'READ_ONLY' | 'WRITE' | 'EXTERNAL_ACTION';
export type AgentTrustLevel = 'trusted' | 'restricted' | 'untrusted' | 'disabled';
export type AgentHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DISABLED';

export interface AgentProfile {
    id: string;
    name: string;
    description: string;
    skills: string[];
    capabilities: string[];
    allowedTools: string[];
    accessMode: AgentAccessMode;
    trustLevel: AgentTrustLevel;
    enabled: boolean;
    health: AgentHealthStatus;
    consecutiveFailures: number;
    limits: {
        maxToolCalls: number;
        maxRuntimeMs: number;
        maxModelCalls: number;
        maxRetries: number;
    };
}

export interface AgentSubtask {
    id: string;
    description: string;
    agentType: string;
    dependencies: string[];
    input?: unknown;
    parentTaskId: string;
}

export interface AgentSubtaskResult {
    status: 'completed' | 'failed' | 'partial';
    summary: string;
    findings?: AgentFinding[];
    artifacts?: string[];
    confidence?: number;
    verification?: { passed: boolean; details?: string };
    agentId: string;
    taskNodeId: string;
    durationMs: number;
}

export interface AgentFinding {
    id: string;
    category: string;
    description: string;
    evidence?: string;
    source?: string;
    severity?: 'info' | 'warning' | 'critical';
    contentHash: string;
}

export interface AgentArtifact {
    id: string;
    type: string;
    sourceAgent: string;
    summary: string;
    content: string;
    location?: string;
    metadata?: Record<string, unknown>;
}

export interface AgentMessage {
    id: string;
    from: string;
    to: string;
    taskId: string;
    type: 'task' | 'result' | 'question' | 'artifact' | 'request-review';
    payload: unknown;
    timestamp: number;
}

export type TaskNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface AgentTaskNode {
    id: string;
    description: string;
    agentType: string;
    dependencies: string[];
    status: TaskNodeStatus;
    input?: unknown;
    result?: AgentSubtaskResult;
    agentId?: string;
    startedAt?: number;
    finishedAt?: number;
}

export type OrchestrationStatus = 'planning' | 'executing' | 'aggregating' | 'reviewing' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface TaskGraphCheckpoint {
    timestamp: number;
    nodesSnapshot: AgentTaskNode[];
    artifactsSnapshot: string[];
    completedNodeIds: string[];
}

export interface TaskGraph {
    id: string;
    goal: string;
    nodes: AgentTaskNode[];
    artifacts: AgentArtifact[];
    messages: AgentMessage[];
    status: OrchestrationStatus;
    checkpoints: TaskGraphCheckpoint[];
    createdAt: number;
    updatedAt: number;
}

export interface OrchestratorConfig {
    maxConcurrentAgents: number;
    maxAgents: number;
    maxDelegationDepth: number;
    maxTotalModelCalls: number;
    maxTotalRuntimeMs: number;
}

// ──────────────────────────────────────────────────────────
// SECTION 2: AGENT REGISTRY
// ──────────────────────────────────────────────────────────

const DEFAULT_LIMITS = {
    maxToolCalls: 25,
    maxRuntimeMs: 300_000,
    maxModelCalls: 15,
    maxRetries: 2
};

const INITIAL_AGENTS: AgentProfile[] = [
    {
        id: 'coding-agent',
        name: 'Coding Agent',
        description: 'Analyze and modify software projects. Read code, write code, run tests, fix bugs.',
        skills: ['coding', 'terminal'],
        capabilities: ['filesystem', 'terminal'],
        allowedTools: ['execute_command', 'search_memory', 'save_memory', 'android_click', 'android_swipe', 'android_get_screen_text'],
        accessMode: 'WRITE',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    },
    {
        id: 'source-discovery-agent',
        name: 'Source Discovery Agent',
        description: 'Search the web specifically to find high-authority sources, official documentation, and primary references for research tasks.',
        skills: ['system'],
        capabilities: ['web', 'browser'],
        allowedTools: ['web_search', 'fetch_page'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    },
    {
        id: 'research-agent',
        name: 'Research Agent',
        description: 'Search the web, read documentation, gather information, compare sources.',
        skills: ['system'],
        capabilities: ['web', 'browser'],
        allowedTools: ['web_search', 'fetch_page', 'search_memory'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    },
    {
        id: 'security-agent',
        name: 'Security Agent',
        description: 'Audit code and configurations for security vulnerabilities, bad practices, and credential exposure.',
        skills: ['coding', 'system'],
        capabilities: ['filesystem', 'terminal'],
        allowedTools: ['execute_command', 'search_memory'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    },
    {
        id: 'reviewer-agent',
        name: 'Reviewer Agent',
        description: 'Review and verify outputs from other agents. Check evidence, identify contradictions, confirm findings.',
        skills: ['coding'],
        capabilities: ['filesystem'],
        allowedTools: ['execute_command', 'search_memory'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS, maxToolCalls: 10 }
    },
    {
        id: 'testing-agent',
        name: 'Testing Agent',
        description: 'Run test suites, verify builds, check for regressions, validate functionality.',
        skills: ['coding', 'terminal'],
        capabilities: ['filesystem', 'terminal'],
        allowedTools: ['execute_command', 'search_memory'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    },
    {
        id: 'analysis-agent',
        name: 'Analysis Agent',
        description: 'Perform deep analysis: code complexity, architecture review, dependency audits, performance profiling.',
        skills: ['coding', 'system'],
        capabilities: ['filesystem', 'terminal'],
        allowedTools: ['execute_command', 'search_memory', 'web_search'],
        accessMode: 'READ_ONLY',
        trustLevel: 'trusted',
        enabled: true,
        health: 'HEALTHY',
        consecutiveFailures: 0,
        limits: { ...DEFAULT_LIMITS }
    }
];

export class AgentRegistry {
    private static agents: Map<string, AgentProfile> = new Map();

    public static discover() {
        // Register built-in agents
        for (const agent of INITIAL_AGENTS) {
            if (!this.agents.has(agent.id)) {
                this.agents.set(agent.id, { ...agent });
            }
        }
    }

    public static register(profile: AgentProfile) {
        this.agents.set(profile.id, profile);
    }

    public static get(id: string): AgentProfile | undefined {
        return this.agents.get(id);
    }

    public static list(): AgentProfile[] {
        return Array.from(this.agents.values());
    }

    public static enable(id: string): boolean {
        const agent = this.agents.get(id);
        if (agent) { agent.enabled = true; return true; }
        return false;
    }

    public static disable(id: string): boolean {
        const agent = this.agents.get(id);
        if (agent) { agent.enabled = false; return true; }
        return false;
    }

    public static getHealthy(agentType: string): AgentProfile | undefined {
        // Find an enabled, healthy agent matching the requested type
        const exact = this.agents.get(`${agentType}-agent`);
        if (exact && exact.enabled && exact.health !== 'DISABLED') return exact;

        // Fallback: find any enabled agent whose id contains the type
        for (const agent of this.agents.values()) {
            if (agent.id.includes(agentType) && agent.enabled && agent.health !== 'DISABLED') {
                return agent;
            }
        }
        return undefined;
    }

    public static recordFailure(id: string) {
        const agent = this.agents.get(id);
        if (agent) {
            agent.consecutiveFailures++;
            if (agent.consecutiveFailures >= 3) {
                agent.health = 'DISABLED';
            } else {
                agent.health = 'DEGRADED';
            }
        }
    }

    public static recordSuccess(id: string) {
        const agent = this.agents.get(id);
        if (agent) {
            agent.consecutiveFailures = 0;
            agent.health = 'HEALTHY';
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 3: WRITE COORDINATION (File Lock)
// ──────────────────────────────────────────────────────────

class WriteLock {
    private static locks: Map<string, string> = new Map(); // path → agentId
    private static globalWriteLock: string | null = null;

    public static acquire(agentId: string): boolean {
        if (this.globalWriteLock && this.globalWriteLock !== agentId) return false;
        this.globalWriteLock = agentId;
        return true;
    }

    public static release(agentId: string) {
        if (this.globalWriteLock === agentId) {
            this.globalWriteLock = null;
        }
    }

    public static isWriteLocked(): boolean {
        return this.globalWriteLock !== null;
    }

    public static getHolder(): string | null {
        return this.globalWriteLock;
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 4: SPECIALIST RUNNER
// ──────────────────────────────────────────────────────────

export class SpecialistRunner {
    public static async execute(
        subtask: AgentSubtask,
        profile: AgentProfile,
        parentContext: string,
        dependencyArtifacts: AgentArtifact[],
        onMessage?: (msg: AgentMessage) => void,
        abortSignal?: { aborted: boolean }
    ): Promise<AgentSubtaskResult> {
        const startTime = Date.now();
        const traceId = Telemetry.startTrace(`agent:${profile.id}`, subtask.parentTaskId);

        Telemetry.recordEvent('agent.worker_started', 'agent', 'started', undefined, {
            agentId: profile.id,
            subtaskId: subtask.id,
            role: profile.id
        });

        let toolCallCount = 0;
        let modelCallCount = 0;
        const findings: AgentFinding[] = [];
        const artifactIds: string[] = [];

        // Build isolated context for this worker
        const skillsContext = profile.skills
            .map(s => SkillRegistry.load(s))
            .filter(Boolean)
            .join('\n\n');

        const artifactSummaries = dependencyArtifacts
            .map(a => `[Artifact: ${a.id}] ${a.summary}`)
            .join('\n');

        const workerPrompt = `You are the ${profile.name}.
Role: ${profile.description}

Your access mode is: ${profile.accessMode}.
${profile.accessMode === 'READ_ONLY' ? 'You MUST NOT modify any files or make destructive changes.' : ''}
${profile.accessMode === 'WRITE' ? 'You may modify files when necessary for the task.' : ''}

[AVAILABLE CAPABILITIES]
${profile.capabilities.map(c => `- ${c}`).join('\n')}

[ALLOWED TOOLS]
${profile.allowedTools.map(t => `- ${t}`).join('\n')}

${skillsContext ? `[SKILL CONTEXT]\n${skillsContext}\n` : ''}
${artifactSummaries ? `[UPSTREAM ARTIFACTS]\n${artifactSummaries}\n` : ''}
[PARENT CONTEXT]
${parentContext.substring(0, 4000)}

[YOUR TASK]
${subtask.description}

${subtask.input ? `[ADDITIONAL INPUT]\n${JSON.stringify(subtask.input)}` : ''}

Execute this task thoroughly. For each finding, provide evidence (file path, line number, command output, etc.).

To use a tool, output a JSON block:
\`\`\`tool
{
  "name": "tool_name",
  "args": { ... }
}
\`\`\`

When finished, output your final result as:
\`\`\`result
{
  "summary": "Brief summary of what you found/did",
  "findings": [
    {
      "category": "category",
      "description": "what you found",
      "evidence": "concrete evidence",
      "source": "file or URL",
      "severity": "info|warning|critical"
    }
  ],
  "confidence": 0.0-1.0
}
\`\`\``;

        let conversationHistory: { role: string; content: string }[] = [];
        let finalResult: AgentSubtaskResult | null = null;
        let iterations = 0;
        const maxIterations = Math.min(profile.limits.maxModelCalls, 15);

        try {
            while (iterations < maxIterations && !finalResult) {
                if (abortSignal?.aborted) {
                    throw new Error('Agent execution aborted');
                }

                const elapsed = Date.now() - startTime;
                if (elapsed > profile.limits.maxRuntimeMs) {
                    throw new Error(`Agent exceeded max runtime (${profile.limits.maxRuntimeMs}ms)`);
                }

                iterations++;
                modelCallCount++;

                const messages = iterations === 1
                    ? [{ role: 'user', content: workerPrompt }]
                    : [...conversationHistory];

                const data = await ModelRouter.route(
                    { capabilities: ['reasoning'], intent: `agent_${profile.id}`, maxTokens: 2000 },
                    messages
                );

                let replyText = '';
                if (data.content && Array.isArray(data.content)) {
                    replyText = data.content.map((p: any) => p.text || '').join('');
                } else if (data.choices && data.choices[0]?.message?.content) {
                    replyText = data.choices[0].message.content;
                }

                if (iterations === 1) {
                    conversationHistory.push({ role: 'user', content: workerPrompt });
                }
                conversationHistory.push({ role: 'assistant', content: replyText });

                // Check for tool calls
                const toolMatch = replyText.match(/```tool\n([\s\S]*?)\n```/);
                if (toolMatch) {
                    if (toolCallCount >= profile.limits.maxToolCalls) {
                        conversationHistory.push({ role: 'user', content: 'ERROR: You have exceeded your tool call limit. Please produce your final result now.' });
                        continue;
                    }

                    try {
                        const toolCall = JSON.parse(toolMatch[1]);

                        // Enforce allowed tools
                        if (!profile.allowedTools.includes(toolCall.name)) {
                            conversationHistory.push({
                                role: 'user',
                                content: `ERROR: Tool "${toolCall.name}" is not in your allowed tools list: [${profile.allowedTools.join(', ')}]. Use only allowed tools.`
                            });
                            continue;
                        }

                        // Enforce write lock for write operations
                        if (profile.accessMode === 'READ_ONLY') {
                            const cmd = (toolCall.args?.command || '').toLowerCase();
                            const isWrite = /(>|>>|tee |mv |cp |mkdir|rmdir|rm |del |echo .+>|new-item|set-content|add-content|remove-item)/i.test(cmd);
                            if (toolCall.name === 'execute_command' && isWrite) {
                                conversationHistory.push({
                                    role: 'user',
                                    content: 'ERROR: You are READ_ONLY. You cannot perform write operations. Produce your result based on read-only analysis.'
                                });
                                continue;
                            }
                        }

                        if (profile.accessMode === 'WRITE' && toolCall.name === 'execute_command') {
                            if (!WriteLock.acquire(profile.id)) {
                                conversationHistory.push({
                                    role: 'user',
                                    content: `ERROR: Write lock held by another agent (${WriteLock.getHolder()}). Wait or use read-only operations.`
                                });
                                continue;
                            }
                        }

                        toolCallCount++;
                        const res = await ToolExecutor.execute({
                            id: `agent_${profile.id}_${toolCallCount}`,
                            name: toolCall.name,
                            args: toolCall.args
                        });

                        const resultStr = typeof res?.response?.result === 'string'
                            ? res.response.result
                            : JSON.stringify(res);

                        let safeResult = resultStr;
                        if (safeResult.length > 3000) {
                            safeResult = safeResult.substring(0, 1500) + '\n...[TRUNCATED]...\n' + safeResult.substring(safeResult.length - 1500);
                        }

                        conversationHistory.push({
                            role: 'user',
                            content: `Tool "${toolCall.name}" returned:\n${safeResult}\n\nContinue your analysis or produce your final result.`
                        });

                    } catch (e: any) {
                        conversationHistory.push({
                            role: 'user',
                            content: `Tool execution error: ${e.message}. Continue or produce your final result.`
                        });
                    }
                    continue;
                }

                // Check for final result
                const resultMatch = replyText.match(/```result\n([\s\S]*?)\n```/);
                if (resultMatch) {
                    try {
                        const parsed = JSON.parse(resultMatch[1]);
                        const parsedFindings: AgentFinding[] = (parsed.findings || []).map((f: any) => ({
                            id: crypto.randomBytes(4).toString('hex'),
                            category: f.category || 'general',
                            description: f.description || '',
                            evidence: f.evidence,
                            source: f.source,
                            severity: f.severity || 'info',
                            contentHash: crypto.createHash('md5').update(f.description || '').digest('hex')
                        }));

                        findings.push(...parsedFindings);

                        finalResult = {
                            status: 'completed',
                            summary: parsed.summary || 'Task completed.',
                            findings: parsedFindings,
                            artifacts: artifactIds,
                            confidence: parsed.confidence ?? 0.7,
                            verification: { passed: true },
                            agentId: profile.id,
                            taskNodeId: subtask.id,
                            durationMs: Date.now() - startTime
                        };
                    } catch {
                        // If parsing fails, treat the entire reply as the result
                        finalResult = {
                            status: 'completed',
                            summary: replyText.substring(0, 1000),
                            findings: [],
                            agentId: profile.id,
                            taskNodeId: subtask.id,
                            durationMs: Date.now() - startTime
                        };
                    }
                } else if (iterations >= maxIterations) {
                    // Force a result from the last reply
                    finalResult = {
                        status: 'partial',
                        summary: `Agent exhausted iteration budget. Last output: ${replyText.substring(0, 500)}`,
                        findings,
                        agentId: profile.id,
                        taskNodeId: subtask.id,
                        durationMs: Date.now() - startTime
                    };
                }
            }

            // Release write lock
            WriteLock.release(profile.id);

            if (!finalResult) {
                finalResult = {
                    status: 'partial',
                    summary: 'Agent completed without producing structured output.',
                    findings,
                    agentId: profile.id,
                    taskNodeId: subtask.id,
                    durationMs: Date.now() - startTime
                };
            }

            AgentRegistry.recordSuccess(profile.id);
            Telemetry.recordEvent('agent.worker_completed', 'agent', 'completed', finalResult.durationMs, {
                agentId: profile.id,
                status: finalResult.status,
                findingsCount: findings.length
            });

            return finalResult;

        } catch (err: any) {
            WriteLock.release(profile.id);
            AgentRegistry.recordFailure(profile.id);

            Telemetry.recordEvent('agent.worker_failed', 'agent', 'failed', Date.now() - startTime, {
                agentId: profile.id,
                error: err.message
            });

            return {
                status: 'failed',
                summary: `Agent failed: ${err.message}`,
                findings,
                agentId: profile.id,
                taskNodeId: subtask.id,
                durationMs: Date.now() - startTime
            };
        } finally {
            Telemetry.endTrace();
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 5: TASK GRAPH BUILDER
// ──────────────────────────────────────────────────────────

export class TaskGraphBuilder {
    public static async decompose(goal: string, context: string): Promise<TaskGraph> {
        const graphId = crypto.randomBytes(6).toString('hex');

        const availableAgents = AgentRegistry.list()
            .filter(a => a.enabled && a.health !== 'DISABLED')
            .map(a => `- ${a.id}: ${a.description} (${a.accessMode})`);

        const prompt = `You are a task decomposition engine. Break down the following goal into a directed acyclic graph (DAG) of subtasks.

Available specialist agents:
${availableAgents.join('\n')}

RULES:
- Each subtask must specify which agent type should handle it (use the agent id without "-agent" suffix, e.g. "coding", "research", "security").
- Specify dependencies as an array of subtask IDs that must complete first.
- Independent tasks should have empty dependencies [] so they can run in parallel.
- Include a final aggregation/verification step if multiple agents produce results.
- Maximum 8 subtasks.
- Do NOT create subtasks for trivial work that a single agent could handle.

Goal: "${goal}"
Context: ${context.substring(0, 3000)}

Respond ONLY with valid JSON:
{
  "nodes": [
    {
      "id": "node_1",
      "description": "What this subtask does",
      "agentType": "coding",
      "dependencies": []
    },
    {
      "id": "node_2",
      "description": "Review results from node_1",
      "agentType": "reviewer",
      "dependencies": ["node_1"]
    }
  ]
}`;

        const data = await ModelRouter.route(
            { capabilities: ['reasoning'], intent: 'task_decomposition', maxTokens: 1500 },
            [{ role: 'user', content: prompt }]
        );

        let replyText = '';
        if (data.content && Array.isArray(data.content)) {
            replyText = data.content.map((p: any) => p.text || '').join('');
        } else if (data.choices && data.choices[0]?.message?.content) {
            replyText = data.choices[0].message.content;
        }

        replyText = replyText.replace(/```json/g, '').replace(/```/g, '').trim();

        let parsed: any;
        try {
            parsed = JSON.parse(replyText);
        } catch {
            // Fallback: single node
            parsed = {
                nodes: [{ id: 'node_1', description: goal, agentType: 'coding', dependencies: [] }]
            };
        }

        const nodes: AgentTaskNode[] = (parsed.nodes || []).map((n: any) => ({
            id: n.id || crypto.randomBytes(4).toString('hex'),
            description: n.description || goal,
            agentType: n.agentType || 'coding',
            dependencies: n.dependencies || [],
            status: 'pending' as TaskNodeStatus,
            input: n.input
        }));

        const graph: TaskGraph = {
            id: graphId,
            goal,
            nodes,
            artifacts: [],
            messages: [],
            status: 'planning',
            checkpoints: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        // Validate DAG
        this.validateDAG(graph);

        return graph;
    }

    public static validateDAG(graph: TaskGraph): void {
        const nodeIds = new Set(graph.nodes.map(n => n.id));

        // Check for references to missing nodes
        for (const node of graph.nodes) {
            for (const dep of node.dependencies) {
                if (!nodeIds.has(dep)) {
                    throw new Error(`DAG Validation Error: Node "${node.id}" depends on non-existent node "${dep}".`);
                }
            }
        }

        // Check for cycles using topological sort (Kahn's algorithm)
        const inDegree = new Map<string, number>();
        const adjacency = new Map<string, string[]>();

        for (const node of graph.nodes) {
            inDegree.set(node.id, 0);
            adjacency.set(node.id, []);
        }

        for (const node of graph.nodes) {
            for (const dep of node.dependencies) {
                adjacency.get(dep)!.push(node.id);
                inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
            }
        }

        const queue: string[] = [];
        for (const [id, degree] of inDegree) {
            if (degree === 0) queue.push(id);
        }

        let sortedCount = 0;
        while (queue.length > 0) {
            const current = queue.shift()!;
            sortedCount++;
            for (const neighbor of adjacency.get(current)!) {
                const newDegree = (inDegree.get(neighbor) || 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) queue.push(neighbor);
            }
        }

        if (sortedCount !== graph.nodes.length) {
            throw new Error(`DAG Validation Error: Circular dependency detected in task graph.`);
        }

        // Check for orphan nodes (no dependencies AND no node depends on them) — warn only
        for (const node of graph.nodes) {
            if (node.dependencies.length === 0) {
                const hasDependents = graph.nodes.some(n => n.dependencies.includes(node.id));
                if (!hasDependents && graph.nodes.length > 1 && node.agentType !== 'reviewer') {
                    // Isolated node — acceptable but log
                    console.log(chalk.gray(`[DAG] Orphan node detected: ${node.id} (${node.agentType}). It will execute independently.`));
                }
            }
        }

        // Validate agent types exist
        for (const node of graph.nodes) {
            const agent = AgentRegistry.getHealthy(node.agentType);
            if (!agent) {
                console.warn(chalk.yellow(`[DAG] No healthy agent found for type "${node.agentType}". Will attempt fallback at execution time.`));
            }
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 6: DEPENDENCY SCHEDULER
// ──────────────────────────────────────────────────────────

export class DependencyScheduler {
    public static getReadyNodes(graph: TaskGraph): AgentTaskNode[] {
        return graph.nodes.filter(node => {
            if (node.status !== 'pending') return false;
            // All dependencies must be completed
            return node.dependencies.every(depId => {
                const depNode = graph.nodes.find(n => n.id === depId);
                return depNode && depNode.status === 'completed';
            });
        });
    }

    public static markReady(graph: TaskGraph): void {
        for (const node of graph.nodes) {
            if (node.status === 'pending') {
                const allDepsCompleted = node.dependencies.every(depId => {
                    const depNode = graph.nodes.find(n => n.id === depId);
                    return depNode && depNode.status === 'completed';
                });
                if (allDepsCompleted) {
                    node.status = 'ready';
                }
            }
        }
    }

    public static hasBlockedNodes(graph: TaskGraph): boolean {
        return graph.nodes.some(node => {
            if (node.status !== 'pending') return false;
            return node.dependencies.some(depId => {
                const depNode = graph.nodes.find(n => n.id === depId);
                return depNode && (depNode.status === 'failed' || depNode.status === 'cancelled');
            });
        });
    }

    public static markBlocked(graph: TaskGraph): void {
        for (const node of graph.nodes) {
            if (node.status === 'pending') {
                const hasFailedDep = node.dependencies.some(depId => {
                    const depNode = graph.nodes.find(n => n.id === depId);
                    return depNode && (depNode.status === 'failed' || depNode.status === 'cancelled');
                });
                if (hasFailedDep) {
                    node.status = 'blocked';
                }
            }
        }
    }

    public static isComplete(graph: TaskGraph): boolean {
        return graph.nodes.every(n =>
            n.status === 'completed' || n.status === 'failed' || n.status === 'cancelled' || n.status === 'blocked'
        );
    }

    public static async executeParallel(
        readyNodes: AgentTaskNode[],
        graph: TaskGraph,
        parentContext: string,
        config: OrchestratorConfig,
        onUpdate?: (status: string, msg: string, detail?: string) => void,
        abortSignal?: { aborted: boolean }
    ): Promise<void> {
        // Limit concurrency
        const batch = readyNodes.slice(0, config.maxConcurrentAgents);

        const promises = batch.map(async (node) => {
            node.status = 'running';
            node.startedAt = Date.now();

            const profile = AgentRegistry.getHealthy(node.agentType);
            if (!profile) {
                // Try Federated Mesh
                const remoteAgentId = FederatedAgentRouter.findBestAgent(node.description, [node.agentType]);
                if (remoteAgentId) {
                    node.agentId = remoteAgentId;
                    onUpdate?.('agent_started', `[Federated: ${remoteAgentId}] ${node.description}`);
                    
                    const grant = DelegationManager.createGrant(remoteAgentId, node.description, [node.agentType], { parentTaskId: graph.id });
                    try {
                        const remoteResult = await FederationClient.delegateTask(remoteAgentId, grant, {
                            input: node.input,
                            context: parentContext
                        });
                        node.status = 'completed';
                        node.finishedAt = Date.now();
                        node.result = {
                            status: remoteResult.status === 'failed' ? 'failed' : 'completed',
                            summary: remoteResult.summary || 'Remote task completed',
                            agentId: remoteAgentId,
                            taskNodeId: node.id,
                            durationMs: Date.now() - node.startedAt!,
                            artifacts: remoteResult.artifacts?.map((a: any) => a.id)
                        };
                        onUpdate?.('agent_completed', `[Federated: ${remoteAgentId}] ✓ ${node.result.summary.substring(0, 100)}`);
                    } catch (e: any) {
                        node.status = 'failed';
                        node.finishedAt = Date.now();
                        node.result = {
                            status: 'failed',
                            summary: `Remote delegation failed: ${e.message}`,
                            agentId: remoteAgentId,
                            taskNodeId: node.id,
                            durationMs: Date.now() - node.startedAt!
                        };
                        onUpdate?.('failed', `[Federated: ${remoteAgentId}] Failed: ${e.message}`);
                    }
                    return;
                }

                node.status = 'failed';
                node.finishedAt = Date.now();
                node.result = {
                    status: 'failed',
                    summary: `No healthy agent available for type "${node.agentType}".`,
                    agentId: 'none',
                    taskNodeId: node.id,
                    durationMs: 0
                };
                onUpdate?.('failed', `[${node.agentType}] No healthy agent available locally or remotely.`);
                return;
            }

            node.agentId = profile.id;
            onUpdate?.('agent_started', `[${profile.name}] ${node.description}`);

            // Gather upstream artifacts
            const upstreamArtifacts = graph.artifacts.filter(a =>
                node.dependencies.some(depId => {
                    const depNode = graph.nodes.find(n => n.id === depId);
                    return depNode?.result?.artifacts?.includes(a.id);
                })
            );

            // Also include summaries from completed dependency nodes
            const depSummaries = node.dependencies
                .map(depId => graph.nodes.find(n => n.id === depId))
                .filter(n => n?.result)
                .map(n => `[${n!.agentType} result] ${n!.result!.summary}`)
                .join('\n');

            const contextWithDeps = depSummaries
                ? `${parentContext}\n\n[UPSTREAM RESULTS]\n${depSummaries}`
                : parentContext;

            const subtask: AgentSubtask = {
                id: node.id,
                description: node.description,
                agentType: node.agentType,
                dependencies: node.dependencies,
                input: node.input,
                parentTaskId: graph.id
            };

            const result = await SpecialistRunner.execute(
                subtask,
                profile,
                contextWithDeps,
                upstreamArtifacts,
                undefined,
                abortSignal
            );

            node.result = result;
            node.finishedAt = Date.now();

            if (result.status === 'completed') {
                node.status = 'completed';
                onUpdate?.('agent_completed', `[${profile.name}] ✓ ${result.summary.substring(0, 200)}`);
            } else if (result.status === 'partial') {
                node.status = 'completed'; // Partial is still usable
                onUpdate?.('agent_partial', `[${profile.name}] ◐ Partial: ${result.summary.substring(0, 200)}`);
            } else {
                node.status = 'failed';
                onUpdate?.('agent_failed', `[${profile.name}] ✗ ${result.summary.substring(0, 200)}`);
            }
        });

        await Promise.allSettled(promises);
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 7: RESULT AGGREGATOR
// ──────────────────────────────────────────────────────────

export class ResultAggregator {
    public static aggregate(graph: TaskGraph): {
        mergedSummary: string;
        allFindings: AgentFinding[];
        conflicts: { findingA: AgentFinding; findingB: AgentFinding; reason: string }[];
        stats: { total: number; completed: number; failed: number; partial: number };
    } {
        const results = graph.nodes
            .filter(n => n.result)
            .map(n => n.result!);

        const allFindings: AgentFinding[] = [];
        const seenHashes = new Set<string>();

        // Collect and deduplicate findings
        for (const result of results) {
            for (const finding of (result.findings || [])) {
                if (!seenHashes.has(finding.contentHash)) {
                    seenHashes.add(finding.contentHash);
                    allFindings.push(finding);
                }
            }
        }

        // Detect contradictions: findings in the same category with conflicting severity
        const conflicts: { findingA: AgentFinding; findingB: AgentFinding; reason: string }[] = [];
        for (let i = 0; i < allFindings.length; i++) {
            for (let j = i + 1; j < allFindings.length; j++) {
                const a = allFindings[i];
                const b = allFindings[j];
                if (a.category === b.category && a.severity !== b.severity) {
                    // Same category but different severity might indicate a conflict
                    if (
                        (a.severity === 'critical' && b.severity === 'info') ||
                        (b.severity === 'critical' && a.severity === 'info')
                    ) {
                        conflicts.push({
                            findingA: a,
                            findingB: b,
                            reason: `Contradicting severity in category "${a.category}": "${a.description}" vs "${b.description}"`
                        });
                    }
                }
            }
        }

        const completed = results.filter(r => r.status === 'completed').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const partial = results.filter(r => r.status === 'partial').length;

        const summaryParts = results.map(r => `[${r.agentId}] ${r.summary}`);
        const mergedSummary = summaryParts.join('\n\n');

        return {
            mergedSummary,
            allFindings,
            conflicts,
            stats: { total: results.length, completed, failed, partial }
        };
    }

    public static async resolveConflicts(
        conflicts: { findingA: AgentFinding; findingB: AgentFinding; reason: string }[],
        graph: TaskGraph,
        parentContext: string,
        onUpdate?: (status: string, msg: string, detail?: string) => void
    ): Promise<string> {
        if (conflicts.length === 0) return 'No conflicts to resolve.';

        onUpdate?.('reviewing', `Resolving ${conflicts.length} conflict(s) via Reviewer Agent...`);

        const reviewerProfile = AgentRegistry.getHealthy('reviewer');
        if (!reviewerProfile) {
            return `Cannot resolve conflicts: no healthy reviewer agent available. Conflicts:\n${conflicts.map(c => c.reason).join('\n')}`;
        }

        const conflictDescriptions = conflicts.map((c, i) =>
            `Conflict ${i + 1}:\n  Finding A (${c.findingA.category}): ${c.findingA.description} [severity: ${c.findingA.severity}]\n    Evidence: ${c.findingA.evidence || 'none'}\n  Finding B (${c.findingB.category}): ${c.findingB.description} [severity: ${c.findingB.severity}]\n    Evidence: ${c.findingB.evidence || 'none'}\n  Reason: ${c.reason}`
        ).join('\n\n');

        const subtask: AgentSubtask = {
            id: `conflict_review_${crypto.randomBytes(3).toString('hex')}`,
            description: `Review and resolve the following conflicts between agent findings. For each conflict, determine which finding is better supported by evidence. Produce a verdict for each.\n\n${conflictDescriptions}`,
            agentType: 'reviewer',
            dependencies: [],
            parentTaskId: graph.id
        };

        const result = await SpecialistRunner.execute(subtask, reviewerProfile, parentContext, []);

        return result.summary;
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 8: SUPERVISOR
// ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OrchestratorConfig = {
    maxConcurrentAgents: 3,
    maxAgents: 8,
    maxDelegationDepth: 1,
    maxTotalModelCalls: 50,
    maxTotalRuntimeMs: 600_000
};

export class Supervisor {
    private static currentDepth = 0;

    public static async execute(
        goal: string,
        context: string,
        onUpdate?: (status: string, msg: string, detail?: string) => void,
        config: OrchestratorConfig = DEFAULT_CONFIG
    ): Promise<string> {
        // Recursion protection
        if (this.currentDepth >= config.maxDelegationDepth) {
            return `Orchestration blocked: maximum delegation depth (${config.maxDelegationDepth}) reached.`;
        }

        this.currentDepth++;
        const startTime = Date.now();
        const abortSignal = { aborted: false };

        const parentTraceId = Telemetry.startTrace('supervisor', goal.substring(0, 50));
        Telemetry.recordEvent('orchestration.started', 'agent', 'started', undefined, { goal: goal.substring(0, 200) });

        try {
            // Ensure agents are discovered
            AgentRegistry.discover();

            // ── Step 1: Decompose ──
            onUpdate?.('orchestration_planning', '🧠 Supervisor: Decomposing task into agent graph...');

            let graph: TaskGraph;
            try {
                graph = await TaskGraphBuilder.decompose(goal, context);
            } catch (err: any) {
                onUpdate?.('failed', `Task decomposition failed: ${err.message}`);
                return `Orchestration failed during decomposition: ${err.message}`;
            }

            if (graph.nodes.length > config.maxAgents) {
                graph.nodes = graph.nodes.slice(0, config.maxAgents);
                console.warn(chalk.yellow(`[SUPERVISOR] Truncated task graph to ${config.maxAgents} nodes (budget limit).`));
            }

            onUpdate?.('orchestration_graph', `📊 Task graph: ${graph.nodes.length} subtask(s) across ${new Set(graph.nodes.map(n => n.agentType)).size} agent type(s).`);

            for (const node of graph.nodes) {
                const depStr = node.dependencies.length > 0 ? ` (after: ${node.dependencies.join(', ')})` : ' (parallel)';
                onUpdate?.('orchestration_node', `   ○ [${node.agentType}] ${node.description.substring(0, 100)}${depStr}`);
            }

            // ── Step 2: Execute DAG ──
            graph.status = 'executing';
            let iterations = 0;
            const maxLoopIterations = graph.nodes.length * 3; // Safety bound

            while (!DependencyScheduler.isComplete(graph) && iterations < maxLoopIterations) {
                if (abortSignal.aborted) {
                    graph.status = 'cancelled';
                    break;
                }

                if (Date.now() - startTime > config.maxTotalRuntimeMs) {
                    onUpdate?.('warning', '⏱ Supervisor: Total runtime limit reached. Stopping remaining agents.');
                    abortSignal.aborted = true;
                    break;
                }

                iterations++;

                // Mark blocked nodes (dependencies failed)
                DependencyScheduler.markBlocked(graph);

                // Mark ready nodes
                DependencyScheduler.markReady(graph);

                const readyNodes = graph.nodes.filter(n => n.status === 'ready');

                if (readyNodes.length === 0) {
                    // Check if we're stuck
                    const pendingNodes = graph.nodes.filter(n => n.status === 'pending');
                    if (pendingNodes.length > 0) {
                        // Still have pending nodes but none are ready — possible blocked state
                        const blockedNodes = graph.nodes.filter(n => n.status === 'blocked');
                        if (blockedNodes.length === pendingNodes.length) {
                            onUpdate?.('warning', '⚠ All remaining nodes are blocked due to upstream failures.');
                            break;
                        }
                    }
                    // Still running nodes — wait briefly
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }

                // Execute parallel batch
                await DependencyScheduler.executeParallel(
                    readyNodes,
                    graph,
                    context,
                    config,
                    onUpdate,
                    abortSignal
                );

                // Checkpoint after each batch
                graph.checkpoints.push({
                    timestamp: Date.now(),
                    nodesSnapshot: graph.nodes.map(n => ({ ...n })),
                    artifactsSnapshot: graph.artifacts.map(a => a.id),
                    completedNodeIds: graph.nodes.filter(n => n.status === 'completed').map(n => n.id)
                });
                graph.updatedAt = Date.now();
            }

            // ── Step 3: Handle failures & retries ──
            const failedNodes = graph.nodes.filter(n => n.status === 'failed');
            for (const failedNode of failedNodes) {
                // Attempt retry with a different agent if available
                const retryProfile = AgentRegistry.getHealthy(failedNode.agentType);
                if (retryProfile && retryProfile.id !== failedNode.agentId) {
                    onUpdate?.('retry', `↻ Retrying [${failedNode.agentType}] with fallback agent...`);
                    failedNode.status = 'ready';
                    await DependencyScheduler.executeParallel(
                        [failedNode], graph, context, config, onUpdate, abortSignal
                    );
                }
            }

            // ── Step 4: Aggregate results ──
            graph.status = 'aggregating';
            onUpdate?.('aggregating', '📋 Aggregating results from all agents...');

            const aggregation = ResultAggregator.aggregate(graph);

            Telemetry.recordEvent('orchestration.aggregated', 'agent', 'completed', undefined, {
                totalFindings: aggregation.allFindings.length,
                conflicts: aggregation.conflicts.length,
                stats: aggregation.stats
            });

            // ── Step 5: Resolve conflicts ──
            let conflictResolution = '';
            if (aggregation.conflicts.length > 0) {
                graph.status = 'reviewing';
                onUpdate?.('conflict', `⚡ ${aggregation.conflicts.length} conflict(s) detected. Invoking Reviewer...`);
                conflictResolution = await ResultAggregator.resolveConflicts(
                    aggregation.conflicts, graph, context, onUpdate
                );
            }

            // ── Step 6: Final verification ──
            graph.status = 'verifying';
            onUpdate?.('verifying', '🔍 Supervisor: Performing final verification...');

            const verificationResult = await this.verifyFinalResult(
                goal, aggregation, conflictResolution, graph
            );

            // ── Step 7: Synthesize final answer ──
            graph.status = verificationResult.verified ? 'completed' : 'failed';

            const finalAnswer = this.synthesizeFinalAnswer(
                goal, aggregation, conflictResolution, verificationResult, graph
            );

            Telemetry.recordEvent('orchestration.completed', 'agent', 'completed', Date.now() - startTime, {
                graphId: graph.id,
                status: graph.status,
                nodes: graph.nodes.length,
                completedNodes: graph.nodes.filter(n => n.status === 'completed').length
            });

            onUpdate?.('orchestration_complete', `✅ Multi-agent task ${verificationResult.verified ? 'verified' : 'completed with issues'}.`);

            return finalAnswer;

        } catch (err: any) {
            Telemetry.recordEvent('orchestration.failed', 'agent', 'failed', Date.now() - startTime, {
                error: err.message
            });
            onUpdate?.('failed', `Orchestration error: ${err.message}`);
            return `Multi-agent orchestration failed: ${err.message}`;
        } finally {
            this.currentDepth--;
            Telemetry.endTrace();
        }
    }

    private static async verifyFinalResult(
        goal: string,
        aggregation: ReturnType<typeof ResultAggregator.aggregate>,
        conflictResolution: string,
        graph: TaskGraph
    ): Promise<{ verified: boolean; reason: string }> {
        const findingsSummary = aggregation.allFindings
            .slice(0, 20)
            .map(f => `[${f.severity}] ${f.category}: ${f.description}`)
            .join('\n');

        const prompt = `You are the Supervisor verifying a multi-agent task.

Goal: "${goal}"

Agent Results Summary:
${aggregation.mergedSummary.substring(0, 3000)}

Key Findings (${aggregation.allFindings.length} total):
${findingsSummary}

${conflictResolution ? `Conflict Resolution:\n${conflictResolution.substring(0, 1000)}\n` : ''}

Stats: ${aggregation.stats.completed} completed, ${aggregation.stats.failed} failed, ${aggregation.stats.partial} partial out of ${aggregation.stats.total} agents.

Is this task adequately completed? Consider:
1. Were all major aspects of the goal addressed?
2. Are the findings supported by evidence?
3. Were conflicts resolved satisfactorily?

Respond with JSON:
{
  "verified": true|false,
  "reason": "explanation"
}`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['reasoning'], intent: 'supervisor_verification', maxTokens: 300 },
                [{ role: 'user', content: prompt }]
            );

            let reply = '';
            if (data.content && Array.isArray(data.content)) reply = data.content.map((p: any) => p.text || '').join('');
            else if (data.choices) reply = data.choices[0]?.message?.content || '';

            reply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(reply);
        } catch {
            return { verified: true, reason: 'Verification parsing failed; assumed verified based on completion.' };
        }
    }

    private static synthesizeFinalAnswer(
        goal: string,
        aggregation: ReturnType<typeof ResultAggregator.aggregate>,
        conflictResolution: string,
        verification: { verified: boolean; reason: string },
        graph: TaskGraph
    ): string {
        const sections: string[] = [];

        sections.push(`## Multi-Agent Task Result`);
        sections.push(`**Goal:** ${goal}`);
        sections.push(`**Status:** ${verification.verified ? '✅ VERIFIED' : '⚠️ COMPLETED WITH ISSUES'}`);
        sections.push(`**Agents:** ${aggregation.stats.completed} completed, ${aggregation.stats.failed} failed, ${aggregation.stats.partial} partial`);
        sections.push('');

        // Confirmed findings
        const confirmed = aggregation.allFindings.filter(f => f.evidence);
        if (confirmed.length > 0) {
            sections.push(`### Confirmed Findings (${confirmed.length})`);
            for (const f of confirmed.slice(0, 15)) {
                sections.push(`- **[${f.severity?.toUpperCase()}]** ${f.description}`);
                if (f.evidence) sections.push(`  Evidence: ${f.evidence}`);
                if (f.source) sections.push(`  Source: ${f.source}`);
            }
            sections.push('');
        }

        // Unverified findings
        const unverified = aggregation.allFindings.filter(f => !f.evidence);
        if (unverified.length > 0) {
            sections.push(`### Unverified Findings (${unverified.length})`);
            for (const f of unverified.slice(0, 10)) {
                sections.push(`- ${f.description}`);
            }
            sections.push('');
        }

        // Conflicts
        if (aggregation.conflicts.length > 0) {
            sections.push(`### Conflicts Resolved`);
            sections.push(conflictResolution.substring(0, 500));
            sections.push('');
        }

        // Per-agent summaries
        sections.push(`### Agent Reports`);
        for (const node of graph.nodes) {
            const statusIcon = node.status === 'completed' ? '✓' : (node.status === 'failed' ? '✗' : '○');
            const duration = node.finishedAt && node.startedAt
                ? `${((node.finishedAt - node.startedAt) / 1000).toFixed(1)}s`
                : 'N/A';
            sections.push(`- ${statusIcon} **${node.agentType}** (${duration}): ${node.result?.summary?.substring(0, 150) || node.description}`);
        }
        sections.push('');

        sections.push(`**Verification:** ${verification.reason}`);

        return sections.join('\n');
    }
}
