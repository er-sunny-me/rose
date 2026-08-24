import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { SessionManager } from './session.js';
import { TaskRouter } from './tasks.js';
import { ModelRouter } from './router.js';
import { CapabilityRouter } from './capabilities.js';
import { Telemetry } from './telemetry.js';
import { AutomationEngine } from './automation.js';
import { getSystemInstruction } from './context.js';
import { Supervisor, AgentRegistry } from './agents.js';
import { ResearchEngine } from './research.js';
import { LearningStore, FeedbackProcessor } from './learning.js';
import { TransactionManager } from './transaction.js';
import { EventStore } from './runtime/events.js';
import { TaskProjection } from './runtime/projections.js';
import { GoalManager } from './goals/manager.js';
import { WorldModel } from './world/model.js';
import { SimulationEngine } from './simulation/engine.js';
import { IncidentManager } from './rca/manager.js';
import { RCAEngine } from './rca/engine.js';
import { ReliabilityLab } from './reliability/lab.js';
import { MaintenanceVerifier } from './maintenance/verifier.js';
import { federationRouter } from './federation/api.js';
import { MetricsSystem, HealthMonitor, SLOSystem, CapacityEngine, CostEngine, PerformanceEngine, BottleneckAnalyzer, OptimizationEngine } from './observability/index.js';
import { PolicyStore } from './policy/store.js';
import { Config } from './config.js';
import { AuthService, authenticateRequest, authorizeRequest } from './server/auth.js';
import chalk from 'chalk';

export class AgentServer {
    private app = express();
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    // Phase 33: honor setup-configured web settings; env vars still win for
    // one-off overrides. Defaults bind to localhost only.
    private port: number;
    private host: string;

    constructor() {
        const cfg = Config.get();
        this.port = process.env.PORT
            ? parseInt(process.env.PORT)
            : (cfg.web?.port ?? cfg.server.port ?? 3000);
        this.host = process.env.HOST || cfg.web?.host || '127.0.0.1';
        this.app.use(cors());
        this.app.use(express.json());
        // Phase 34: every API route requires a valid bearer token.
        // /health and /ready remain public for liveness probes.
        this.app.use(authenticateRequest);
        this.app.use(authorizeRequest);
        this.setupRoutes();
    }

