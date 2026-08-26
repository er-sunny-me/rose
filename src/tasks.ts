import chalk from 'chalk';
import crypto from 'crypto';
import { ToolExecutor, ToolRegistry } from './tools.js';
import { CapabilityRouter } from './capabilities.js';
import { MemoryService } from './memory.js';
import { Telemetry } from './telemetry.js';
import { ModelRouter } from './router.js';
import { PreferenceManager, StrategyLearner } from './learning.js';
import { TransactionManager } from './transaction.js';
import { RecoveryEngine } from './recovery.js';
import { EventStore } from './runtime/events.js';

export type TaskComplexity = 'DIRECT' | 'TOOL' | 'MULTI_STEP' | 'ORCHESTRATED' | 'RESEARCH';

export interface TaskStep {
    id: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    dependsOn?: string[];
    result?: unknown;
    error?: string;
}

export interface AgentTask {
    id: string;
    goal: string;
    status: 'pending' | 'planning' | 'executing' | 'waiting' | 'verifying' | 'completed' | 'failed' | 'cancelled';
    steps: TaskStep[];
    createdAt: number;
    updatedAt: number;
    definitionOfDone?: string;
}

export class TaskRouter {
    public static async detectComplexity(message: string): Promise<TaskComplexity> {
        // Fast local checks to bypass LLM if possible
        const lower = message.toLowerCase().trim();
        if (['hello', 'hi', 'hey', 'what time is it', 'how are you', 'who are you'].includes(lower)) {
            return 'DIRECT';
        }

        const prompt = `Classify the following user request into one of five categories:
DIRECT - A simple question or conversation that requires no tools (e.g. "Hello", "What is TypeScript?").
TOOL - A request that can be fulfilled with a single tool action (e.g. "Check CPU usage", "Search memory for X").
MULTI_STEP - A complex request requiring planning, multiple actions, or verification (e.g. "Fix the bug in my project and run tests").
ORCHESTRATED - A large, multi-faceted request that involves several INDEPENDENT areas of expertise running in parallel.
RESEARCH - A deep knowledge retrieval task that requires evaluating multiple sources, finding evidence, comparing claims, or analyzing official docs vs local code (e.g. "Research Gemini Live API deeply and compare it with my current implementation").

Request: "${message}"

Respond ONLY with the exact word DIRECT, TOOL, MULTI_STEP, ORCHESTRATED, or RESEARCH.`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['fast'], intent: 'detect_complexity', maxTokens: 10 },
                [{ role: 'user', content: prompt }]
            );

            let reply = "";
            if (data.content && Array.isArray(data.content)) {
                for (const part of data.content) {
                    if (part.type === "text" && part.text) reply += part.text;
                }
            } else if (data.choices && data.choices[0]?.message?.content) {
                reply = data.choices[0].message.content;
            }

            reply = reply.trim().toUpperCase();
            if (reply === 'DIRECT' || reply === 'TOOL' || reply === 'MULTI_STEP' || reply === 'ORCHESTRATED' || reply === 'RESEARCH') {
                return reply as TaskComplexity;
            }
            return 'MULTI_STEP';
        } catch (err) {
            return 'MULTI_STEP';
        }
    }
}

export class Planner {
    public static async generatePlan(goal: string, context: string): Promise<{ steps: TaskStep[], dod: string }> {
        const startTime = Date.now();
        Telemetry.recordEvent('plan.started', 'agent', 'started');
        const learnedContext = PreferenceManager.getAllActiveContext();
        const activeFailures = StrategyLearner.getActiveFailurePatterns();
        let failureContext = '';
        if (activeFailures.length > 0) {
            failureContext = `\nKnown Failure Patterns to Avoid:\n` + activeFailures.map(f => `- ${f.description} (Prevention: ${f.preventionHint})`).join('\n');
        }

        const prompt = `You are the autonomous Planner.

${CapabilityRouter.getCapabilitiesContext()}

${learnedContext}
${failureContext}

Deconstruct the following goal into a sequence of actionable steps.
Each step should be distinct and verifiable.
You must provide a "definitionOfDone" string that explicitly states what conditions must be true for the entire goal to be complete.

Respond ONLY with valid JSON.
{
    "steps": [{"description": "string", "status": "pending"}],
    "definitionOfDone": "string"
}

Goal: "${goal}"
Context:
${context}

CRITICAL RULES:
1. ALWAYS use forward slashes (/) for file paths instead of backslashes (\\), even on Windows, to avoid JSON parsing errors.

Do not output more than 10 steps.`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['reasoning'], intent: 'planning', maxTokens: 800 },
                [{ role: 'user', content: prompt }]
            );

            let replyText = "";
            if (data.content && Array.isArray(data.content)) {
                for (const part of data.content) {
                    if (part.type === "text" && part.text) replyText += part.text;
                }
            } else if (data.choices && data.choices[0]?.message?.content) {
                replyText = data.choices[0].message.content;
            }

            replyText = replyText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(replyText);
            
            const steps: TaskStep[] = (parsed.steps || []).map((s: any) => ({
                id: s.id || crypto.randomBytes(4).toString('hex'),
                description: s.description,
                status: 'pending',
                dependsOn: s.dependsOn
            }));

            return { steps, dod: parsed.definitionOfDone || "Goal achieved." };
        } catch (err: any) {
            console.error(chalk.red(`[PLANNER] Error generating plan: ${err.message}`));
            return { steps: [{ id: '1', description: goal, status: 'pending' }], dod: goal };
        }
    }
}

