import { GoogleGenerativeAI } from '@google/generative-ai';
import * as readline from 'readline';
import dotenv from 'dotenv';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import { LiveSessionController, MODEL_LIVE, MODEL_TEXT } from './voice/live-session.js';
import { CLI_COMMANDS, findCommandHandler } from './cli/command-registry.js';
import { displayWelcome } from './cli/output.js';
import { levenshteinDistance } from './cli/text-utils.js';
import type { CliContext } from './cli/context.js';

import { ToolRegistry, ToolExecutor } from './tools.js';
import { SkillRegistry } from './skills.js';
import { MemoryService } from './memory.js';
import { TaskRouter, TaskExecutor } from './tasks.js';
import { ContextManager, getSystemInstruction } from './context.js';
import { CapabilityRouter } from './capabilities.js';
import { ExtensionRegistry } from './extensions.js';
import { McpClientManager } from './mcp.js';
import { Telemetry } from './telemetry.js';
import { ModelRouter } from './router.js';
import { AutomationEngine } from './automation.js';
import { InteractionLayer } from './ux.js';
import { SessionManager, Session } from './session.js';
import { Supervisor } from './agents.js';
import { IdentityManager } from './federation/identity.js';
import { TrustRegistry } from './federation/trust.js';
import { ResearchEngine } from './research.js';
import { TransactionManager } from './transaction.js';
import { EventStore } from './runtime/events.js';
import { RuntimeReconciler } from './runtime/recovery.js';
import { GoalManager } from './goals/manager.js';
import { WorldModel } from './world/model.js';

import { Config } from './config.js';

// Load local .env
dotenv.config();

function startProxyBackground() {
    if (process.env.ROSE_HEADLESS === '1') return; // cloud mesh server: no local proxy

    try {
        const proxy = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'antigravity-proxy-ai'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        proxy.unref();
    } catch (e) {
        // fail silently if proxy can't be started
    }
}

class RuntimeLifecycle {
    public static isReady = false;
    
    public static async boot() {
        console.log(chalk.cyan('Booting Agent Platform...'));

        // 1. Config & 2. Env validated by Config engine
        const cfg = Config.get();
        console.log(chalk.gray(`Environment: ${cfg.env}`));

        // Phase 33: seed backend engines from persisted preferences.
        const { SecurityEngine, AutonomyMode: AM } = await import('./security.js');
        if (cfg.security.autonomy === 'safe') SecurityEngine.autonomyMode = AM.SAFE;
        else if (cfg.security.autonomy === 'autonomous') SecurityEngine.autonomyMode = AM.AUTONOMOUS;
        else SecurityEngine.autonomyMode = AM.BALANCED;
        const { LearningStore } = await import('./learning.js');
        LearningStore.enabled = cfg.memory?.learningEnabled !== false;

        // 3. Storage & 4. Event Store
        EventStore.init();

        // 5. Recover Projections
        await TransactionManager.init();
        await RuntimeReconciler.recover();

        // 6-15. Initialize Core Systems
        startProxyBackground();
        Telemetry.initialize();
        await ModelRouter.initialize();
        AutomationEngine.initialize();
        await GoalManager.init();
        await WorldModel.init();
        
        this.isReady = true;
        console.log(chalk.green('âœ” Runtime READY'));
    }

    public static async shutdown() {
        console.log(chalk.yellow('\nInitiating graceful shutdown...'));
        this.isReady = false;
        // Mock flush/close
        process.exit(0);
    }
}

process.on('SIGINT', async () => {
    await RuntimeLifecycle.shutdown();
});

/** Chat/voice surfaces need a provider; the headless mesh server does NOT.
 * Cloud deployments call this only where AI is actually used (Phase 37 §3). */
export function requireProviderConfigured(): void {
  const c = Config.get();
  const hasAnyKey = c.keys?.gemini || c.keys?.anthropic || c.keys?.openai || c.keys?.openrouter
      || c.agent?.provider === 'proxy' || c.agent?.provider === 'ollama';
  if (!hasAnyKey) {
    console.error(chalk.red('\nError: No API keys or proxy configured.'));
    console.log(chalk.yellow('Run the setup wizard to configure your agent:'));
    console.log(chalk.bold.cyan('  rose setup'));
    process.exit(1);
  }
}