    private setupRoutes() {
        // Phase 28: Federation
        this.app.use('/api/v1/federation', federationRouter);

        // Phase 29: Observability
        this.app.get('/api/v1/metrics', (req, res) => res.json(MetricsSystem.getMetrics()));
        this.app.get('/api/v1/health/system', (req, res) => res.json(HealthMonitor.getAllHealth()));
        this.app.get('/api/v1/capacity', (req, res) => res.json({ forecast: CapacityEngine.forecastQueueSaturation() }));
        this.app.get('/api/v1/bottlenecks', (req, res) => res.json({ bottleneck: BottleneckAnalyzer.analyze() }));
        this.app.get('/api/v1/optimizations', (req, res) => res.json(OptimizationEngine.getCandidates()));

        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', processId: process.pid, uptime: process.uptime() });
        });

        this.app.get('/ready', (req, res) => {
            res.json({ status: 'ready' });
        });

        // Sessions
        this.app.post('/api/v1/sessions', (req, res) => {
            const session = SessionManager.createSession(req.body.id);
            res.json({ id: session.id, createdAt: session.createdAt });
        });

        this.app.get('/api/v1/sessions', (req, res) => {
            res.json(SessionManager.listSessions().map(s => ({ id: s.id, createdAt: s.createdAt, lastAccessedAt: s.lastAccessedAt })));
        });

        this.app.get('/api/v1/sessions/:id', (req, res) => {
            const session = SessionManager.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json({ id: session.id, chatHistory: session.chatHistory.length, activeTask: session.taskExecutor.getActiveTask()?.id });
        });

        // Messages
        this.app.post('/api/v1/sessions/:id/messages', async (req, res) => {
            const session = SessionManager.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const message = req.body.content;
            if (!message) return res.status(400).json({ error: 'content is required' });

            let finalMessage = message;
            if (req.body.attachments && Array.isArray(req.body.attachments)) {
                const attachmentList = req.body.attachments.map((p: string) => `Attached file: ${p}`).join('\n');
                finalMessage = `${finalMessage}\n\n[ATTACHMENTS]\n${attachmentList}`;
            }

            try {
                const activeTask = session.taskExecutor.getActiveTask();
                const taskState = activeTask ? `Active Task: ${activeTask.goal}\nStatus: ${activeTask.status}` : "";
                const capabilitiesStr = CapabilityRouter.getCapabilitiesContext();
                
                const { finalPrompt, prunedHistory } = await session.contextManager.buildContext({
                    systemInstructions: getSystemInstruction() + '\n\n' + capabilitiesStr,
                    taskState,
                    activeSkills: "Skills available.", // simplified for API response
                    memory: "Memory available.", 
                    chatHistory: session.chatHistory,
                    currentInput: finalMessage
                });
                
                session.chatHistory = prunedHistory;
                
                const complexity = await TaskRouter.detectComplexity(finalMessage);
                if (complexity === 'RESEARCH') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });

                    const result = await ResearchEngine.execute(finalMessage, finalPrompt, (status, msg, detail) => {
                        res.write(`data: ${JSON.stringify({ type: 'research_update', status, msg, detail })}\n\n`);
                    });

                    session.chatHistory.push({ role: 'user', parts: [{ text: finalMessage }] });
                    session.chatHistory.push({ role: 'model', parts: [{ text: result }] });

                    res.write(`data: ${JSON.stringify({ type: 'completion', result })}\n\n`);
                    res.end();
                } else if (complexity === 'ORCHESTRATED') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });

                    const result = await Supervisor.execute(finalMessage, finalPrompt, (status, msg, detail) => {
                        res.write(`data: ${JSON.stringify({ type: 'orchestration_update', status, msg, detail })}\n\n`);
                    });

                    session.chatHistory.push({ role: 'user', parts: [{ text: finalMessage }] });
                    session.chatHistory.push({ role: 'model', parts: [{ text: result }] });

                    res.write(`data: ${JSON.stringify({ type: 'completion', result })}\n\n`);
                    res.end();
                } else if (complexity === 'MULTI_STEP') {
                    // Send chunked responses using Server-Sent Events (SSE) or simple response for now
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    
                    const result = await session.taskExecutor.executeTask(finalMessage, finalPrompt, (status, msg, detail) => {
                        res.write(`data: ${JSON.stringify({ type: 'task_update', status, msg, detail })}\n\n`);
                    });
                    
                    session.chatHistory.push({ role: 'user', parts: [{ text: finalMessage }] });
                    session.chatHistory.push({ role: 'model', parts: [{ text: result }] });
                    
                    res.write(`data: ${JSON.stringify({ type: 'completion', result })}\n\n`);
                    res.end();
                } else {
                    const messages = session.chatHistory.map(msg => ({
                        role: msg.role === 'model' ? 'assistant' : 'user',
                        content: msg.parts[0]?.text || ''
                    }));
                    messages.push({ role: 'user', content: finalPrompt });

                    const data = await ModelRouter.route(
                        { intent: 'generation', maxTokens: 8192, preferredModelId: req.body.modelId },
                        messages,
                        getSystemInstruction()
                    );

                    let replyText = "No text in response";
                    if (data.content && Array.isArray(data.content)) {
                        replyText = data.content.filter((p: any) => p.type === 'text' || !p.type).map((p: any) => p.text || (typeof p === 'string' ? p : '')).join('\n');
                    } else if (data.choices && data.choices[0]?.message?.content) {
                        replyText = data.choices[0].message.content;
                    }

                    session.chatHistory.push({ role: 'user', parts: [{ text: finalMessage }] });
                    session.chatHistory.push({ role: 'model', parts: [{ text: replyText }] });

                    res.json({ message: replyText });
                }
            } catch (err: any) {
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
                    res.end();
                }
            }
        });

        // Tasks
        this.app.get('/api/v1/tasks/:id', (req, res) => {
            // Find task across all sessions
            for (const session of SessionManager.listSessions()) {
                const active = session.taskExecutor.getActiveTask();
                if (active && active.id === req.params.id) {
                    return res.json(active);
                }
            }
            res.status(404).json({ error: 'Task not found or not active' });
        });

        // Diagnostics
        this.app.get('/api/v1/diagnostics', (req, res) => {
            res.json({
                sessions: SessionManager.listSessions().length,
                automations: AutomationEngine.list().length,
            });
        });

        // Agents
        this.app.get('/api/v1/agents', (req, res) => {
            AgentRegistry.discover();
            const agents = AgentRegistry.list().map(a => ({
                id: a.id,
                name: a.name,
                description: a.description,
                accessMode: a.accessMode,
                trustLevel: a.trustLevel,
                enabled: a.enabled,
                health: a.health,
                consecutiveFailures: a.consecutiveFailures,
                skills: a.skills,
                capabilities: a.capabilities
            }));
            res.json(agents);
        });

        // Research
        this.app.get('/api/v1/research', (req, res) => {
            // Read from vault directory for now, would need memory service to list them
            res.json({ message: 'Research list endpoint placeholder. See vault directory.' });
        });

        // Models
        this.app.get('/api/v1/models', (req, res) => {
            const providers = ModelRouter.getProviders();
            res.json(providers.map(p => ({ 
                id: p.id, 
                name: p.name, 
                health: p.health,
                tier: p.tier,
                badge: p.badge
            })));
        });

        // Phase 19: Learning
        this.app.get('/api/v1/preferences', (req, res) => {
            res.json(LearningStore.getPreferences());
        });

        this.app.get('/api/v1/strategies', (req, res) => {
            res.json(LearningStore.getStrategies());
        });

        this.app.get('/api/v1/learning/status', (req, res) => {
            const prefsList = LearningStore.getPreferences();
            const stratsList = LearningStore.getStrategies();
            res.json({
                explicit: prefsList.filter(p => p.source === 'explicit').length,
                inferred: prefsList.filter(p => p.source === 'inferred' && p.status === 'CANDIDATE').length,
                validated: stratsList.filter(s => s.status === 'VALIDATED' || s.status === 'PREFERRED').length,
                stale: prefsList.filter(p => p.status === 'STALE').length
            });
        });

        this.app.post('/api/v1/feedback', (req, res) => {
            const { message } = req.body;
            if (!message) return res.status(400).json({ error: 'Message is required' });
            FeedbackProcessor.processFeedback(message);
            res.json({ success: true });
        });

        this.app.delete('/api/v1/preferences/:id', (req, res) => {
            const success = LearningStore.deletePreference(req.params.id);
            res.json({ success });
        });

        this.app.delete('/api/v1/strategies/:id', (req, res) => {
            const success = LearningStore.deleteStrategy(req.params.id);
            res.json({ success });
        });

        // Phase 20: Transactions
        this.app.get('/api/v1/transactions', (req, res) => {
            res.json(TransactionManager.getTransactions());
        });

        // Phase 21: Runtime & Events
        this.app.get('/api/v1/runtime', async (req, res) => {
            const txCount = TransactionManager.getTransactions().length;
            const evts = await EventStore.readAll();
            res.json({
                activeTransactions: txCount,
                eventCount: evts.length,
                status: 'healthy'
            });
        });

        this.app.get('/api/v1/events', async (req, res) => {
            const events = await EventStore.readAll();
            res.json(events);
        });

        this.app.get('/api/v1/queue', async (req, res) => {
            const tasksMap = await TaskProjection.rebuildAll();
            const queue = [];
            for (const [id, t] of tasksMap.entries()) {
                 if (t.status === 'executing' || t.status === 'waiting' || t.status === 'planning') {
                     queue.push(t);
                 }
            }
            res.json(queue);
        });

        // Phase 22: Goals & World Model
        this.app.get('/api/v1/goals', (req, res) => {
            res.json(GoalManager.getGoals());
        });

        this.app.get('/api/v1/world', (req, res) => {
            res.json(WorldModel.getAll());
        });

        // Phase 23: Simulation Engine
        this.app.get('/api/v1/simulations', (req, res) => {
            res.json(SimulationEngine.getBranches());
        });

        this.app.post('/api/v1/simulations/:id/promote', async (req, res) => {
            try {
                await SimulationEngine.promote(req.params.id, 'API Promotion');
                res.json({ success: true, message: 'Branch promoted' });
            } catch (e: any) {
                res.status(400).json({ error: e.message });
            }
        });

        this.app.get('/api/v1/incidents', (req, res) => {
            res.json(IncidentManager.getIncidents());
        });

        this.app.get('/api/v1/incidents/:id', (req, res) => {
            const inc = IncidentManager.getIncident(req.params.id);
            if (!inc) return res.status(404).json({ error: 'Not found' });
            res.json(inc);
        });

        this.app.get('/api/v1/dependencies/:id', (req, res) => {
            res.json({
                forward: WorldModel.getForwardDependencies(req.params.id),
                reverse: WorldModel.getReverseDependencies(req.params.id)
            });
        });

        this.app.get('/api/v1/impact/:id', (req, res) => {
            res.json({ blastRadius: RCAEngine.analyzeImpact(req.params.id) });
        });

        this.app.get('/api/v1/reliability/scenarios', (req, res) => {
            res.json(ReliabilityLab.getScenarios());
        });

        this.app.get('/api/v1/policies', (req, res) => {
            res.json(PolicyStore.getAllPolicies());
        });

        this.app.post('/api/v1/policies/evaluate', async (req, res) => {
            res.json({ decision: 'ALLOW' });
        });

        this.app.post('/api/v1/reliability/runs', async (req, res) => {
            const { profile } = req.body;
            try {
                const results = await ReliabilityLab.runProfile(profile || 'quick');
                res.json({ success: true, results });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // Phase 31: Serve Web UI
        const uiPath = path.join(process.cwd(), 'ui/dist');
        this.app.use(express.static(uiPath));
        this.app.use((req, res, next) => {
            if (req.method === 'GET' && !req.path.startsWith('/api/')) {
                res.sendFile(path.join(uiPath, 'index.html'));
            } else {
                next();
            }
        });
    }

    public start() {
        LearningStore.init();
        this.server = this.app.listen(this.port, this.host, () => {
            console.log(chalk.green(`🚀 Agent Server running at http://${this.host}:${this.port}`));

            if (this.host !== '127.0.0.1' && this.host !== 'localhost') {
                console.log(chalk.bold.red(''));
                console.log(chalk.bold.red('⚠️  WARNING: Rose will be accessible from other devices on your network.'));
                console.log(chalk.bold.red('⚠️  Authentication is required. Clients must send the API token:'));
                console.log(chalk.bold.red(`    Authorization: Bearer <token from .rose/auth-token>`));
                console.log(chalk.bold.red(''));
            } else {
                const tokenFile = path.join(process.cwd(), '.rose', 'auth-token');
                console.log(chalk.gray(`   API auth: enabled (bearer token in ${tokenFile} or ROSE_API_TOKEN)`));
            }
        });

        // Phase 34: authenticated WebSocket endpoint at /ws.
        // The upgrade request must carry ?token= or an Authorization header;
        // client-supplied session/user/agent ids are never trusted.
        this.wss = new WebSocketServer({ noServer: true });
        this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            if (!req.url || !req.url.startsWith('/ws')) {
                socket.destroy();
                return;
            }

            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const presented = AuthService.extractBearer(req.headers.authorization) ?? url.searchParams.get('token');
            if (!AuthService.verifyToken(presented)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            this.wss!.handleUpgrade(req, socket, head, (ws) => {
                this.wss!.emit('connection', ws, req);
            });
        });

        this.wss.on('connection', (ws: WebSocket) => {
            ws.send(JSON.stringify({ type: 'hello', authenticated: true }));
            ws.on('message', (data) => {
                // Echo-style control channel; command execution intentionally
                // does NOT flow through raw websocket messages.
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
                } catch {
                    /* ignore malformed frames */
                }
            });
        });
    }
}