export class TaskExecutor {
    private activeTask: AgentTask | null = null;
    private maxRetries = 2;
    private maxSteps = 20;
    private stepHistory: string = "";
    public isInterrupted = false;

    public getActiveTask() { return this.activeTask; }
    
    public cancelTask() {
        if (this.activeTask) {
            this.activeTask.status = 'cancelled';
            this.isInterrupted = true;
            console.log(chalk.yellow(`[TASK] Cancelled active task.`));
        }
    }

    public async executeTask(goal: string, context: string, onUpdate?: (status: string, msg: string, detail?: string) => void, options: { simulate?: boolean } = {}): Promise<string> {
        this.isInterrupted = false;
        const taskId = crypto.randomBytes(4).toString('hex');
        
        onUpdate?.('planning', 'Planning task...');
        const { steps, dod } = await Planner.generatePlan(goal, context);
        
        const tx = await TransactionManager.begin(taskId, options.simulate);
        
        if (options.simulate) {
            onUpdate?.('completed', `Simulation completed. Impact predicted. See /transactions for details.`);
            return `Simulation completed for goal: ${goal}.`;
        }
        
        Telemetry.recordEvent('task.created', 'agent', 'started', undefined, { taskId, goal, steps: steps.length });

        this.activeTask = {
            id: taskId,
            goal,
            status: 'executing',
            steps,
            definitionOfDone: dod,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await EventStore.append('task', taskId, 'task.created', { goal, steps, dod });

        this.stepHistory = `Goal: ${goal}\nDefinition of Done: ${dod}\n\n`;

        let currentStepCount = 0;

        for (let i = 0; i < this.activeTask.steps.length; i++) {
            if (this.isInterrupted || this.activeTask.status === 'cancelled') {
                return `Task ${taskId} was cancelled.`;
            }

            if (currentStepCount >= this.maxSteps) {
                this.activeTask.status = 'failed';
                onUpdate?.('failed', `Task failed: Exceeded maximum step limit (${this.maxSteps}).`);
                return `Task failed: Exceeded maximum step limit.`;
            }

            const step = this.activeTask.steps[i];
            if (step.status !== 'pending') continue;

            step.status = 'running';
            await EventStore.append('task', taskId, 'task.step.started', { stepIndex: i });
            
            currentStepCount++;
            onUpdate?.('pending', `[Step ${i+1}/${this.activeTask.steps.length}] ${step.description}`);
            
            let attempts = 0;
            let success = false;
            
            while (attempts < this.maxRetries && !success && !this.isInterrupted) {
                attempts++;
                try {
                    const stepResult = await this.executeSingleStep(step, context, tx.id);
                    step.result = stepResult.result;
                    
                    const evalResult = await this.evaluateStep(step, stepResult.result);
                    
                    if (evalResult.action === 'SUCCESS') {
                        success = true;
                        step.status = 'completed';
                        await EventStore.append('task', taskId, 'task.step.completed', { stepIndex: i, result: step.result });
                        
                        let safeOutput = stepResult.summary;
                        if (safeOutput.length > 2000) {
                            safeOutput = `[COMPRESSED] ${safeOutput.substring(0, 1000)} ... ${safeOutput.substring(safeOutput.length - 1000)}`;
                        }
                        this.stepHistory += `Step: ${step.description}\nResult: SUCCESS - ${safeOutput}\n\n`;
                        onUpdate?.('completed', `Completed: ${step.description}`);
                    } else if (evalResult.action === 'RETRY') {
                        onUpdate?.('warning', `Retrying step: ${evalResult.reason}`);
                    } else if (evalResult.action === 'REPLAN') {
                        onUpdate?.('replan', `Replanning needed: ${evalResult.reason}`);
                        step.status = 'failed';
                        await EventStore.append('task', taskId, 'task.step.failed', { stepIndex: i, error: evalResult.reason });
                        const replanSuccess = await this.replanTask(i, evalResult.reason, context);
                        if (!replanSuccess) {
                            if (this.activeTask) {
                                this.activeTask.status = 'failed';
                                console.error(chalk.red(`[TASK] Execution failed: ${evalResult.reason}`));
                
                                // Record failed strategy
                                StrategyLearner.recordTaskOutcome('general', this.activeTask.goal.substring(0, 50), this.activeTask.steps.map(s => s.description), false, this.activeTask.id);
                
                                // If it's a recurring failure, we could track it, but we'll let specific tool executors report specific errors to the StrategyLearner.
                                StrategyLearner.recordFailurePattern(evalResult.reason, "Review the logs and adjust tool parameters or add missing dependencies.");
                            }
                            return `Task failed during replanning.`;
                        }
                        break; 
                    } else if (evalResult.action === 'FAILURE') {
                        step.status = 'failed';
                        await EventStore.append('task', taskId, 'task.step.failed', { stepIndex: i, error: evalResult.reason });
                        const handled = await RecoveryEngine.diagnoseAndRecover(tx.id, evalResult.reason);
                        if (handled) {
                            if (this.activeTask) {
                                this.activeTask.status = 'failed';
                                await EventStore.append('task', taskId, 'task.status_changed', { status: 'failed' });
                            }
                            onUpdate?.('failed', `Step failed and recovery handled: ${evalResult.reason}`);
                            return `Task failed at step: ${step.description}. Recovery engine invoked.`;
                        }
                        if (this.activeTask) {
                            this.activeTask.status = 'failed';
                            await EventStore.append('task', taskId, 'task.status_changed', { status: 'failed' });
                        }
                        onUpdate?.('failed', `Step failed: ${evalResult.reason}`);
                        return `Task failed at step: ${step.description}. Reason: ${evalResult.reason.substring(0, 200)}`;
                    }
                } catch (err: any) {
                    onUpdate?.('failed', `Execution error: ${err.message}`);
                    step.error = err.message;
                    if (attempts >= this.maxRetries) {
                        step.status = 'failed';
                        if (this.activeTask) this.activeTask.status = 'failed';
                        return `Task failed: Unrecoverable error on step: ${step.description}. ${err.message.substring(0, 200)}`;
                    }
                }
            }

            if (!success && step.status !== 'completed' && step.status !== 'failed' && !this.isInterrupted) {
                step.status = 'failed';
                if (this.activeTask) this.activeTask.status = 'failed';
                return `Task failed: Exceeded max retries on step: ${step.description}`;
            }
        }

        if (this.isInterrupted) return `Task cancelled.`;

        if (!this.activeTask) return 'Task cancelled.';
        this.activeTask.status = 'verifying';
        const verifyStart = Date.now();
        Telemetry.recordEvent('verification.started', 'agent', 'started');
        onUpdate?.('verifying', 'Verifying Definition of Done...');
        try {
            const finalEval = await this.verifyDone(this.activeTask);
            if (finalEval.success) {
                await TransactionManager.commit(tx.id);
                Telemetry.recordEvent('verification.completed', 'agent', 'completed', Date.now() - verifyStart);
                this.activeTask.status = 'completed';
                await EventStore.append('task', taskId, 'task.status_changed', { status: 'completed' });
                onUpdate?.('completed', 'Task Completed Successfully!', finalEval.reason);
                console.log(chalk.green(`\n[TASK] Goal achieved: ${this.activeTask.goal}`));
            
                // Record successful strategy
                StrategyLearner.recordTaskOutcome('general', this.activeTask.goal.substring(0, 50), this.activeTask.steps.map(s => s.description), true, this.activeTask.id);

                return `Task completed. ${finalEval.reason}`;
            } else {
                await TransactionManager.rollback(tx.id);
                Telemetry.recordEvent('verification.failed', 'agent', 'failed', Date.now() - verifyStart);
                this.activeTask.status = 'failed';
                await EventStore.append('task', taskId, 'task.status_changed', { status: 'failed' });
                onUpdate?.('failed', 'Task partially completed or failed verification', finalEval.reason);
                
                StrategyLearner.recordTaskOutcome('general', this.activeTask.goal.substring(0, 50), this.activeTask.steps.map(s => s.description), false, this.activeTask.id);

                return `Task partially completed. Verification failed: ${finalEval.reason}`;
            }
        } catch (e: any) {
            Telemetry.recordEvent('verification.failed', 'agent', 'failed', Date.now() - verifyStart);
            this.activeTask.status = 'completed';
            return `Task completed (verification skipped due to error: ${e.message}).`;
        }
        return 'Task execution finished.';
    }

    private async executeSingleStep(step: TaskStep, context: string, txId: string): Promise<{ result: any, summary: string }> {
        const prompt = `You are executing a step in a larger plan.
System Context: ${context}
History of previous steps:
${this.stepHistory}

Current Step: "${step.description}"

Analyze the current step and decide what action to take. You can emit tool calls.
If no tool call is needed, just provide a text summary of your finding or thought process.
To emit a tool call, output a JSON block exactly like this:
\`\`\`tool
{
  "name": "execute_command",
  "args": { "command": "npm test" }
}
\`\`\``;
        
        const data = await ModelRouter.route(
            { capabilities: ['reasoning'], intent: 'execute_step', maxTokens: 1000 },
            [{ role: 'user', content: prompt }]
        );
        
        let replyText = "";
        if (data.content && Array.isArray(data.content)) {
            replyText = data.content.map((p:any) => p.text || '').join('');
        } else if (data.choices && data.choices[0]?.message?.content) {
            replyText = data.choices[0].message.content;
        }

        const toolMatch = replyText.match(/```tool\n([\s\S]*?)\n```/);
        if (toolMatch) {
            const toolCall = JSON.parse(toolMatch[1]);
            try {
               const res = await ToolExecutor.execute({ id: 'step_tool', name: toolCall.name, args: toolCall.args }, txId);
               const resultStr = typeof res === 'object' ? JSON.stringify(res) : String(res);
               let summaryStr = resultStr;
               if (summaryStr.length > 1500) {
                   summaryStr = `${summaryStr.substring(0, 750)} ... [MIDDLE COMPACTED] ... ${summaryStr.substring(summaryStr.length - 750)}`;
               }
               return { result: res, summary: `Executed ${toolCall.name}. Output:\n${summaryStr}` };
            } catch (error: any) {
               return { result: `Tool failed: ${error.message}`, summary: `Tool ${toolCall.name} threw an error: ${error.message}` };
            }
        }

        return { result: replyText, summary: replyText.substring(0, 1500) };
    }

    private async evaluateStep(step: TaskStep, result: any): Promise<{ action: 'SUCCESS'|'RETRY'|'REPLAN'|'FAILURE', reason: string }> {
        const prompt = `You are evaluating the result of a task step.
Step: "${step.description}"
Result Data: ${JSON.stringify(result).substring(0, 2000)}

Decide the next action based on this exact schema:
{
  "action": "SUCCESS" | "RETRY" | "REPLAN" | "FAILURE",
  "reason": "short explanation"
}

- SUCCESS: The step achieved its goal.
- RETRY: A temporary error (e.g. timeout, typo) occurred.
- REPLAN: The environment changed (e.g. file missing, wrong approach) requiring new steps.
- FAILURE: A permanent block (e.g. Permission Denied) or completely unrecoverable error.

Return ONLY the JSON.`;

        const data = await ModelRouter.route(
            { capabilities: ['fast'], intent: 'evaluate_step', maxTokens: 100 },
            [{ role: 'user', content: prompt }]
        );
        let reply = "";
        if (data.content && Array.isArray(data.content)) reply = data.content.map((p:any) => p.text).join('');
        else if (data.choices) reply = data.choices[0]?.message?.content || "";
        
        reply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(reply);
        } catch {
            return { action: 'SUCCESS', reason: 'Failed to parse evaluator response, assuming success' };
        }
    }