// Live API model (WebSocket / BidiGenerateContent) and text-only fallback model
// now live in src/voice/live-session.js alongside the connection itself.

export class GeminiLiveChat {
  private genAI: GoogleGenerativeAI;
  private activeSession: Session;
  private rl!: readline.Interface;
  public sessionId: string = crypto.randomUUID();
  private isVoiceMode = false;
  private currentSession = 'default';
  private didShutdown = false;
  private inputClosed = false;
  private exitRequested = false;
  private consoleInput: fs.ReadStream | null = null;
  private liveSuggestionInput: NodeJS.ReadableStream | null = null;
  private liveSuggestionHandler: ((input: string, key: any) => void) | null = null;
  private liveSuggestionVisible = false;

  /** Voice subsystem: Live socket, mic capture, playback, screen share. */
  public readonly voice: LiveSessionController;

  get taskExecutor() { return this.activeSession.taskExecutor; }
  get contextManager() { return this.activeSession.contextManager; }
  get chatHistory() { return this.activeSession.chatHistory; }
  set chatHistory(val) { this.activeSession.chatHistory = val; }
  get attachments() { return this.activeSession.attachments; }
  set attachments(val) { this.activeSession.attachments = val; }

  constructor() {
    this.activeSession = SessionManager.createSession(this.currentSession);
    this.genAI = new GoogleGenerativeAI(Config.get().keys?.gemini || '');
    this.voice = new LiveSessionController({
      getChatHistory: () => this.chatHistory,
      setChatHistory: (messages) => { this.chatHistory = messages; },
      isVoiceMode: () => this.isVoiceMode,
      onConnected: () => { this.currentSession = `session_${Date.now()}`; },
    });
    this.createReadline(process.stdin);
    displayWelcome();
  }

  /** Create the command prompt and track an unexpected stdin close. */
  private createReadline(input: NodeJS.ReadableStream): void {
    this.removeLiveCommandSuggestions();
    const completer = (line: string) => {
      let search = line.toLowerCase();
      if (search === '/mik') search = '/mic';
      if (search === '/voic') search = '/voice';

      const hits = CLI_COMMANDS.filter((command) => command.startsWith(search));
      return [hits.length ? hits : CLI_COMMANDS, line];
    };

    this.rl = createInterface({
      input,
      output: process.stdout,
      terminal: true,
      completer,
    });
    this.rl.on('close', () => {
      this.inputClosed = true;
    });
    this.installLiveCommandSuggestions(input);
  }

  /** Show matching commands beneath the prompt as the user types. */
  private installLiveCommandSuggestions(input: NodeJS.ReadableStream): void {
    readline.emitKeypressEvents(input);
    const handler = (_input: string, key: any) => {
      if (key?.name === 'tab') {
        const matches = this.getCommandMatches(this.rl.line);
        if (matches.length > 0) this.replacePromptCommand(matches[0]);
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        this.clearLiveCommandSuggestions();
        return;
      }

      setImmediate(() => this.renderLiveCommandSuggestions());
    };

    input.on('keypress', handler);
    this.liveSuggestionInput = input;
    this.liveSuggestionHandler = handler;
  }

  private removeLiveCommandSuggestions(): void {
    if (this.liveSuggestionInput && this.liveSuggestionHandler) {
      this.liveSuggestionInput.removeListener('keypress', this.liveSuggestionHandler);
    }
    this.liveSuggestionInput = null;
    this.liveSuggestionHandler = null;
    this.clearLiveCommandSuggestions();
  }

  private getCommandMatches(query: string): string[] {
    const command = query.trim().toLowerCase();
    // Do not open a menu for a bare `/`; wait until the user has typed a
    // command character so the prompt never floods with every command.
    if (command.length < 2 || !command.startsWith('/') || /\s/.test(command) || CLI_COMMANDS.includes(command)) return [];
    return CLI_COMMANDS.filter((candidate) => candidate.startsWith(command));
  }

