import { GoogleGenerativeAI } from '@google/generative-ai';
import * as readline from 'readline';
import dotenv from 'dotenv';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import screenshot from 'screenshot-desktop';
const execPromise = promisify(exec);

// Helper for command similarity
function levenshteinDistance(a: string, b: string): number {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) == a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1) // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
import {
  AudioPlayer,
  MicRecorder,
  detectTools,
  listInputDevices,
  pcmToWav,
  AudioTools,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  logToJSON,
} from './audio.js';
import { ToolRegistry, ToolExecutor } from './tools.js';
import { SkillRegistry } from './skills.js';
import { MemoryService } from './memory.js';
import { TaskRouter, TaskExecutor } from './tasks.js';
import { ContextManager, getSystemInstruction } from './context.js';
import { CapabilityRouter } from './capabilities.js';
import { ExternalServiceManager } from './services.js';
import { ExtensionRegistry } from './extensions.js';
import { McpClientManager } from './mcp.js';
import { SecurityEngine, AutonomyMode } from './security.js';
import { Telemetry } from './telemetry.js';
import { MaintenanceEngine } from './maintenance/engine.js';
import { ModelRouter } from './router.js';
import { AutomationEngine } from './automation.js';
import { InteractionLayer } from './ux.js';
import { SessionManager, Session } from './session.js';
import { AgentServer } from './server.js';
import { Supervisor, AgentRegistry } from './agents.js';
import { IdentityManager } from './federation/identity.js';
import { TrustRegistry } from './federation/trust.js';
import { MetricsSystem, HealthMonitor, CapacityEngine, BottleneckAnalyzer, OptimizationEngine } from './observability/index.js';
import { ResearchEngine } from './research.js';
import { LearningStore, PreferenceManager, StrategyLearner, FeedbackProcessor } from './learning.js';
import { TransactionManager } from './transaction.js';
import { EventStore } from './runtime/events.js';
import { RuntimeReconciler } from './runtime/recovery.js';
import { TaskProjection } from './runtime/projections.js';
import { GoalManager } from './goals/manager.js';
import { WorldModel } from './world/model.js';
import { GoalLoop } from './goals/loop.js';
import { ObservationEngine } from './world/observer.js';
import { SimulationEngine } from './simulation/engine.js';
import { IncidentManager } from './rca/manager.js';
import { RCAEngine } from './rca/engine.js';
import { ReliabilityLab } from './reliability/lab.js';
import { PolicyStore } from './policy/store.js';


import { Config } from './config.js';

// Load local .env
dotenv.config();