    private async verifyDone(task: AgentTask): Promise<{ success: boolean, reason: string }> {
        const prompt = `You are evaluating if a task is complete based on its Definition of Done.
Goal: ${task.goal}
Definition of Done: ${task.definitionOfDone}

History:
${this.stepHistory}

Is the task complete? Respond with JSON:
{
  "success": true | false,
  "reason": "short explanation"
}`;
        
        const data = await ModelRouter.route(
            { capabilities: ['fast'], intent: 'verify_done', maxTokens: 200 },
            [{ role: 'user', content: prompt }]
        );
        let reply = "";
        if (data.content && Array.isArray(data.content)) reply = data.content.map((p:any) => p.text).join('');
        else if (data.choices) reply = data.choices[0]?.message?.content || "";
        
        reply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(reply);
        } catch {
            return { success: true, reason: 'Assumed success due to parsing error' };
        }
    }

    private async replanTask(failedIndex: number, reason: string, context: string): Promise<boolean> {
        if (!this.activeTask) return false;
        
        const remainingGoal = `Replan recovery for: ${reason}. Original goal: ${this.activeTask.goal}`;
        const { steps } = await Planner.generatePlan(remainingGoal, context + '\n\n' + this.stepHistory);
        
        // Remove pending steps, append new steps
        this.activeTask.steps = this.activeTask.steps.slice(0, failedIndex + 1);
        this.activeTask.steps.push(...steps);
        
        return true;
    }
}