  private replacePromptCommand(command: string): void {
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(command);
    this.clearLiveCommandSuggestions();
  }

  private renderLiveCommandSuggestions(): void {
    const matches = this.getCommandMatches(this.rl.line);
    const suggestion = this.formatLiveCommandSuggestion(matches);
    this.writeLiveSuggestion(suggestion);
  }

  /** Keep the transient menu to one terminal row; never wrap command names. */
  private formatLiveCommandSuggestion(matches: string[]): string {
    if (matches.length === 0) return '';

    const maxWidth = Math.max(24, (process.stdout.columns || 80) - 4);
    const shown = matches.slice(0, 5);
    const label = () => {
      const remaining = matches.length - shown.length;
      const suffix = remaining > 0 ? `  +${remaining} more` : matches.length === 1 ? '  (Tab to select)' : '';
      return `â†³ ${shown.join('  ')}${suffix}`;
    };

    while (shown.length > 1 && label().length > maxWidth) shown.pop();
    return chalk.gray(label());
  }

  private clearLiveCommandSuggestions(): void {
    this.writeLiveSuggestion('');
  }

  /** Draw a single transient line directly below the active readline prompt. */
  private writeLiveSuggestion(text: string): void {
    if (!process.stdout.isTTY) return;
    if (!text && !this.liveSuggestionVisible) return;

    // Save the prompt cursor, replace the line below it, then restore the
    // cursor so typing continues uninterrupted.
    process.stdout.write('\x1b[s\x1b[1B\r\x1b[2K');
    if (text) process.stdout.write(text);
    process.stdout.write('\x1b[u');
    this.liveSuggestionVisible = text.length > 0;
  }

  /**
   * A few Windows terminal hosts close readline after taking focus for a
   * spinner. Recreate the prompt instead of allowing the CLI to end after a
   * successful reply. A real EOF still exits cleanly when no console exists.
   */
  private restoreInput(): boolean {
    if (this.exitRequested) return false;

    try {
      if (process.stdin.readable && !process.stdin.destroyed) {
        this.inputClosed = false;
        this.createReadline(process.stdin);
        return true;
      }

      if (process.platform === 'win32') {
        this.consoleInput?.destroy();
        this.consoleInput = fs.createReadStream('\\\\.\\CONIN$');
        this.consoleInput.on('error', () => {
          this.inputClosed = true;
        });
        this.inputClosed = false;
        this.createReadline(this.consoleInput);
        return true;
      }
    } catch {
      // This is expected when the CLI was intentionally run with piped input.
    }

    return false;
  }

  public async initializeExtensions() {
    Telemetry.initialize();
    await ModelRouter.initialize();
    AutomationEngine.initialize();
    IdentityManager.initialize();
    TrustRegistry.initialize();
    
    // Wire up AutomationEngine execution hook
    AutomationEngine.executeTaskHook = async (goal: string) => {
        console.log(chalk.magenta(`\nâš™ï¸  Running automation task: ${goal}`));
        return await this.taskExecutor.executeTask(goal, goal, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
    };
    
    // Phase 36: memory consolidation handler + optional schedule.
    const { AutomationHandlers } = await import('./automation.js');
    const { MemoryConsolidation } = await import('./memory/consolidation.js');
    AutomationHandlers.register('memory.consolidate', async () => await MemoryConsolidation.run());
    if (process.env.ROSE_MEMORY_CONSOLIDATION_CRON) {
        AutomationEngine.registerHandlerAutomation(
            'Memory Consolidation',
            process.env.ROSE_MEMORY_CONSOLIDATION_CRON,
            'memory.consolidate'
        );
        console.log(chalk.gray(`Memory consolidation scheduled: ${process.env.ROSE_MEMORY_CONSOLIDATION_CRON}`));
    }

    console.log(chalk.gray('Loading extensions...'));
    await ExtensionRegistry.discoverAndLoad();
  }

  private exit(code = 0): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.inputClosed = true;
    this.shutdown();
    process.exit(code);
  }