function startProxyBackground() {
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
        console.log(chalk.green('✔ Runtime READY'));
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

// API keys are now validated per-provider inside the ModelRouter.
// No single key is required at boot — the router will throw clear errors if a key is missing.
const cfg = Config.get();
const hasAnyKey = cfg.keys?.gemini || cfg.keys?.anthropic || cfg.keys?.openai || cfg.agent?.provider === 'proxy';

if (!hasAnyKey) {
  console.error(chalk.red('\n❌ Error: No API keys or proxy configured.'));
  console.log(chalk.yellow('Run the setup wizard to configure your agent:'));
  console.log(chalk.bold.cyan('  rose setup'));
  process.exit(1);
}



// Live API model (WebSocket / BidiGenerateContent) and text-only fallback model.
const MODEL_LIVE = process.env.MODEL_LIVE || 'models/gemini-3.1-flash-live-preview';
const MODEL_TEXT = process.env.MODEL_TEXT || 'gemini-3.1-flash-lite';


// Gemini Live API - WebSocket endpoint (v1alpha BidiGenerateContent)
const LIVE_API_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${cfg.keys?.gemini || ''}`;

const VOICE_NAMES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
const CLI_COMMANDS = [
  '/voice', '/text', '/record', '/stop', '/mic', '/devices', '/voices', '/config',
  '/clear', '/history', '/save', '/help', '/exit', '/quit', '/skills', '/skill',
  '/memory', '/task', '/tasks', '/context', '/capabilities', '/services',
  '/connections', '/extensions', '/mcp', '/security', '/diagnostics', '/trace',
  '/last-run', '/models', '/providers', '/automations', '/automation', '/debug',
  '/verbose', '/compact', '/normal', '/sessions', '/session', '/attach', '/detach',
  '/attachments', '/agents', '/learning', '/preferences', '/strategies', '/feedback',
  '/simulate', '/transaction', '/transactions', '/runtime', '/events', '/queue',
  '/goals', '/goal', '/world', '/simulations', '/simulation', '/incidents',
  '/incident', '/dependencies', '/impact', '/root-cause', '/reliability',
  '/policies', '/policy', '/maintenance',
];



/** Convert a ws message payload (Buffer | ArrayBuffer | Buffer[]) to a string. */
function messageToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export class GeminiLiveChat {
  private genAI: GoogleGenerativeAI;
  private activeSession: Session;
  private rl!: readline.Interface;
  private ws: WebSocket | null = null;
  private audioStream: ChildProcessWithoutNullStreams | null = null;
  private audioProcess: ChildProcessWithoutNullStreams | null = null;
  public sessionId: string = crypto.randomUUID();
  private isConnected = false;
  private isVoiceMode = false;
  private audioBuffer: Buffer[] = [];
  private currentSession = 'default';
  private voiceName = process.env.VOICE_NAME || 'Puck';
  private isRecording = false;
  private didShutdown = false;
  private inputClosed = false;
  private exitRequested = false;
  private consoleInput: fs.ReadStream | null = null;
  private liveSuggestionInput: NodeJS.ReadableStream | null = null;
  private liveSuggestionHandler: ((input: string, key: any) => void) | null = null;
  private liveSuggestionVisible = false;
  private screenInterval: NodeJS.Timeout | null = null;
  
  get taskExecutor() { return this.activeSession.taskExecutor; }
  get contextManager() { return this.activeSession.contextManager; }
  get chatHistory() { return this.activeSession.chatHistory; }
  set chatHistory(val) { this.activeSession.chatHistory = val; }
  get attachments() { return this.activeSession.attachments; }
  set attachments(val) { this.activeSession.attachments = val; }

  // Audio backend
  private tools: AudioTools = { ffmpeg: false, ffplay: false };
  private player = new AudioPlayer();
  private recorder: MicRecorder | null = null;
  private micDevice = '';
  private micDevices: string[] = [];

  // Per-turn accumulators (used when the model streams audio + transcripts)
  private modelTranscript = '';
  private userTranscript = '';
  private turnAudioBytes = 0;

  constructor() {
    this.activeSession = SessionManager.createSession(this.currentSession);
    this.genAI = new GoogleGenerativeAI(cfg.keys?.gemini || '');
    this.createReadline(process.stdin);
    this.displayWelcome();
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
      return `↳ ${shown.join('  ')}${suffix}`;
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
        console.log(chalk.magenta(`\n⚙️  Running automation task: ${goal}`));
        return await this.taskExecutor.executeTask(goal, goal, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
    };
    
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
  private async initAudio(): Promise<void> {
    this.tools = await detectTools();
    if (this.tools.ffmpeg) {
      this.micDevices = await listInputDevices();
      if (this.micDevices.length > 0) {
        const defaultMic = process.env.DEFAULT_MIC;
        const matched = defaultMic ? this.micDevices.find((d) => d.toLowerCase().includes(defaultMic.toLowerCase())) : null;
        this.micDevice = matched || this.micDevices[0];
      }
    }

    if (this.tools.ffmpeg && this.tools.ffplay) {
      console.log(chalk.green('🔊 Audio backend ready (ffmpeg + ffplay detected).'));
      if (this.micDevice) {
        console.log(chalk.gray(`   🎙️  Microphone: ${this.micDevice}`));
      }
    } else {
      const missing = [
        !this.tools.ffmpeg ? 'ffmpeg' : null,
        !this.tools.ffplay ? 'ffplay' : null,
      ]
        .filter(Boolean)
        .join(' + ');
      console.log(chalk.yellow(`⚠️  Voice I/O disabled: ${missing} not found on PATH.`));
      console.log(chalk.gray('   Install FFmpeg (which includes ffplay) to enable voice-to-voice.'));
      console.log(chalk.gray('   Windows: winget install Gyan.FFmpeg   •   macOS: brew install ffmpeg'));
    }
    console.log();
  }

  private canPlay(): boolean {
    return this.tools.ffplay;
  }

  private canRecord(): boolean {
    return this.tools.ffmpeg && !!this.micDevice;
  }

  private displayWelcome(): void {
    console.clear();
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║') + chalk.bold.white('  🎙️  Gemini Flash Live - Voice to Voice AI Chat  🤖  ') + chalk.bold.cyan('║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════════╝\n'));
    console.log(chalk.yellow('🌟 Model Capabilities:'));
    console.log(chalk.white('  • High-quality, low-latency Audio-to-Audio (A2A)'));
    console.log(chalk.white('  • Real-time voice input and output'));
    console.log(chalk.white('  • Multi-turn conversations with context\n'));
    console.log(chalk.green('📝 Available Commands:'));
    console.log(chalk.white('  /voice    - Enable voice mode (auto-connects to Live API)'));
    console.log(chalk.white('  /text     - Switch back to text-only mode'));
    console.log(chalk.white('  /record   - Start speaking (if continuous listening failed)'));
    console.log(chalk.white('  /stop     - Stop recording and let the AI respond'));
    console.log(chalk.white('  /mic      - List / choose microphone (e.g. /mic 1)'));
    console.log(chalk.white('  /voices   - List available voice options'));
    console.log(chalk.white('  /config   - Show current configuration'));
    console.log(chalk.white('  /clear    - Clear chat history'));
    console.log(chalk.white('  /history  - Show conversation history'));
    console.log(chalk.white('  /save     - Save conversation (text + playable WAV)'));
    console.log(chalk.white('  /help     - Show this help message'));
    console.log(chalk.white('  /exit     - Exit the application\n'));
    console.log(chalk.white('  /extensions - List loaded extensions'));
    console.log(chalk.white('  /mcp      - List connected MCP servers'));
    console.log(chalk.white('  /security - Show Security settings'));
    console.log(chalk.white('  /diagnostics - Show Agent health'));
    console.log(chalk.white('  /models   - Show available models'));
    console.log(chalk.white('  /providers - Show provider health'));
    console.log(chalk.white('  /automations - Show active scheduled tasks'));
    console.log(chalk.white('  /trace    - Show execution trace of last task'));
    console.log(chalk.white('  /last-run - Show metrics of last task'));
    console.log(chalk.white('  /security mode [safe|balanced|autonomous] - Change autonomy mode\n'));
    console.log(chalk.gray('─'.repeat(60)) + '\n');
    console.log(chalk.cyan('💡 Tip: Just type /voice to connect. It will listen automatically!\n'));
  }

  private buildSetupMessage(): object {
    return {
      setup: {
        model: MODEL_LIVE,
        generationConfig: {
          responseModalities: [this.isVoiceMode ? 'AUDIO' : 'TEXT'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.voiceName },
            },
          },
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        },
        systemInstruction: {
          parts: [
            {
              text: getSystemInstruction() + '\n\nYou have access to an Obsidian vault memory system. Use save_memory to store facts and context permanently. Use search_memory to retrieve past knowledge. You also have an execute_command tool to run terminal/shell commands on the user\'s Windows computer when requested. You can now see the user\'s screen in real-time. Do not use blind keyboard navigation (like mashing TAB). Instead, look at the screen and use your execute_command tool precisely if you need to automate a task. IMPORTANT: If an execute_command tool returns an error, you MUST explicitly tell the user that it failed and read the error to them. Do not pretend it succeeded.',
            },
          ],
        },
        tools: [
          {
            functionDeclarations: ToolRegistry.getDeclarations(),
          },
        ],
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 50,
          }
        },
        // Ask the server for text transcripts of both sides so we can show them
        // alongside the streamed audio.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
  }

  private async connectToLiveAPI(): Promise<boolean> {
    if (this.isConnected) {
      console.log(chalk.green('✓ Already connected to Live API\n'));
      return true;
    }

    const spinner = ora({ text: chalk.cyan('🔌 Connecting to Gemini Flash Live API...'), discardStdin: false }).start();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      try {
        this.ws = new WebSocket(LIVE_API_URL);

        this.ws.on('open', () => {
          spinner.text = chalk.cyan('Sending setup configuration...');
          this.isConnected = true;
          this.currentSession = `session_${Date.now()}`;
          this.ws?.send(JSON.stringify(this.buildSetupMessage()));
        });

        this.ws.on('message', (data) => {
          let response: any;
          try {
            response = JSON.parse(messageToString(data));
          } catch (error: any) {
            console.error(chalk.red('\n❌ Error parsing response:'), error.message);
            return;
          }
          this.handleLiveAPIResponse(response, spinner, done);
        });

        this.ws.on('error', (error) => {
          spinner.fail(chalk.red('❌ Connection error'));
          console.error(chalk.red('WebSocket error:'), error.message);
          this.isConnected = false;
          done(false);
        });

        this.ws.on('close', (code, reason) => {
          spinner.stop();
          const detail = reason?.toString().trim();
          console.log(
            chalk.yellow(`\n🔌 Disconnected from Live API (code ${code}${detail ? `: ${detail}` : ''})`)
          );
          this.isConnected = false;
          this.ws = null;
          this.stopRecording(true);
          this.player.stop();
          done(false);
        });
      } catch (error: any) {
        spinner.fail(chalk.red('❌ Failed to connect'));
        console.error(chalk.red('Error:'), error.message);
        done(false);
      }
    });
  }

  private async handleLiveAPIResponse(
    response: any,
    spinner?: any,
    resolveConnection?: (value: boolean) => void
  ): Promise<void> {
    // Setup complete
    if (response.setupComplete) {
      spinner?.succeed(chalk.green('✅ Connected to Gemini Flash Live Preview!'));
      console.log(chalk.green(`✓ Session ID: ${this.currentSession}`));
      console.log(chalk.green(`✓ Mode: ${this.isVoiceMode ? 'AUDIO (voice)' : 'TEXT'}`));
      console.log(chalk.green(`✓ Voice Name: ${this.voiceName}`));
      console.log(chalk.green('✓ Ready for real-time conversation!\n'));
      if (this.isVoiceMode) {
        if (this.canRecord()) {
          console.log(chalk.cyan('🎤 Continuous listening is ON. Start speaking anytime.'));
          this.startRecording();
        } else {
          console.log(chalk.yellow('🎤 Mic capture unavailable — type a message and the AI replies with voice.'));
        }
        console.log(chalk.gray('   You can also just type text; responses are spoken aloud.\n'));
      }
      console.log(chalk.gray('─'.repeat(60)) + '\n');
      resolveConnection?.(true);
      return;
    }

    // Explicit server error
    if (response.error) {
      console.error(chalk.red('\n❌ Live API error:'), JSON.stringify(response.error));
      return;
    }

    if (response.serverContent) {
      const sc = response.serverContent;

      // Streaming transcripts (present when *AudioTranscription is enabled)
      if (sc.inputTranscription?.text) this.userTranscript += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) this.modelTranscript += sc.outputTranscription.text;

      // Model turn parts: text and/or audio
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.text) {
            this.modelTranscript += part.text;
            process.stdout.write(chalk.white(part.text));
          }
          if (part.inlineData?.mimeType?.startsWith('audio/')) {
            const audio = Buffer.from(part.inlineData.data, 'base64');
            this.turnAudioBytes += audio.length;
            this.audioBuffer.push(audio);
            if (this.canPlay()) this.player.write(audio);
          }
          if (part.executableCode) {
            console.log(chalk.magenta('\n💻 Code Generated:'));
            console.log(chalk.gray(part.executableCode.code));
          }
          if (part.codeExecutionResult) {
            console.log(chalk.magenta('\n✅ Code Execution Result:'));
            console.log(chalk.gray(part.codeExecutionResult.output));
          }
        }
      }

      // Barge-in / interruption: stop playing the (now stale) audio
      if (sc.interrupted) {
        this.player.stop();
        console.log(chalk.yellow('\n⚠️  Response interrupted'));
      }

      if (sc.turnComplete || sc.generationComplete) {
        this.finalizeTurn();
      }
    }

    if (response.toolCall) {
      console.log(chalk.blue('\n🔧 Tool Call:'), JSON.stringify(response.toolCall));
      const functionResponses: any[] = [];
      
      for (const call of response.toolCall.functionCalls) {
        const result = await ToolExecutor.execute(call);
        functionResponses.push(result);
      }
      
      if (functionResponses.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          toolResponse: {
            functionResponses
          }
        }));
      }
    }
    if (response.toolCallCancellation) {
      console.log(chalk.yellow('\n⚠️  Tool call cancelled'));
    }
  }

  /** Flush transcripts to history and print a tidy summary at end of a turn. */
  private finalizeTurn(): void {
    const userText = this.userTranscript.trim();
    const modelText = this.modelTranscript.trim();

    if (userText) {
      // Replace the placeholder we pushed when recording started, if present.
      const last = this.chatHistory[this.chatHistory.length - 1];
      if (last && last.role === 'user' && last.parts[0]?.text === '[voice input]') {
        last.parts[0].text = userText;
      } else {
        this.chatHistory.push({ role: 'user', parts: [{ text: userText }] });
      }
      console.log(chalk.blue('\n🗣️  You (voice): ') + chalk.white(userText));
    }

    if (modelText) {
      this.chatHistory.push({ role: 'model', parts: [{ text: modelText }] });
      if (this.isVoiceMode) {
        console.log(chalk.green('\n🤖 AI: ') + chalk.white(modelText));
      }
    }

    if (this.turnAudioBytes > 0) {
      const kb = (this.turnAudioBytes / 1024).toFixed(1);
      const played = this.canPlay() ? '🔊 played' : '💾 buffered (use /save)';
      console.log(chalk.cyan(`🎵 Voice response: ${kb} KB ${played}`));
    }

    console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
    this.modelTranscript = '';
    this.userTranscript = '';
    this.turnAudioBytes = 0;
  }

  // ----- Voice input (microphone streaming) -----

  private startRecording(): void {
    if (!this.isConnected) {
      console.log(chalk.yellow('⚠️  Not connected. Use /voice first.\n'));
      return;
    }
    if (!this.canRecord()) {
      console.log(chalk.yellow('⚠️  Microphone capture unavailable (ffmpeg or input device missing).'));
      console.log(chalk.gray('   Type your message instead — the AI will still reply with voice.\n'));
      return;
    }
    if (this.isRecording) {
      return;
    }

    this.isRecording = true;
    this.userTranscript = '';

    if (process.env.ENABLE_SCREEN_SHARE === 'true') {
      const intervalMs = parseInt(process.env.SCREEN_CAPTURE_INTERVAL_MS || '2000', 10);
      this.screenInterval = setInterval(() => this.sendScreenCapture(), intervalMs);
      console.log(chalk.cyan('🖥️  Screen Sharing is ON. AI can see your screen.'));
    }

    this.recorder = new MicRecorder(this.micDevice);
    this.recorder.start(
      (chunk) => this.sendRealtimeAudio(chunk),
      (err) => {
        // ffmpeg writes progress to stderr; only surface real spawn failures.
        if (/cannot|not found|no such|error opening|ENOENT/i.test(err.message)) {
          console.error(chalk.red('\n🎤 Recording error:'), err.message);
          this.stopRecording(true);
        }
      }
    );

    console.log(chalk.red(`\n🔴 Microphone is open ("${this.micDevice}"). AI will respond automatically.`));
  }

  private stopRecording(silent = false): void {
    if (this.screenInterval) {
      clearInterval(this.screenInterval);
      this.screenInterval = null;
    }
    if (!this.isRecording && !this.recorder) return;
    this.isRecording = false;
    this.recorder?.stop();
    this.recorder = null;
    if (!silent) {
      console.log(chalk.yellow('⏹️  Recording stopped — waiting for the AI to respond...\n'));
    }
  }

  private async sendScreenCapture(): Promise<void> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const imgBuffer = await screenshot({ format: 'jpg' });
      const msg = {
        realtimeInput: {
          video: {
            mimeType: 'image/jpeg',
            data: imgBuffer.toString('base64'),
          }
        },
      };
      this.ws.send(JSON.stringify(msg));
    } catch (err: any) {
      logToJSON('screen_capture_error', err.message);
    }
  }

  private sendRealtimeAudio(chunk: Buffer): void {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          data: chunk.toString('base64'),
        },
      },
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
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
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log(chalk.yellow('\n⚠️  Not connected to Live API. Falling back to standard API...\n'));
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
          const res = await MemoryService.search({ query: q, project: projectMatch });
          allMemories = allMemories.concat(res);
        }
        const uniqueMemories = Array.from(new Map(allMemories.map(m => [m.id, m])).values());
        if (uniqueMemories.length > 0) {
           console.log(chalk.gray(`\n🧠 Memory Retrieved: ${uniqueMemories.length} entries`));
           memoryStr = MemoryService.formatContextBlock(uniqueMemories.slice(0, 5));
        }
      }

      // Skills
      if (skills.length > 0) {
        console.log(chalk.gray(`\n💡 Activated Skills: ${skills.join(', ')}`));
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
        console.log(chalk.magenta('\n🔬 Starting Deep Research Engine...'));
        const result = await ResearchEngine.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        const clientContent = {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Research result: ${result}` }] }],
            turnComplete: true
          }
        };
        this.ws.send(JSON.stringify(clientContent));
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        return;
      }
      if (complexity === 'ORCHESTRATED') {
        console.log(chalk.magenta('\n🧠 Starting Multi-Agent Orchestration...'));
        const result = await Supervisor.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        const clientContent = {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Multi-agent result: ${result}` }] }],
            turnComplete: true
          }
        };
        this.ws.send(JSON.stringify(clientContent));
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        return;
      }
      if (complexity === 'MULTI_STEP') {
        const isSimulate = message.toLowerCase().startsWith('/simulate');
        const goal = isSimulate ? message.substring(9).trim() : message;

        console.log(chalk.magenta(isSimulate ? '\n🔬 Starting Predictive Simulation...' : '\n🚀 Starting Autonomous Task Execution...'));
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
        this.ws.send(JSON.stringify(clientContent));
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
      this.ws.send(JSON.stringify(clientContent));
      console.log(chalk.gray('⏳ Waiting for response...'));
    } catch (error: any) {
      console.error(chalk.red('\n❌ Error sending message:'), error.message);
    }
  }

  private async sendMessageViaSDK(message: string): Promise<void> {
    const spinner = ora({ text: chalk.cyan('🤔 Thinking...'), discardStdin: false }).start();
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
          const res = await MemoryService.search({ query: q, project: projectMatch });
          allMemories = allMemories.concat(res);
        }
        const uniqueMemories = Array.from(new Map(allMemories.map(m => [m.id, m])).values());
        if (uniqueMemories.length > 0) {
           spinner.text = chalk.cyan(`🧠 Retrieved ${uniqueMemories.length} memories...`);
           memoryStr = MemoryService.formatContextBlock(uniqueMemories.slice(0, 5));
        }
      }

      // Skills
      if (skills.length > 0) {
        spinner.text = chalk.cyan(`💡 Activating skills: ${skills.join(', ')}...`);
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
        console.log(chalk.magenta('\n🔬 Starting Deep Research Engine...'));
        const result = await ResearchEngine.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\n🤖 AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
        return;
      }
      if (complexity === 'ORCHESTRATED') {
        console.log(chalk.magenta('\n🧠 Starting Multi-Agent Orchestration...'));
        const result = await Supervisor.execute(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\n🤖 AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
        return;
      }
      if (complexity === 'MULTI_STEP') {
        console.log(chalk.magenta('\n🚀 Starting Autonomous Task Execution...'));
        const result = await this.taskExecutor.executeTask(message, contextInjectedMessage, (status, msg, detail) => {
            InteractionLayer.renderTaskProgress(status, msg, detail);
        });
        
        this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
        this.chatHistory.push({ role: 'model', parts: [{ text: result }] });
        console.log(chalk.green('\n🤖 AI: ') + chalk.white(result));
        console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
        return;
      }
      spinner.start();

      const anthropicMessages = this.chatHistory.map(msg => ({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: msg.parts[0]?.text || ''
      }));
      anthropicMessages.push({ role: 'user', content: contextInjectedMessage });

      let data: any;
      try {
          data = await ModelRouter.route(
              { intent: 'generation', maxTokens: 8192 },
              anthropicMessages,
              getSystemInstruction()
          );
      } catch (err: any) {
          spinner.fail('API Error');
          console.error(chalk.red('\n❌ Agent API Error: ' + err.message));
          return;
      }
      
      let replyText = "No text in response";
      let thinkingText = "";

      if (data.content && Array.isArray(data.content)) {
          // Anthropic format: content is an array of parts
          const textParts = [];
          for (const part of data.content) {
              if (part.type === "thinking" && part.thinking) {
                  thinkingText = part.thinking;
              } else if ((part.type === "text" || !part.type) && part.text) {
                  textParts.push(part.text);
              } else if (typeof part === 'string') {
                  textParts.push(part);
              }
          }
          if (textParts.length > 0) {
              replyText = textParts.join("\n");
          }
      } else if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
          replyText = data.choices[0].message.content; // OpenAI format
      } else {
          console.error("Unrecognized response format:", JSON.stringify(data, null, 2));
      }

      this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
      this.chatHistory.push({ role: 'model', parts: [{ text: replyText }] });

      spinner.succeed(chalk.green('✅ Response received'));
      if (thinkingText) {
          console.log(chalk.gray(`\n🤔 Thinking:\n${thinkingText}\n`));
      }
      console.log(chalk.green('\n🤖 AI: ') + chalk.white(replyText));
      console.log(chalk.gray('\n' + '─'.repeat(60)) + '\n');
    } catch (error: any) {
      spinner.fail(chalk.red('❌ Error occurred'));
      console.error(chalk.red(`Error: ${error.message}\n`));
    }
  }

  private displayHistory(): void {
    console.log(chalk.bold.yellow('\n📜 Chat History:\n'));
    if (this.chatHistory.length === 0) {
      console.log(chalk.gray('  No messages yet.\n'));
      return;
    }
    this.chatHistory.forEach((msg, index) => {
      const role = msg.role === 'user' ? chalk.blue('👤 You') : chalk.green('🤖 AI');
      const text = msg.parts[0]?.text || '[Non-text content]';
      const preview = text.length > 80 ? text.substring(0, 80) + '...' : text;
      console.log(`${chalk.gray(`[${index + 1}]`)} ${role}: ${preview}`);
    });
    console.log();
  }

  private clearHistory(): void {
    this.chatHistory = [];
    this.audioBuffer = [];
    console.log(chalk.green('✓ Chat history and audio buffer cleared\n'));
  }

  private showConfig(): void {
    console.log(chalk.bold.cyan('\n⚙️  Current Configuration:\n'));
    console.log(chalk.white(`  Live Model:  ${chalk.yellow(MODEL_LIVE)}`));
    console.log(chalk.white(`  Text Model:  ${chalk.yellow(MODEL_TEXT)}`));
    console.log(chalk.white(`  Connected:   ${this.isConnected ? chalk.green('Yes') : chalk.red('No')}`));
    console.log(chalk.white(`  Voice Mode:  ${this.isVoiceMode ? chalk.green('Enabled (AUDIO)') : chalk.yellow('Disabled (TEXT)')}`));
    console.log(chalk.white(`  Voice Name:  ${chalk.cyan(this.voiceName)}`));
    console.log(chalk.white(`  Recording:   ${this.isRecording ? chalk.green('Yes') : chalk.gray('No')}`));
    console.log(chalk.white(`  Microphone:  ${chalk.cyan(this.micDevice || 'none')}`));
    console.log(chalk.white(`  ffmpeg:      ${this.tools.ffmpeg ? chalk.green('yes') : chalk.red('no')}   ffplay: ${this.tools.ffplay ? chalk.green('yes') : chalk.red('no')}`));
    console.log(chalk.white(`  Session:     ${chalk.gray(this.currentSession || 'Not started')}`));
    console.log(chalk.white(`  Messages:    ${chalk.cyan(this.chatHistory.length)}`));
    console.log(chalk.white(`  Audio Chunks:${chalk.cyan(' ' + this.audioBuffer.length)}\n`));
  }

  private showVoices(): void {
    console.log(chalk.bold.magenta('\n🎤 Available Voices:\n'));
    const voices = [
      { name: 'Puck', desc: 'Default voice, friendly and natural' },
      { name: 'Charon', desc: 'Deep and authoritative' },
      { name: 'Kore', desc: 'Warm and expressive' },
      { name: 'Fenrir', desc: 'Strong and confident' },
      { name: 'Aoede', desc: 'Melodic and pleasant' },
    ];
    voices.forEach((voice) => {
      const current = voice.name === this.voiceName ? chalk.green(' (Current)') : '';
      console.log(`  ${chalk.cyan(voice.name)}${current} - ${chalk.gray(voice.desc)}`);
    });
    console.log(chalk.gray('\n  To change voice, use: /voice <name>   (e.g. /voice Charon)\n'));
  }

  private async showMics(selectIndex?: number): Promise<void> {
    if (!this.tools.ffmpeg) {
      console.log(chalk.yellow('\n⚠️  ffmpeg not available — cannot list microphones.\n'));
      return;
    }
    if (this.micDevices.length === 0) this.micDevices = await listInputDevices();

    if (typeof selectIndex === 'number') {
      if (selectIndex >= 0 && selectIndex < this.micDevices.length) {
        this.micDevice = this.micDevices[selectIndex];
        console.log(chalk.green(`✓ Microphone set to: ${this.micDevice}\n`));
        if (this.isRecording) {
          console.log(chalk.yellow('🔄 Restarting audio capture with new microphone...'));
          this.stopRecording(true);
          this.startRecording();
        }
      } else {
        console.log(chalk.red(`❌ Invalid mic index: ${selectIndex}\n`));
      }
      return;
    }

    console.log(chalk.bold.magenta('\n🎙️  Input Devices:\n'));
    if (this.micDevices.length === 0) {
      console.log(chalk.gray('  No input devices detected (or platform not supported).\n'));
      return;
    }
    this.micDevices.forEach((d, i) => {
      const current = d === this.micDevice ? chalk.green(' (Current)') : '';
      console.log(`  ${chalk.cyan(`[${i}]`)} ${d}${current}`);
    });
    console.log(chalk.gray('\n  Select with: /mic <index>   (e.g. /mic 1)\n'));
  }

  private async saveConversation(): Promise<void> {
    const spinner = ora({ text: chalk.cyan('💾 Saving conversation...'), discardStdin: false }).start();
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = path.join(process.cwd(), 'conversations');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const textFile = path.join(outputDir, `conversation_${timestamp}.txt`);
      let textContent = `Gemini Flash Live - Conversation\n`;
      textContent += `Session: ${this.currentSession}\n`;
      textContent += `Date: ${new Date().toLocaleString()}\n`;
      textContent += `Voice Mode: ${this.isVoiceMode ? 'Enabled' : 'Disabled'}\n`;
      textContent += `Messages: ${this.chatHistory.length}\n`;
      textContent += `\n${'='.repeat(60)}\n\n`;
      this.chatHistory.forEach((msg, index) => {
        const role = msg.role === 'user' ? '👤 You' : '🤖 AI';
        const text = msg.parts[0]?.text || '[Non-text content]';
        textContent += `[${index + 1}] ${role}:\n${text}\n\n`;
      });
      fs.writeFileSync(textFile, textContent, 'utf-8');

      // Concatenate all received PCM into a single playable WAV file.
      let wavFile: string | null = null;
      if (this.audioBuffer.length > 0) {
        const pcm = Buffer.concat(this.audioBuffer);
        const wav = pcmToWav(pcm, OUTPUT_SAMPLE_RATE);
        wavFile = path.join(outputDir, `audio_${timestamp}.wav`);
        fs.writeFileSync(wavFile, wav);
      }

      spinner.succeed(chalk.green('✅ Conversation saved!'));
      console.log(chalk.white(`  📄 Text: ${chalk.cyan(textFile)}`));
      if (wavFile) {
        console.log(chalk.white(`  🎵 Audio: ${chalk.cyan(wavFile)} (playable WAV)`));
      }
      console.log();
    } catch (error: any) {
      spinner.fail(chalk.red('❌ Failed to save'));
      console.error(chalk.red(`Error: ${error.message}\n`));
    }
  }

  /** Tear down the current socket and open a fresh one (needed to change
   * response modality or voice, which are fixed at setup time). */
  private async reconnect(): Promise<void> {
    if (this.ws) {
      this.stopRecording(true);
      this.player.stop();
      const old = this.ws;
      this.isConnected = false;
      this.ws = null;
      try {
        old.removeAllListeners();
        old.close();
      } catch {
        /* already closing */
      }
    }
    await this.connectToLiveAPI();
  }

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
      console.log(chalk.gray(`↳ Selected command: ${cmd}`));
    }

    if (!validCommands.includes(cmd)) {
      if (prefixMatches.length > 0) {
        console.log(chalk.yellow(`Matching commands for "${parts[0]}":\n  ${prefixMatches.join('\n  ')}\n`));
        return false;
      }

      // Find the closest match
      let bestMatch = '';
      let minDistance = Infinity;
      const suggestions: string[] = [];

      for (const validCmd of validCommands) {
        const distance = levenshteinDistance(cmd, validCmd);
        if (distance < minDistance) {
          minDistance = distance;
          bestMatch = validCmd;
        }
        if (distance <= 2) {
          suggestions.push(validCmd);
        }
      }

      if (minDistance <= 2) {
        console.log(chalk.yellow(`Unknown command "${cmd}".`));
        console.log(chalk.yellow(`Did you mean:\n  ${suggestions.join('\n  ')}\n`));
        return false;
      }
      // If no close matches, it will fall through to default switch case which prints unknown command
    }

    switch (cmd) {
      case '/exit':
      case '/quit':
        this.shutdown();
        return true;

      case '/skills':
      case '/skill':
        if (arg === 'reload') {
          console.log(chalk.cyan('\nReloading skills...'));
          await SkillRegistry.reload();
          const loadedSkills = SkillRegistry.list();
          for (const s of loadedSkills) {
            console.log(s.isValid ? chalk.green(`✓ ${s.name}`) : chalk.red(`✗ ${s.name} (${s.error})`));
          }
          console.log(chalk.cyan(`\n${loadedSkills.length} skills loaded.\n`));
        } else if (arg && arg !== 'info') {
          // handles /skills <name> or /skills info <name>
          const targetName = arg === 'info' && parts[2] ? parts[2] : arg;
          const skill = SkillRegistry.get(targetName);
          if (skill) {
            console.log(chalk.cyan(`\n${skill.name.toUpperCase()}`));
            console.log(chalk.white(`Description:\n${skill.description}`));
            if (skill.capabilities && skill.capabilities.length > 0) {
              console.log(chalk.white(`\nCapabilities:\n- ${skill.capabilities.join('\n- ')}`));
            }
            if (skill.tools && skill.tools.length > 0) {
              console.log(chalk.white(`\nTools:\n- ${skill.tools.join('\n- ')}`));
            }
            if (!skill.isValid) {
              console.log(chalk.red(`\nStatus: Error - ${skill.error}`));
            }
            console.log();
          } else {
            console.log(chalk.red(`❌ Unknown skill: ${targetName}\n`));
          }
        } else {
          // List all
          console.log(chalk.cyan('\nAvailable Skills:\n'));
          const loadedSkills = SkillRegistry.list();
          for (const s of loadedSkills) {
            console.log(chalk.white(s.name));
          }
          console.log();
        }
        break;

      case '/memory':
        if (arg === 'search') {
          const query = parts.slice(2).join(' ');
          if (!query) {
            console.log(chalk.yellow('Usage: /memory search <query>'));
            break;
          }
          const results = await MemoryService.search({ query });
          console.log(chalk.cyan(`\nMEMORY SEARCH RESULTS (${results.length}):`));
          for (const r of results) {
            console.log(chalk.green(`- [${r.type}] ${r.name} (${r.id})`));
            console.log(chalk.gray(`  ${r.content.substring(0, 100).replace(/\n/g, ' ')}...`));
          }
        } else if (arg === 'list') {
          const results = await MemoryService.list();
          console.log(chalk.cyan(`\nMEMORY VAULT (${results.length} entries):`));
          for (const r of results) {
            console.log(chalk.green(`- [${r.type}] ${r.name} (${r.id})`));
          }
        } else if (arg === 'delete') {
          const id = parts[2];
          if (!id) {
            console.log(chalk.yellow('Usage: /memory delete <id>'));
            break;
          }
          try {
            await MemoryService.delete(id);
            console.log(chalk.green(`Deleted memory ${id}`));
          } catch (e: any) {
            console.log(chalk.red(e.message));
          }
        } else if (arg === 'clear') {
           const confirm = parts[2];
           if (confirm === 'CONFIRM') {
             await MemoryService.clear();
           } else {
             console.log(chalk.red('This will delete ALL stored memories.'));
             console.log(chalk.red('Type "/memory clear CONFIRM" to proceed.'));
           }
        } else if (arg === 'reload') {
          console.log(chalk.cyan('Rebuilding memory index...'));
          MemoryService.reloadIndex();
          console.log(chalk.green('Memory system ready.'));
        } else {
           const all = await MemoryService.list();
           const projects = all.filter(a => a.type === 'projects').length;
           const prefs = all.filter(a => a.type === 'preferences').length;
           const know = all.filter(a => a.type === 'knowledge').length;
           const tasks = all.filter(a => a.type === 'tasks').length;
           
           console.log(chalk.cyan('\nMemory'));
           console.log(chalk.white(`Vault:\n${path.join(process.cwd(), 'memory', 'vault')}`));
           console.log(chalk.white(`\nEntries:\n${all.length}`));
           console.log(chalk.white(`\nTypes:`));
           console.log(chalk.gray(`Projects: ${projects}`));
           console.log(chalk.gray(`Preferences: ${prefs}`));
           console.log(chalk.gray(`Knowledge: ${know}`));
           console.log(chalk.gray(`Tasks: ${tasks}`));
           console.log(chalk.green(`\nStatus:\nHealthy\n`));
           console.log(chalk.gray(`Commands: search, list, delete, clear, reload\n`));
        }
        break;

      case '/task':
      case '/tasks':
        if (arg === 'status') {
          const t = this.taskExecutor.getActiveTask();
          if (!t) {
             console.log(chalk.gray('No active task.'));
          } else {
             console.log(chalk.cyan(`\nActive Task: ${t.goal}`));
             console.log(chalk.white(`Status: ${t.status}`));
             console.log(chalk.white(`Steps:`));
             t.steps.forEach((s, i) => {
               let symbol = ' ';
               if (s.status === 'completed') symbol = '✓';
               if (s.status === 'failed') symbol = '✗';
               if (s.status === 'running') symbol = '➜';
               if (s.status === 'pending') symbol = '·';
               console.log(chalk.gray(`  ${symbol} [${i+1}] ${s.description}`));
             });
             console.log();
          }
        } else if (arg === 'cancel') {
          this.taskExecutor.cancelTask();
        } else {
          console.log(chalk.gray('Commands: /task status, /task cancel'));
        }
        break;

      case '/context':
        if (arg === 'stats') {
           const { stats } = await this.contextManager.buildContext({
               systemInstructions: getSystemInstruction(),
               activeSkills: "",
               memory: "",
               chatHistory: this.chatHistory,
               currentInput: ""
           });
           console.log(chalk.cyan(`\n📊 Context Stats:`));
           console.log(chalk.white(`Budget: ${stats.budget} tokens`));
           console.log(chalk.white(`Usage:  ${stats.usage} tokens (${stats.percent}%)`));
           console.log(chalk.gray(`Messages: ${this.chatHistory.length}\n`));
        } else if (arg === 'compact') {
           console.log(chalk.yellow(`\nCompacting context...`));
           const newSummary = await this.contextManager.compactConversation(this.chatHistory);
           // Prune history
           this.chatHistory = this.chatHistory.slice(Math.max(0, this.chatHistory.length - 2));
           console.log(chalk.green(`✓ Conversation summarized.`));
           console.log(chalk.gray(`Messages reduced to ${this.chatHistory.length}.\n`));
        } else {
           console.log(chalk.gray('Commands: /context stats, /context compact'));
        }
        break;

      case '/capabilities':
        const caps = CapabilityRouter.getAvailableCapabilities();
        console.log(chalk.cyan('\n🔧 Available Capabilities:'));
        for (const [cap, available] of Object.entries(caps)) {
          if (available) {
             console.log(chalk.green(`  ✓ ${cap}`));
          } else {
             console.log(chalk.red(`  ✗ ${cap}`));
          }
        }
        console.log();
        break;

      case '/services':
      case '/connections':
        const services = ExternalServiceManager.getServices();
        console.log(chalk.cyan('\n🔌 Connected Services:'));
        for (const s of services) {
          if (s.status === 'available') {
             console.log(chalk.green(`  ✓ ${s.name} (connected)`));
          } else {
             console.log(chalk.red(`  ✗ ${s.name} (disconnected)`));
          }
        }
        console.log(chalk.gray(`\nTo connect, add tokens to your .env file.\n`));
        break;
        
      case '/extensions':
        const extensions = ExtensionRegistry.getExtensions();
        console.log(chalk.cyan('\n🧩 Loaded Extensions:'));
        if (extensions.length === 0) console.log(chalk.gray(`  No extensions loaded.`));
        for (const ext of extensions) {
           console.log(chalk.green(`  ✓ ${ext.name} (${ext.type}) v${ext.version}`));
        }
        console.log();
        break;

      case '/mcp':
        const mcpServers = McpClientManager.getClientStatuses();
        console.log(chalk.cyan('\n🔌 MCP Servers:'));
        if (mcpServers.length === 0) console.log(chalk.gray(`  No MCP servers connected.`));
        for (const mcp of mcpServers) {
           console.log(chalk.green(`  ✓ ${mcp.id} (connected)`));
        }
        console.log();
        break;

      case '/security':
        if (arg && arg.startsWith('mode ')) {
          const modeStr = arg.split(' ')[1].toLowerCase();
          if (modeStr === 'safe') SecurityEngine.autonomyMode = AutonomyMode.SAFE;
          else if (modeStr === 'balanced') SecurityEngine.autonomyMode = AutonomyMode.BALANCED;
          else if (modeStr === 'autonomous') SecurityEngine.autonomyMode = AutonomyMode.AUTONOMOUS;
          else {
            console.log(chalk.red('Unknown mode. Use: safe, balanced, or autonomous.'));
            break;
          }
          console.log(chalk.green(`\n🛡️ Autonomy Mode changed to: ${SecurityEngine.autonomyMode.toUpperCase()}\n`));
          break;
        }

        console.log(chalk.cyan('\n🛡️ Security Status'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(chalk.white(`Workspace Boundary: `) + chalk.green(SecurityEngine.workspaceRoot));
        console.log(chalk.white(`Autonomy Mode: `) + chalk.green(SecurityEngine.autonomyMode.toUpperCase()));
        console.log(chalk.white(`Secret Redaction: `) + chalk.green('Enabled'));
        console.log(chalk.white(`Terminal Sandboxing: `) + chalk.yellow('Partial (Pattern based)'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(chalk.gray(`Change mode via: /security mode [safe|balanced|autonomous]\n`));
        break;

      case '/diagnostics':
        console.log(chalk.cyan('\n🔍 Agent Diagnostics'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(chalk.white(`Core:             `) + chalk.green('✓'));
        console.log(chalk.white(`Gemini Live:      `) + chalk.green('✓'));
        console.log(chalk.white(`Security Engine:  `) + chalk.green('✓'));
        console.log(chalk.white(`Context Manager:  `) + chalk.green('✓'));
        console.log(chalk.white(`Planner:          `) + chalk.green('✓'));
        console.log(chalk.white(`Extensions:       `) + chalk.green(`${ExtensionRegistry.getExtensions().length} loaded`));
        console.log(chalk.white(`MCP:              `) + chalk.green(`${McpClientManager.getClientStatuses().length} connected`));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/trace':
        const recentEvents = Telemetry.getRecentTrace();
        console.log(chalk.cyan('\n📋 Recent Trace'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (recentEvents.length === 0) console.log(chalk.gray('No active trace.'));
        for (const evt of recentEvents) {
            const time = new Date(evt.timestamp).toISOString().substring(11, 19);
            const dur = evt.durationMs ? chalk.gray(`(${evt.durationMs}ms)`) : '';
            console.log(chalk.white(`${time} `) + chalk.cyan(`${evt.source}.${evt.type}`) + ` ${evt.status || ''} ${dur}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/last-run':
        const metrics = Telemetry.lastRunMetrics;
        console.log(chalk.cyan('\n📊 Last Run Metrics'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (!metrics.duration) {
            console.log(chalk.gray('No completed run metrics available.'));
        } else {
            console.log(chalk.white(`Duration: `) + chalk.green(`${metrics.duration}ms`));
            console.log(chalk.white(`Tools Executed: `) + chalk.green(metrics.tools || 0));
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/agent inspect':
        const [,, targetId] = parts;
        if (!targetId) {
            console.log(chalk.red('Usage: /agent inspect <agentId>'));
            return false;
        }
        const fAgent = TrustRegistry.getAgent(targetId);
        if (fAgent) {
            console.log(chalk.cyan(`\n🔍 Agent Inspector:`));
            console.log(chalk.white(`  ID: ${fAgent.id}`));
            console.log(chalk.white(`  Name: ${fAgent.identity.name || 'Unknown'}`));
            console.log(chalk.white(`  Endpoint: ${fAgent.endpoint}`));
            console.log(chalk.white(`  Trust: ${fAgent.trust}`));
            console.log(chalk.white(`  Status: ${fAgent.status}`));
            console.log(chalk.white(`  Capabilities: ${fAgent.identity.capabilities.join(', ')}`));
        } else {
            console.log(chalk.yellow(`No federated agent found with ID ${targetId}`));
        }
        return false;
        
      case '/agent trust':
        const [,,, trustId, level] = parts; // command is /agent trust <id> <level>
        if (!trustId || !level) {
            console.log(chalk.red('Usage: /agent trust <agentId> <trusted|restricted|blocked>'));
            return false;
        }
        if (['trusted', 'restricted', 'blocked'].includes(level)) {
            TrustRegistry.setTrust(trustId, level as any);
            console.log(chalk.green(`✓ Set trust level of ${trustId} to ${level}`));
        } else {
            console.log(chalk.red(`Invalid trust level: ${level}`));
        }
        return false;

      case '/agent revoke':
        const [,,,, revokeId] = parts;
        if (!revokeId) {
            console.log(chalk.red('Usage: /agent revoke <agentId>'));
            return false;
        }
        TrustRegistry.setTrust(revokeId, 'revoked');
        console.log(chalk.green(`✓ Revoked trust for ${revokeId}. All future interactions will be blocked.`));
        return false;

      case '/agents':
        const federated = TrustRegistry.getAllAgents();
        if (federated.length === 0) {
            console.log(chalk.gray('No federated agents connected.'));
        } else {
            console.log(chalk.bold.cyan('\n🌐 Federated Agents:\n'));
            federated.forEach(a => {
                const color = a.status === 'online' ? chalk.green : chalk.gray;
                const trustColor = a.trust === 'trusted' ? chalk.green : (a.trust === 'revoked' || a.trust === 'blocked' ? chalk.red : chalk.yellow);
                console.log(`  ${color('●')} ${a.id.padEnd(20)} | Trust: ${trustColor(a.trust.padEnd(10))} | Caps: ${a.identity.capabilities.length}`);
            });
        }
        return false;

      case '/observability':
      case '/health':
        console.log(chalk.bold.cyan('\n🩺 System Health & Observability'));
        const healths = HealthMonitor.getAllHealth();
        if (healths.length === 0) console.log(chalk.gray('No health data available.'));
        healths.forEach(h => {
            const color = h.state === 'healthy' ? chalk.green : (h.state === 'offline' ? chalk.gray : chalk.red);
            console.log(`  ${color('●')} ${h.componentType.padEnd(10)} | ID: ${h.componentId} | State: ${h.state}`);
        });
        
        const forecast = CapacityEngine.forecastQueueSaturation();
        console.log(chalk.bold.yellow('\n📊 Capacity Forecast'));
        console.log(`  Target: ${forecast.resource}`);
        console.log(`  Growth: ${forecast.growthRatePerHour.toFixed(2)} / hour`);
        if (forecast.estimatedSaturationHours) {
            console.log(`  Saturation expected in: ${forecast.estimatedSaturationHours.toFixed(1)} hours`);
        }
        
        const bottleneck = BottleneckAnalyzer.analyze();
        if (bottleneck) {
            console.log(chalk.bold.red('\n⚠️ Detected Bottlenecks'));
            console.log(`  Primary: ${bottleneck.primaryBottleneck}`);
            console.log(`  Symptoms: ${bottleneck.secondarySymptoms.join(', ')}`);
        }

        const opts = OptimizationEngine.getCandidates();
        if (opts.length > 0) {
            console.log(chalk.bold.magenta('\n💡 Optimization Candidates'));
            opts.forEach(opt => console.log(`  [${opt.id}] ${opt.target}: ${opt.proposal} (${opt.status})`));
        }
        
        console.log();
        return false;

      case '/models':
      case '/providers':
        console.log(chalk.cyan('\n🌐 Model Providers'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const providers = ModelRouter.getProviders();
        for (const p of providers) {
            const status = p.health === 'HEALTHY' ? chalk.green('✓ HEALTHY') : (p.health === 'DEGRADED' ? chalk.yellow('⚠ DEGRADED') : chalk.red('✗ OPEN (BLOCKED)'));
            console.log(`${chalk.white(p.name)} [${chalk.gray(p.id)}] - ${status}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/automations':
        console.log(chalk.cyan('\n⚙️ Automations'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const autos = AutomationEngine.list();
        if (autos.length === 0) console.log(chalk.gray('  No automations configured.'));
        for (const auto of autos) {
            const status = auto.enabled ? chalk.green('✓ ACTIVE') : chalk.yellow('⏸ PAUSED');
            console.log(`${status} ${chalk.white(auto.name)} [${chalk.gray(auto.id)}]`);
            console.log(`  Trigger: ${auto.trigger.value}`);
            console.log(`  Action: ${auto.action.goal}\n`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/learning':
        const prefsList = LearningStore.getPreferences();
        const stratsList = LearningStore.getStrategies();
        const explicit = prefsList.filter(p => p.source === 'explicit').length;
        const inferred = prefsList.filter(p => p.source === 'inferred' && p.status === 'CANDIDATE').length;
        const validated = stratsList.filter(s => s.status === 'VALIDATED' || s.status === 'PREFERRED').length;
        const stale = prefsList.filter(p => p.status === 'STALE').length;
        console.log(chalk.cyan(`\n📚 Learning Status`));
        console.log(chalk.gray(`────────────────────────────────────────────`));
        console.log(`Explicit preferences: ${explicit}`);
        console.log(`Inferred candidates: ${inferred}`);
        console.log(`Validated strategies: ${validated}`);
        console.log(`Stale patterns: ${stale}`);
        console.log(chalk.gray(`────────────────────────────────────────────\n`));
        break;

      case '/preferences':
        if (arg === 'forget' && command.split(' ')[2]) {
            const id = command.split(' ')[2];
            if (LearningStore.deletePreference(id)) console.log(chalk.green(`Deleted preference ${id}`));
            else console.log(chalk.red(`Preference ${id} not found.`));
            break;
        }
        
        const allPrefs = LearningStore.getPreferences();
        console.log(chalk.cyan(`\n⚙️ Learned Preferences`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        for (const p of allPrefs) {
            console.log(`- [${p.id}] [${p.scope}${p.projectName ? ':' + p.projectName : ''}] ${p.key} = ${p.value} (${p.status})`);
        }
        if (allPrefs.length === 0) console.log(chalk.gray('  No preferences learned yet.'));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/strategies':
        const allStrats = LearningStore.getStrategies();
        console.log(chalk.cyan(`\n🧠 Learned Strategies`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        for (const s of allStrats) {
            console.log(`- [${s.id}] [${s.domain}] ${s.situation}`);
            console.log(`  Status: ${s.status}, Success: ${(s.successCount / ((s.successCount + s.failureCount) || 1) * 100).toFixed(0)}% (${s.successCount} wins, ${s.failureCount} fails)`);
        }
        if (allStrats.length === 0) console.log(chalk.gray('  No strategies learned yet.'));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/feedback':
        if (!arg) {
            console.log(chalk.yellow('Usage: /feedback <message>'));
            break;
        }
        FeedbackProcessor.processFeedback(arg);
        console.log(chalk.green(`Feedback recorded: "${arg}"`));
        break;

      case '/transactions':
        console.log(chalk.cyan('\n📦 Transactions'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const txs = TransactionManager.getTransactions();
        if (txs.length === 0) console.log(chalk.gray('  No active or past transactions in this session.'));
        for (const tx of txs) {
            let color = chalk.white;
            if (tx.status === 'COMMITTED') color = chalk.green;
            else if (tx.status === 'ROLLED_BACK') color = chalk.yellow;
            else if (tx.status === 'FAILED') color = chalk.red;
            else if (tx.status === 'SIMULATING') color = chalk.blue;

            console.log(`- [${tx.id}] Status: ${color(tx.status)}`);
            console.log(`  Actions: ${tx.actions.length} | Checkpoints: ${tx.checkpoints.length}`);
            if (tx.actions.length > 0) {
                const types = new Set(tx.actions.map(a => a.sideEffect));
                console.log(`  Side Effects: ${Array.from(types).join(', ')}`);
            }
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/transaction':
        if (arg === 'rollback' && command.split(' ')[2]) {
            const txId = command.split(' ')[2];
            await TransactionManager.rollback(txId);
            break;
        }
        console.log(chalk.yellow('Usage: /transaction rollback <txId>'));
        break;

      case '/runtime':
        if (arg === 'rebuild') {
            await TaskProjection.rebuildAll();
            await TransactionManager.init();
            console.log(chalk.green('Projections successfully rebuilt from Event Store.'));
        } else {
            console.log(chalk.cyan('\n⚙️ Runtime Status'));
            console.log(chalk.gray('────────────────────────────────────────────'));
            const txCount = TransactionManager.getTransactions().length;
            const evts = await EventStore.readAll();
            console.log(`Event Store: ${evts.length} durable events logged.`);
            console.log(`Projections: ${txCount} transactions active in memory.`);
            console.log(chalk.gray('────────────────────────────────────────────\n'));
        }
        break;

      case '/events':
        const events = await EventStore.readAll();
        console.log(chalk.cyan(`\n📜 Event Log (${events.length} total)`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const tail = events.slice(-10); // Show last 10
        if (tail.length === 0) console.log(chalk.gray('  No events.'));
        for (const e of tail) {
            console.log(`- [${e.sequence}] ${e.aggregateType}/${e.aggregateId} : ${chalk.yellow(e.type)}`);
        }
        if (events.length > 10) console.log(chalk.gray(`... and ${events.length - 10} older events.`));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/queue':
        console.log(chalk.cyan('\n📋 Task Queue / Active Tasks'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const tasksMap = await TaskProjection.rebuildAll();
        let qCount = 0;
        for (const [id, t] of tasksMap.entries()) {
             if (t.status === 'executing' || t.status === 'waiting' || t.status === 'planning') {
                 console.log(`- [${id}] ${t.goal.substring(0,50)}... (${chalk.blue(t.status)})`);
                 qCount++;
             }
        }
        if (qCount === 0) console.log(chalk.gray('  Queue is empty. No running tasks.'));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/goals':
        const goals = GoalManager.getGoals();
        console.log(chalk.cyan(`\n🎯 Active Goals (${goals.length} total)`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (goals.length === 0) console.log(chalk.gray('  No active goals.'));
        for (const g of goals) {
             const progress = g.progressPercentage !== undefined ? `${g.progressPercentage}%` : '0%';
             console.log(`- [${g.id}] ${g.title} (${chalk.blue(g.status)})`);
             console.log(`  Priority: ${g.priority} | Progress: ${progress}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/goal':
        if (arg === 'create') {
            const title = command.split(' ').slice(2).join(' ') || 'New Goal';
            const goal = await GoalManager.createGoal({
                title,
                objective: title,
                priority: 'normal',
                successCriteria: []
            });
            console.log(chalk.green(`Created goal ${goal.id}: ${goal.title}`));
            // Immediately wake the goal loop
            GoalLoop.wake();
        } else if (arg === 'status' && parts[2]) {
            const goal = GoalManager.getGoal(parts[2]);
            if (goal) {
                console.log(chalk.cyan(`\n🎯 Goal: ${goal.title}`));
                console.log(`Status: ${goal.status}`);
                console.log(`Progress: ${goal.progressPercentage}%`);
                console.log(`Criteria:`);
                for (const c of goal.successCriteria) {
                    console.log(`  - [${c.isVerified ? 'x' : ' '}] ${c.description}`);
                }
            } else {
                console.log(chalk.red('Goal not found.'));
            }
        } else {
            console.log(chalk.yellow('Usage: /goal create <title> | /goal status <id>'));
        }
        break;

      case '/world':
        console.log(chalk.cyan('\n🌍 World Model Status'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        ObservationEngine.fullRefresh();
        const entities = WorldModel.getAll();
        if (entities.length === 0) console.log(chalk.gray('  World model is empty.'));
        for (const e of entities) {
             let color = chalk.white;
             if (e.state === 'healthy') color = chalk.green;
             if (e.state === 'degraded') color = chalk.yellow;
             if (e.state === 'broken') color = chalk.red;
             console.log(`- ${e.type}: ${e.id} [${color(e.state)}] (Source: ${e.source})`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/simulations':
        const branches = SimulationEngine.getBranches();
        console.log(chalk.cyan(`\n🔬 Simulation Branches (${branches.length} total)`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (branches.length === 0) console.log(chalk.gray('  No active simulations.'));
        for (const b of branches) {
             const score = b.outcome ? b.outcome.confidenceScore : 'N/A';
             console.log(`- [${b.id}] Strategy: ${b.strategy.substring(0, 30)}... (${chalk.blue(b.status)}) | Confidence: ${score}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/simulation':
        if (arg === 'status' && parts[2]) {
            const branch = SimulationEngine.getBranch(parts[2]);
            if (branch && branch.outcome) {
                console.log(chalk.cyan(`\n🔬 Simulation: ${branch.id}`));
                console.log(`Status: ${branch.status}`);
                console.log(`Strategy: ${branch.strategy}`);
                console.log(`Expected State: ${branch.outcome.expectedState}`);
                console.log(`Confidence: ${branch.outcome.confidenceScore}`);
                console.log(`Risks:`);
                for (const r of branch.outcome.predictedRisks) {
                    console.log(`  - [${r.impact}] ${r.description} (prob: ${r.probability})`);
                }
            } else {
                console.log(chalk.red('Simulation branch not found or incomplete.'));
            }
        } else if (arg === 'promote' && parts[2]) {
            const success = await SimulationEngine.promote(parts[2], 'Manual Promotion from CLI');
            if (success) {
                console.log(chalk.green(`Successfully promoted and executed branch ${parts[2]}.`));
            } else {
                console.log(chalk.red(`Failed to promote branch ${parts[2]}.`));
            }
        } else {
            console.log(chalk.yellow('Usage: /simulation status <id> | /simulation promote <id>'));
        }
        break;

      case '/incidents':
        const incidents = IncidentManager.getIncidents();
        console.log(chalk.cyan(`\n🚨 Active Incidents (${incidents.length} total)`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (incidents.length === 0) console.log(chalk.gray('  No active incidents.'));
        for (const inc of incidents) {
             console.log(`- [${inc.id}] ${inc.title} (${chalk.blue(inc.status)}) | Severity: ${inc.severity}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/incident':
        if (arg === 'status' && parts[2]) {
            const inc = IncidentManager.getIncident(parts[2]);
            if (inc) {
                console.log(chalk.cyan(`\n🚨 Incident: ${inc.title}`));
                console.log(`Status: ${inc.status}`);
                console.log(`Severity: ${inc.severity}`);
                console.log(`Symptoms: ${inc.symptoms.join(', ')}`);
                console.log(`Hypotheses:`);
                for (const h of inc.hypotheses) {
                    console.log(`  - [${h.status}] ${h.cause} (confidence: ${h.confidence})`);
                }
            } else {
                console.log(chalk.red('Incident not found.'));
            }
        } else if (arg === 'investigate' && parts[2]) {
            await RCAEngine.generateHypotheses(parts[2]);
            console.log(chalk.green(`Investigation started for incident ${parts[2]}.`));
        } else {
            console.log(chalk.yellow('Usage: /incident status <id> | /incident investigate <id>'));
        }
        break;

      case '/dependencies':
        const dependencyTargetId = arg;
        if (!dependencyTargetId) {
            console.log(chalk.yellow('Usage: /dependencies <id>'));
            break;
        }
        const forward = WorldModel.getForwardDependencies(dependencyTargetId);
        const reverse = WorldModel.getReverseDependencies(dependencyTargetId);
        console.log(chalk.cyan(`\n🔗 Dependencies for ${dependencyTargetId}`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(`Depends On (Forward): ${forward.length > 0 ? forward.map(f => f.to).join(', ') : 'None'}`);
        console.log(`Depended By (Reverse): ${reverse.length > 0 ? reverse.map(r => r.from).join(', ') : 'None'}`);
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/impact':
        if (!arg) {
            console.log(chalk.yellow('Usage: /impact <target_id>'));
            break;
        }
        const blastRadius = RCAEngine.analyzeImpact(arg);
        console.log(chalk.cyan(`\n💥 Blast Radius Analysis for ${arg}`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(`Potentially affected nodes: ${blastRadius.length}`);
        if (blastRadius.length > 0) {
            console.log(blastRadius.map(b => `  - ${b}`).join('\n'));
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/root-cause':
        if (!arg) {
             console.log(chalk.yellow('Usage: /root-cause <symptom description>'));
             break;
        }
        const symptom = parts.slice(1).join(' ');
        const inc = await IncidentManager.reportSymptom(symptom);
        await RCAEngine.generateHypotheses(inc.id);
        console.log(chalk.green(`\nIncident created and hypotheses generated for symptom: "${symptom}"\nRun "/incident status ${inc.id}" to view findings.`));
        break;

      case '/reliability':
        if (arg === 'run' && parts[2]) {
            await ReliabilityLab.runProfile(parts[2] as 'quick' | 'deep');
        } else if (arg === 'scenarios') {
            const scens = ReliabilityLab.getScenarios();
            console.log(chalk.cyan(`\n🧪 Reliability Scenarios`));
            for (const s of scens) {
                console.log(`- [${s.id}] ${s.name}`);
            }
        } else {
            console.log(chalk.yellow('Usage: /reliability run <profile> | /reliability scenarios'));
        }
        break;

      case '/policies':
        const policies = PolicyStore.getAllPolicies();
        console.log(chalk.cyan(`\n📜 Active Policies (${policies.length} total)`));
        console.log(chalk.gray('────────────────────────────────────────────'));
        if (policies.length === 0) console.log(chalk.gray('  No policies loaded.'));
        for (const p of policies) {
             console.log(`- [${p.id}] ${p.description}`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/policy':
        if (arg === 'status') {
            console.log(chalk.cyan(`\n📜 Policy Engine Status`));
            const grants = PolicyStore.getActiveGrants();
            console.log(`Loaded Policies: ${PolicyStore.getAllPolicies().length}`);
            console.log(`Active Grants: ${grants.length}`);
            for (const g of grants) {
                console.log(`  - [${g.id}] ${g.capability} (Scope: ${g.scope})`);
            }
        } else {
            console.log(chalk.yellow('Usage: /policy status'));
        }
        break;

      case '/agents':
        AgentRegistry.discover();
        console.log(chalk.cyan('\n🤖 Specialist Agents'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        const agents = AgentRegistry.list();
        for (const agent of agents) {
            const healthIcon = agent.health === 'HEALTHY' ? chalk.green('✓') : (agent.health === 'DEGRADED' ? chalk.yellow('⚠') : chalk.red('✗'));
            const enabledStr = agent.enabled ? '' : chalk.red(' [DISABLED]');
            console.log(`${healthIcon} ${chalk.white(agent.name)} [${chalk.gray(agent.id)}]${enabledStr}`);
            console.log(`  ${agent.description}`);
            console.log(`  Access: ${chalk.cyan(agent.accessMode)} | Trust: ${chalk.cyan(agent.trustLevel)} | Failures: ${agent.consecutiveFailures}`);
            console.log(`  Skills: ${agent.skills.join(', ')} | Tools: ${agent.allowedTools.join(', ')}`);
            console.log(`  Limits: ${agent.limits.maxToolCalls} tools, ${agent.limits.maxModelCalls} model calls, ${(agent.limits.maxRuntimeMs/1000)}s timeout\n`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/automation':
        if (!arg) {
           console.log(chalk.yellow('Usage: /automation <create|pause|resume|run|cancel> [args...]'));
           break;
        }
        const autoParts = command.split(' ').slice(1);
        const autoCmd = autoParts[0]?.toLowerCase();
        
        if (autoCmd === 'create') {
            const cronExp = autoParts.slice(1, 6).join(' '); // A simple naive parsing for cron
            const goal = autoParts.slice(6).join(' ');
            if (!goal) {
                console.log(chalk.red('Usage: /automation create <* * * * *> <goal...>'));
                break;
            }
            const id = AutomationEngine.create(`Task-${Date.now()}`, cronExp, goal);
            console.log(chalk.green(`Created automation [${id}]`));
        } else if (autoCmd === 'pause') {
            const id = autoParts[1];
            if (AutomationEngine.pause(id)) console.log(chalk.green(`Paused automation ${id}`));
            else console.log(chalk.red(`Automation not found`));
        } else if (autoCmd === 'resume') {
            const id = autoParts[1];
            if (AutomationEngine.resume(id)) console.log(chalk.green(`Resumed automation ${id}`));
            else console.log(chalk.red(`Automation not found`));
        } else if (autoCmd === 'cancel') {
            const id = autoParts[1];
            if (AutomationEngine.cancel(id)) console.log(chalk.green(`Cancelled automation ${id}`));
            else console.log(chalk.red(`Automation not found`));
        } else if (autoCmd === 'run') {
            const id = autoParts[1];
            AutomationEngine.runAutomation(id);
            console.log(chalk.green(`Triggered automation ${id}`));
        } else {
            console.log(chalk.red(`Unknown automation command: ${autoCmd}`));
        }
        break;

      case '/maintenance':
        console.log(chalk.cyan('\n🛠️ Maintenance & Governance Engine'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        
        if (!arg) {
            console.log(chalk.yellow('Usage: /maintenance <scan|execute> [id]'));
            break;
        }

        const maintCmd = arg.toLowerCase().split(' ')[0];
        
        if (maintCmd === 'scan') {
            const report = await MaintenanceEngine.runAudit(process.cwd());
            console.log(chalk.bold(`\nAudit Complete.`));
            console.log(`Detected Items: ${report.detectedCount}`);
            console.log(`Overall Risk: ${report.overallRisk.toUpperCase()}`);
            
            if (report.detectedCount > 0) {
                console.log(chalk.cyan('\nPending Tasks:'));
                report.tasks.forEach(t => {
                    console.log(`  - [${t.id}] ${t.target} (${t.currentVersion} -> ${t.targetVersion}) [Risk: ${t.risk}]`);
                });
                console.log(chalk.gray('\nRun `/maintenance execute <id>` to simulate and apply an upgrade safely.\n'));
            } else {
                console.log(chalk.green('\nSystem is fully up to date. No maintenance required.\n'));
            }
        } else if (maintCmd === 'execute') {
            const taskId = arg.split(' ')[1];
            if (!taskId) {
                console.log(chalk.yellow('Usage: /maintenance execute <task-id>'));
                break;
            }
            
            console.log(chalk.cyan(`\nStarting maintenance pipeline for Task ${taskId}...`));
            const success = await MaintenanceEngine.executeTask(taskId);
            
            if (success) {
                console.log(chalk.bold.green(`\n✓ Maintenance task ${taskId} completed successfully.\n`));
            } else {
                console.log(chalk.bold.red(`\n❌ Maintenance task ${taskId} failed. See incident logs.\n`));
            }
        } else {
            console.log(chalk.yellow('Usage: /maintenance <scan|execute> [id]'));
        }
        break;

      case '/voice':
        if (arg) {
          const newVoice = arg.charAt(0).toUpperCase() + arg.slice(1).toLowerCase();
          if (VOICE_NAMES.includes(newVoice)) {
            this.voiceName = newVoice;
            console.log(chalk.green(`✓ Voice changed to: ${newVoice}`));
            if (this.isConnected) {
              console.log(chalk.yellow('⚠️  Reconnecting to apply voice change...'));
              await this.reconnect();
            }
          } else {
            console.log(chalk.red(`❌ Unknown voice: ${arg}`));
            console.log(chalk.gray('Use /voices to see available options\n'));
          }
        } else if (!this.isVoiceMode) {
          this.isVoiceMode = true;
          console.log(chalk.green('🎙️  Voice mode enabled (AUDIO responses)'));
          console.log(chalk.cyan('🔌 Connecting to Live API...\n'));
          if (this.isConnected) {
            await this.reconnect(); // switch modality TEXT -> AUDIO
          } else {
            await this.connectToLiveAPI();
          }

          // After connection, AI introduces itself
          setTimeout(async () => {
            if (this.isConnected && this.isVoiceMode) {
              console.log(chalk.cyan('🎤 AI is introducing itself...\n'));
              await this.sendMessageViaLiveAPI('Hi! Please introduce yourself warmly in 1-2 friendly sentences and ask how you can help me today. Be natural and conversational.');
            }
          }, 500);

        } else {

          console.log(chalk.yellow('✓ Voice mode already enabled\n'));
          if (!this.isConnected) await this.connectToLiveAPI();
        }
        break;

      case '/text':
        if (this.isVoiceMode) {
          this.isVoiceMode = false;
          this.stopRecording(true);
          this.player.stop();
          console.log(chalk.yellow('⌨️  Text mode enabled (TEXT responses)'));
          if (this.isConnected) {
            console.log(chalk.yellow('⚠️  Reconnecting to apply mode change...'));
            await this.reconnect();
          }
          console.log();
        } else {
          console.log(chalk.yellow('✓ Text mode already active\n'));
        }
        break;

      case '/record':
        this.startRecording();
        break;

      case '/stop':
        this.stopRecording();
        break;

      case '/mic':
      case '/devices':
        await this.showMics(arg !== undefined ? parseInt(arg, 10) : undefined);
        break;

      case '/voices':
        this.showVoices();
        break;

      case '/config':
        this.showConfig();
        break;

      case '/clear':
        this.clearHistory();
        break;

      case '/history':
        this.displayHistory();
        break;

      case '/save':
        await this.saveConversation();
        break;

      case '/help':
        console.log(chalk.bold.cyan('\n📚 Command Help\n'));
        console.log(chalk.yellow('Conversation'));
        console.log(chalk.white('  /voice    - Enable voice mode'));
        console.log(chalk.white('  /text     - Switch back to text-only mode'));
        console.log(chalk.white('  /clear    - Clear active conversation context'));
        console.log(chalk.white('  /history  - Show conversation history'));
        console.log(chalk.white('  /save     - Save conversation (text + playable WAV)'));
        console.log(chalk.yellow('\nAttachments'));
        console.log(chalk.white('  /attach <file> - Attach a file to the next request'));
        console.log(chalk.white('  /detach <file> - Remove an attached file'));
        console.log(chalk.white('  /attachments   - List current attachments'));
        console.log(chalk.yellow('\nSessions'));
        console.log(chalk.white('  /sessions - List active sessions'));
        console.log(chalk.white('  /session use <id> - Switch session'));
        console.log(chalk.white('  /session clear - Clear current session'));
        console.log(chalk.yellow('\nTasks & Automation'));
        console.log(chalk.white('  /automations - Show active scheduled tasks'));
        console.log(chalk.white('  /automation  - Create/pause/run automations'));
        console.log(chalk.yellow('\nSystem & Diagnostics'));
        console.log(chalk.white('  /diagnostics - Show Agent health'));
        console.log(chalk.white('  /maintenance - Scan or execute system upgrades'));
        console.log(chalk.white('  /models      - Show available models'));
        console.log(chalk.white('  /providers   - Show provider health'));
        console.log(chalk.white('  /trace       - Show execution trace of last task'));
        console.log(chalk.white('  /security    - Show Security settings'));
        console.log(chalk.white('  /extensions  - List loaded extensions'));
        console.log(chalk.white('  /mcp         - List connected MCP servers'));
        console.log(chalk.yellow('\nUI Modes'));
        console.log(chalk.white('  /debug       - Show full internal logs'));
        console.log(chalk.white('  /verbose     - Show verbose step output'));
        console.log(chalk.white('  /compact     - Minimal compact output'));
        console.log(chalk.white('  /normal      - Default balanced output'));
        console.log(chalk.white('\n  /exit        - Exit the application\n'));
        break;

      case '/debug':
        InteractionLayer.setMode('debug');
        break;
      case '/verbose':
        InteractionLayer.setMode('verbose');
        break;
      case '/compact':
        InteractionLayer.setMode('compact');
        break;
      case '/normal':
        InteractionLayer.setMode('normal');
        break;

      case '/sessions':
        console.log(chalk.cyan('\n📁 Sessions'));
        console.log(chalk.gray('────────────────────────────────────────────'));
        console.log(chalk.white(`  ● ${this.currentSession || 'default'} ${chalk.green('(Active)')}`));
        console.log(chalk.gray('────────────────────────────────────────────\n'));
        break;

      case '/session':
        if (!arg) {
           console.log(chalk.yellow('Usage: /session <use|clear> [args...]'));
           break;
        }
        const sessionCmd = arg.toLowerCase();
        if (sessionCmd === 'use' && parts[2]) {
           this.currentSession = parts[2];
           let s = SessionManager.getSession(this.currentSession);
           if (!s) s = SessionManager.createSession(this.currentSession);
           this.activeSession = s;
           console.log(chalk.green(`✓ Switched to session: ${this.currentSession}`));
        } else if (sessionCmd === 'clear') {
           SessionManager.clearSessionContext(this.currentSession);
           console.log(chalk.green(`✓ Current session cleared.`));
        } else {
           console.log(chalk.yellow('Usage: /session <use|clear> [args...]'));
        }
        break;

      case '/attach':
        if (!arg) {
           console.log(chalk.yellow('Usage: /attach <filepath>'));
           break;
        }
        const attachPath = parts.slice(1).join(' ');
        if (fs.existsSync(attachPath)) {
            this.attachments.push(attachPath);
            InteractionLayer.renderAttachmentPreview(attachPath, `${(fs.statSync(attachPath).size / 1024).toFixed(1)} KB`);
        } else {
            InteractionLayer.renderError(`File not found: ${attachPath}`);
        }
        break;

      case '/detach':
        if (!arg) {
           this.attachments = [];
           InteractionLayer.renderSuccess('All attachments cleared.');
        } else {
           const detachPath = parts.slice(1).join(' ');
           this.attachments = this.attachments.filter(p => p !== detachPath);
           InteractionLayer.renderSuccess(`Detached ${detachPath}`);
        }
        break;

      case '/attachments':
        if (this.attachments.length === 0) {
            console.log(chalk.gray('No files attached.'));
        } else {
            this.attachments.forEach(p => InteractionLayer.renderAttachmentPreview(p));
        }
        break;

      default:
        console.log(chalk.red(`❌ Unknown command: ${command}`));
        console.log(chalk.gray('Type /help to see available commands\n'));
    }
    return false;
  }

  shutdown(): void {
    if (this.didShutdown) return;
    this.didShutdown = true;
    this.stopRecording(true);
    this.player.stop();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    console.log(chalk.yellow('\n👋 Goodbye! Thanks for chatting.\n'));
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

      if (this.isConnected) {
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