  /** Detect ffmpeg/ffplay and enumerate microphones. */
  /** Detect ffmpeg/ffplay and enumerate microphones (delegates to voice subsystem). */
  private async initAudio(): Promise<void> {
    await this.voice.initAudio();
  }

  // ----- Skill Orchestration -----

  private async determineContext(message: string): Promise<{ skills: string[], memoryQueries: string[] }> {
    const availableSkills = SkillRegistry.list();
    const skillDescriptions = availableSkills.length > 0 
      ? availableSkills.filter(s => s.isValid).map(s => `- ${s.name}: ${s.description} (Keywords: ${(s.keywords || []).join(', ')})`).join('\n')
      : 'None';

    const prompt = `You are a context router. Given the user's request, determine which skills (if any) are needed, and what memory search queries (if any) would be useful to recall past project context or preferences.
Available skills:
${skillDescriptions}

User request: "${message}"

Respond ONLY with a valid JSON object matching this schema:
{
  "skills": ["skill1"],
  "memoryQueries": ["search term"]
}
If no skills are needed, use an empty array. If no memory search is needed, use an empty array. Do not include markdown formatting or any other text.`;

    try {
      const data = await ModelRouter.route(
          { capabilities: ['fast'], intent: 'classification', maxTokens: 1000 },
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
      
      return {
        skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s: string) => !!SkillRegistry.get(s)) : [],
        memoryQueries: Array.isArray(parsed.memoryQueries) ? parsed.memoryQueries : []
      };
    } catch (err) {
      return { skills: [], memoryQueries: [] }; // Fallback
    }
  }

  private buildSkillContext(skillNames: string[]): string {
    if (skillNames.length === 0) return '';
    let context = '\n\n[ACTIVE SKILLS CONTEXT]\nThe following skills are currently active to help you process this request. Follow their rules strictly:\n\n';
    for (const name of skillNames) {
      const content = SkillRegistry.load(name);
      if (content) {
        context += `--- START SKILL: ${name.toUpperCase()} ---\n${content}\n--- END SKILL: ${name.toUpperCase()} ---\n\n`;
      }
    }
    return context;
  }

  // ----- Text input -----

  private async sendMessageViaLiveAPI(message: string): Promise<void> {
    if (!this.voice.isConnected || !this.voice.isOpen) {
      console.log(chalk.yellow('\nâš ï¸  Not connected to Live API. Falling back to standard API...\n'));
      await this.sendMessageViaSDK(message);
      return;
    }

    try {
      const { skills, memoryQueries } = await this.determineContext(message);
      let contextInjectedMessage = message;
      let memoryStr = "";
      let skillsStr = "";
      
      // Memory
      const projectMatch = path.basename(process.cwd()).toLowerCase();
      if (memoryQueries.length > 0) {
        let allMemories: any[] = [];
        for (const q of memoryQueries) {
          const res = await MemoryService.searchHybrid({ query: q, project: projectMatch });
          allMemories = allMemories.concat(res);
        }
        const uniqueMemories = Array.from(new Map(allMemories.map(m => [m.id, m])).values());
        if (uniqueMemories.length > 0) {
           console.log(chalk.gray(`\nðŸ§  Memory Retrieved: ${uniqueMemories.length} entries`));
           memoryStr = MemoryService.formatContextBlock(uniqueMemories.slice(0, 5));
        }
      }

      // Skills
      if (skills.length > 0) {
        console.log(chalk.gray(`\nðŸ’¡ Activated Skills: ${skills.join(', ')}`));
        skillsStr = this.buildSkillContext(skills);
      }

      const activeTask = this.taskExecutor.getActiveTask();
      const taskState = activeTask ? `Active Task: ${activeTask.goal}\nStatus: ${activeTask.status}` : "";
      
      const capabilitiesStr = CapabilityRouter.getCapabilitiesContext();

      if (this.attachments.length > 0) {
          const attachmentList = this.attachments.map(p => `Attached file: ${p}`).join('\n');
          message = `${message}\n\n[ATTACHMENTS]\n${attachmentList}`;
          this.attachments = []; // clear after sending
      }

      const { finalPrompt, prunedHistory } = await this.contextManager.buildContext({
         systemInstructions: getSystemInstruction() + '\n\n' + capabilitiesStr,
         taskState,
         activeSkills: skillsStr,
         memory: memoryStr,
         chatHistory: this.chatHistory,
         currentInput: message
      });
      this.chatHistory = prunedHistory;
      contextInjectedMessage = finalPrompt;

      const complexity = await TaskRouter.detectComplexity(message);
      if (complexity === 'RESEARCH') {
        console.log(chalk.magenta('\nðŸ”¬ Starting Deep Research Engine...'));
        const result = await ResearchEngine.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        const clientContent = {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Research result: ${result}` }] }],
            turnComplete: true
          }
        };
        this.voice.sendJson(clientContent);
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        return;
      }
      if (complexity === 'ORCHESTRATED') {
        console.log(chalk.magenta('\nðŸ§  Starting Multi-Agent Orchestration...'));
        const result = await Supervisor.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        const clientContent = {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Multi-agent result: ${result}` }] }],
            turnComplete: true
          }
        };
        this.voice.sendJson(clientContent);
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        return;
      }
      if (complexity === 'MULTI_STEP') {
        const isSimulate = message.toLowerCase().startsWith('/simulate');
        const goal = isSimulate ? message.substring(9).trim() : message;

        console.log(chalk.magenta(isSimulate ? '\nðŸ”¬ Starting Predictive Simulation...' : '\nðŸš€ Starting Autonomous Task Execution...'));
        const result = await this.taskExecutor.executeTask(goal, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        }, { simulate: isSimulate });
        
        // Report final result to user
        const clientContent = {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Task result: ${result}` }] }],
            turnComplete: true
          }
        };
        this.voice.sendJson(clientContent);
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        return;
      }

      // Inject the pure original message into history, but send the finalPrompt to the server for this turn
      this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
      
      const clientContent = {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: contextInjectedMessage }] }],
          turnComplete: true
        }
      };
      this.voice.sendJson(clientContent);
      console.log(chalk.gray('â³ Waiting for response...'));
    } catch (error: any) {
      console.error(chalk.red('\nâŒ Error sending message:'), error.message);
    }
  }

  private async sendMessageViaSDK(message: string): Promise<void> {
    const spinner = ora({ text: chalk.cyan('ðŸ¤” Thinking...'), discardStdin: false }).start();
    try {
      const { skills, memoryQueries } = await this.determineContext(message);
      let contextInjectedMessage = message;
      let memoryStr = "";
      let skillsStr = "";
      
      // Memory
      const projectMatch = path.basename(process.cwd()).toLowerCase();
      if (memoryQueries.length > 0) {
        let allMemories: any[] = [];
        for (const q of memoryQueries) {
          const res = await MemoryService.searchHybrid({ query: q, project: projectMatch });
          allMemories = allMemories.concat(res);
        }
        const uniqueMemories = Array.from(new Map(allMemories.map(m => [m.id, m])).values());
        if (uniqueMemories.length > 0) {
           spinner.text = chalk.cyan(`ðŸ§  Retrieved ${uniqueMemories.length} memories...`);
           memoryStr = MemoryService.formatContextBlock(uniqueMemories.slice(0, 5));
        }
      }

      // Skills
      if (skills.length > 0) {
        spinner.text = chalk.cyan(`ðŸ’¡ Activating skills: ${skills.join(', ')}...`);
        skillsStr = this.buildSkillContext(skills);
      }

      const activeTask = this.taskExecutor.getActiveTask();
      const taskState = activeTask ? `Active Task: ${activeTask.goal}\nStatus: ${activeTask.status}` : "";

      const capabilitiesStr = CapabilityRouter.getCapabilitiesContext();

      if (this.attachments.length > 0) {
          const attachmentList = this.attachments.map(p => `Attached file: ${p}`).join('\n');
          message = `${message}\n\n[ATTACHMENTS]\n${attachmentList}`;
          this.attachments = []; // clear after sending
      }

      const { finalPrompt, prunedHistory, stats } = await this.contextManager.buildContext({
         systemInstructions: getSystemInstruction() + '\n\n' + capabilitiesStr,
         taskState,
         activeSkills: skillsStr,
         memory: memoryStr,
         chatHistory: this.chatHistory,
         currentInput: message
      });
      this.chatHistory = prunedHistory;
      contextInjectedMessage = finalPrompt;

      spinner.stop();
      const complexity = await TaskRouter.detectComplexity(message);
      if (complexity === 'RESEARCH') {
        console.log(chalk.magenta('\nðŸ”¬ Starting Deep Research Engine...'));
        const result = await ResearchEngine.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\nðŸ¤– AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + 'â”€'.repeat(60)) + '\n');
        return;
      }
      if (complexity === 'ORCHESTRATED') {
        console.log(chalk.magenta('\nðŸ§  Starting Multi-Agent Orchestration...'));
        const result = await Supervisor.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\nðŸ¤– AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + 'â”€'.repeat(60)) + '\n');
        return;
      }
      if (complexity === 'MULTI_STEP') {
        console.log(chalk.magenta('\nðŸš€ Starting Autonomous Task Execution...'));
        const result = await this.taskExecutor.executeTask(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\nðŸ¤– AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + 'â”€'.repeat(60)) + '\n');
        return;
      }
      // Phase 36 hotfix — AGENTIC TOOL LOOP for the text/SDK path.
      // Previously tool declarations were only sent on the Live voice path;
      // here the model never saw them and answered "I have no access".
      spinner.stop();

      const convoMessages: any[] = this.chatHistory.map(msg => ({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: msg.parts[0]?.text || ''
      }));
      convoMessages.push({ role: 'user', content: contextInjectedMessage });

      const roseTools = ToolRegistry.getDeclarations();
      const MAX_TOOL_ITERATIONS = 6;
      let replyText = '';

      try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          const data: any = await ModelRouter.route(
              { intent: 'generation', maxTokens: 8192, tools: roseTools },
              convoMessages,
              getSystemInstruction()
          );

          // ---- extract function calls across provider shapes ----
          const fnCalls: Array<{ id: string; name: string; args: any }> = [];
          let textParts: string[] = [];

          if (data?.content && Array.isArray(data.content)) {
            for (const part of data.content) {
              if (part?.type === 'tool_use' && part.name) {
                fnCalls.push({ id: part.id || `call_${iteration}_${fnCalls.length}`, name: part.name, args: part.input ?? {} });
              } else if (part?.functionCall?.name) {
                fnCalls.push({ id: `call_${iteration}_${fnCalls.length}`, name: part.functionCall.name, args: part.functionCall.args ?? {} });
              } else if ((part?.type === 'text' || !part?.type) && part?.text) {
                textParts.push(part.text);
              }
            }
          } else if (typeof data?.content === 'string') {
            textParts.push(data.content);
          }
          const openaiCalls = data?.choices?.[0]?.message?.tool_calls;
          if (Array.isArray(openaiCalls)) {
            for (const tc of openaiCalls) {
              if (tc?.function?.name) {
                let parsedArgs: any = {};
                try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
                fnCalls.push({ id: tc.id || `call_${iteration}_${fnCalls.length}`, name: tc.function.name, args: parsedArgs });
              }
            }
          }

          if (fnCalls.length === 0) {
            replyText = textParts.join('\n') || data?.choices?.[0]?.message?.content || '';
            break;
          }

          // ---- execute each requested tool through the Security pipeline ----
          const toolResults: any[] = [];
          for (const call of fnCalls) {
            console.log(chalk.magenta(`\n🔧 Tool: ${call.name}(${JSON.stringify(call.args).slice(0, 120)})`));
            let resultText: string;
            try {
              const response = await ToolExecutor.execute(call);
              resultText = typeof response === 'string'
                  ? response
                  : JSON.stringify(response?.response ?? response?.result ?? response);
            } catch (e: any) {
              resultText = `Tool error: ${e.message}`;
            }
            console.log(chalk.gray(`   ↳ ${(resultText || '').substring(0, 300).replace(/\n/g, ' ')}`));
            toolResults.push({ id: call.id, name: call.name, result: String(resultText).slice(0, 8000) });
          }
          let fallbackText = toolResults.map(r => `[System Log: Tool '${r.name}' returned:\n${r.result}]`).join('\n\n');
          convoMessages.push({ role: 'assistant', content: textParts.join('\n'), tool_calls: fnCalls });
          convoMessages.push({ role: 'user', content: fallbackText, tool_results: toolResults });
          console.log(chalk.gray('   continuing with tool results...\n'));
        }

        if (!replyText) {
          replyText = 'I used my available tools but need more steps to finish. Here is what I found so far.';
        }
      } catch (err: any) {
          console.error(chalk.red('\n❌ Agent API Error: ' + err.message));
          if (!replyText) return;
      }

      if (!replyText) {
          console.error(chalk.red('No response from any provider.'));
          return;
      }

      this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
      this.chatHistory.push({ role: 'model', parts: [{ text: replyText }] });
      console.log(chalk.green('\n🤖 AI: ') + chalk.white(replyText));
      console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}\n`));
    }
  }

  private showConfig(): void {
    console.log(chalk.bold.cyan('\nâš™ï¸  Current Configuration:\n'));
    console.log(chalk.white(`  Live Model:  ${chalk.yellow(MODEL_LIVE)}`));
    console.log(chalk.white(`  Text Model:  ${chalk.yellow(MODEL_TEXT)}`));
    console.log(chalk.white(`  Connected:   ${this.voice.isConnected ? chalk.green('Yes') : chalk.red('No')}`));
    console.log(chalk.white(`  Voice Mode:  ${this.isVoiceMode ? chalk.green('Enabled (AUDIO)') : chalk.yellow('Disabled (TEXT)')}`));
    console.log(chalk.white(`  Voice Name:  ${chalk.cyan(this.voice.voiceName)}`));
    console.log(chalk.white(`  Recording:   ${this.voice.isRecording ? chalk.green('Yes') : chalk.gray('No')}`));
    console.log(chalk.white(`  Microphone:  ${chalk.cyan(this.voice.currentMicDevice || 'none')}`));
    console.log(chalk.white(`  ffmpeg:      ${this.voice.ffmpegAvailable ? chalk.green('yes') : chalk.red('no')}   ffplay: ${this.voice.playbackAvailable ? chalk.green('yes') : chalk.red('no')}`));
    console.log(chalk.white(`  Session:     ${chalk.gray(this.currentSession || 'Not started')}`));
    console.log(chalk.white(`  Messages:    ${chalk.cyan(this.chatHistory.length)}`));
    console.log(chalk.white(`  Audio Chunks:${chalk.cyan(' ' + this.voice.audioBufferLength)}\n`));
  }

  /** Route a slash command: prefix matching, typo suggestions, registry dispatch. */
  private async handleCommand(command: string): Promise<boolean> {
    const parts = command.trim().split(/\s+/);
    let cmd = parts[0].toLowerCase();
    const arg = parts[1];

    const validCommands = CLI_COMMANDS;
    const prefixMatches = validCommands.filter((validCommand) => validCommand.startsWith(cmd));

    // Let a user choose the only matching command by typing its prefix. For
    // example, `/mc` selects `/mcp`; this is reliable even in terminals where
    // the Tab key is intercepted before readline receives it.
    if (!validCommands.includes(cmd) && prefixMatches.length === 1) {
      cmd = prefixMatches[0];
      console.log(chalk.gray(`? Selected command: ${cmd}`));
    }

    if (!validCommands.includes(cmd)) {
      if (prefixMatches.length > 0) {
        console.log(chalk.yellow(`Matching commands for "${parts[0]}":\n  ${prefixMatches.join('\n  ')}\n`));
        return false;
      }

      // Find the closest matches for typo suggestions
      let minDistance = Infinity;
      const suggestions: string[] = [];
      for (const validCmd of validCommands) {
        const distance = levenshteinDistance(cmd, validCmd);
        if (distance < minDistance) minDistance = distance;
        if (distance <= 2) suggestions.push(validCmd);
      }

      if (minDistance <= 2) {
        console.log(chalk.yellow(`Unknown command "${cmd}".`));
        console.log(chalk.yellow(`Did you mean:\n  ${suggestions.join('\n  ')}\n`));
        return false;
      }
      // If no close matches, fall through to the unknown-command message.
    }

    const entry = findCommandHandler(cmd);
    if (!entry) {
      console.log(chalk.red(`âŒ Unknown command: ${command}`));
      console.log(chalk.gray('Type /help to see available commands\n'));
      return false;
    }

    // `/simulate <goal>` is intentionally forwarded to the chat pipeline,
    // which detects the prefix and runs the task in simulation mode.
    if (cmd === '/simulate') {
      await this.sendMessageViaLiveAPI(command.trim());
      return false;
    }

    const shouldExit = await entry.run(this.cliContext, { cmd, arg, parts, raw: command });
    return shouldExit === true;
  }

  /** Lazily-built CliContext handed to command handlers (keeps session getters live). */
  private _cliContext: CliContext | null = null;
  get cliContext(): CliContext {
    if (!this._cliContext) {
      const self = this;
      this._cliContext = {
        getChatHistory: () => self.chatHistory,
        setChatHistory: (messages) => { self.chatHistory = messages; },
        getAttachments: () => self.attachments,
        setAttachments: (paths) => { self.attachments = paths; },
        getSessionLabel: () => self.currentSession,
        setSessionLabel: (id) => { self.currentSession = id; },
        switchSession: (id) => {
          self.currentSession = id;
          let s = SessionManager.getSession(self.currentSession);
          if (!s) s = SessionManager.createSession(self.currentSession);
          self.activeSession = s;
        },
        clearCurrentSessionContext: () => SessionManager.clearSessionContext(self.currentSession),
        get taskExecutor() { return self.taskExecutor; },
        get contextManager() { return self.contextManager; },
        get voice() { return self.voice; },
        isVoiceMode: () => self.isVoiceMode,
        setVoiceMode: (enabled) => { self.isVoiceMode = enabled; },
        sendLiveTurn: async (message) => { await self.sendMessageViaLiveAPI(message); },
        shutdown: () => self.shutdown(),
      };
    }
    return this._cliContext;
  }

  shutdown(): void {
    if (this.didShutdown) return;
    this.didShutdown = true;
    this.voice.shutdownAudio();
    console.log(chalk.yellow('\nðŸ‘‹ Goodbye! Thanks for chatting.\n'));
  }

  private askQuestionAsync(query: string): Promise<string | null> {
    return new Promise(resolve => {
      const prompt = this.rl;
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => prompt.removeListener('close', onClose);

      prompt.once('close', onClose);
      prompt.question(query, (answer) => {
        cleanup();
        this.clearLiveCommandSuggestions();
        resolve(answer);
      });
    });
  }

  async start(): Promise<void> {
    await SkillRegistry.discover();
    await this.initAudio();
    if (this.inputClosed) return;

    while (!this.inputClosed) {
      const input = await this.askQuestionAsync(chalk.bold.blue('You: '));
      if (input === null) {
        if (this.restoreInput()) continue;
        break;
      }
      if (this.inputClosed) break;

      const message = input.trim();
      if (!message) continue;

      if (message.startsWith('/')) {
        Telemetry.startTrace(this.sessionId);
        const shouldExit = await this.handleCommand(message);
        Telemetry.endTrace();
        if (shouldExit) {
          this.exit(0);
          break;
        }
        continue;
      }

      if (this.voice.isConnected) {
        Telemetry.startTrace(this.sessionId);
        await this.sendMessageViaLiveAPI(message);
        Telemetry.endTrace();
      } else {
        Telemetry.startTrace(this.sessionId);
        await this.sendMessageViaSDK(message);
        Telemetry.endTrace();
      }
    }
  }
}

export { RuntimeLifecycle };




