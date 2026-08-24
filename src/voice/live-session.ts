import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import screenshot from 'screenshot-desktop';
import { AudioPlayer, MicRecorder, detectTools, listInputDevices, pcmToWav, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, logToJSON } from '../audio.js';
import type { AudioTools } from '../audio.js';
import { ToolRegistry, ToolExecutor } from '../tools.js';
import { getSystemInstruction } from '../context.js';

export const MODEL_LIVE = process.env.MODEL_LIVE || 'models/gemini-3.1-flash-live-preview';
export const MODEL_TEXT = process.env.MODEL_TEXT || 'gemini-2.0-flash-lite';

const LIVE_API_URL = `wss://generativelanguage.googleapis.com/ws/v1alpha/internal?key=${process.env.GEMINI_API_KEY}`;

export const VOICE_NAMES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];

/** Convert a ws message payload (Buffer | ArrayBuffer | Buffer[]) to a string. */
export function messageToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Audio state machine states (deterministic transitions only). */
export enum VoiceState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  THINKING = 'THINKING',
  SPEAKING = 'SPEAKING',
  INTERRUPTING = 'INTERRUPTING',
  PROCESSING_USER = 'PROCESSING_USER',
  ERROR = 'ERROR',
}

/** Everything the live session needs from the host application. */
export interface VoiceHost {
  getChatHistory(): any[];
  setChatHistory(messages: any[]): void;
  isVoiceMode(): boolean;
  /** Called when the Live socket opens (session label refresh). */
  onConnected?(): void;
}

/**
 * Owns the Gemini Live WebSocket connection, microphone capture, playback,
 * screen-share and per-turn transcript accumulators.
 */
export class LiveSessionController {
  private ws: WebSocket | null = null;
  private connected = false;

  private audioBuffer: Buffer[] = [];
  private tools: AudioTools = { ffmpeg: false, ffplay: false };
  private player = new AudioPlayer();
  private recorder: MicRecorder | null = null;
  private micDevice = '';
  private micDevices: string[] = [];

  // Per-turn accumulators (model streams audio + transcripts)
  private modelTranscript = '';
  private userTranscript = '';
  private turnAudioBytes = 0;

  private recording = false;
  private screenInterval: NodeJS.Timeout | null = null;

  private currentVoice = process.env.VOICE_NAME || 'Puck';

  /** Current coarse-grained audio state. */
  private state: VoiceState = VoiceState.IDLE;

  constructor(private host: VoiceHost) {}

  // ----- State accessors -----

  get isConnected(): boolean {
    return this.connected;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get voiceName(): string {
    return this.currentVoice;
  }

  set voiceName(name: string) {
    this.currentVoice = name;
  }

  get currentMicDevice(): string {
    return this.micDevice;
  }

  get micList(): string[] {
    return this.micDevices;
  }

  get ffmpegAvailable(): boolean {
    return this.tools.ffmpeg;
  }

  get playbackAvailable(): boolean {
    return this.tools.ffplay;
  }

  get audioBufferLength(): number {
    return this.audioBuffer.length;
  }

  getState(): VoiceState {
    return this.state;
  }

  private setState(next: VoiceState): void {
    this.state = next;
  }

  // ----- Lifecycle -----

  /** Detect ffmpeg/ffplay and enumerate microphones. */
  async initAudio(): Promise<void> {
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

  canPlay(): boolean {
    return this.tools.ffplay;
  }

  /** Stop audio playback immediately (used on barge-in and /text). */
  stopPlayback(): void {
    this.player.stop();
  }

  canRecord(): boolean {
    return this.tools.ffmpeg && !!this.micDevice;
  }

  shutdownAudio(): void {
    this.stopRecording(true);
    this.player.stop();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
    this.setState(VoiceState.IDLE);
  }

  // ----- Connection -----

  private buildSetupMessage(): object {
    return {
      setup: {
        model: MODEL_LIVE,
        generationConfig: {
          responseModalities: [this.host.isVoiceMode() ? 'AUDIO' : 'TEXT'],
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
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
  }

  async connectToLiveAPI(): Promise<boolean> {
    if (this.connected) {
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
          this.connected = true;
          this.host.onConnected?.();
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
          void this.handleLiveAPIResponse(response, spinner, done);
        });

        this.ws.on('error', (error) => {
          spinner.fail(chalk.red('❌ Connection error'));
          console.error(chalk.red('WebSocket error:'), error.message);
          this.connected = false;
          this.setState(VoiceState.ERROR);
          done(false);
        });

        this.ws.on('close', (code, reason) => {
          spinner.stop();
          const detail = reason?.toString().trim();
          console.log(
            chalk.yellow(`\n🔌 Disconnected from Live API (code ${code}${detail ? `: ${detail}` : ''})`)
          );
          this.connected = false;
          this.ws = null;
          this.stopRecording(true);
          this.player.stop();
          this.setState(VoiceState.IDLE);
          done(false);
        });
      } catch (error: any) {
        spinner.fail(chalk.red('❌ Failed to connect'));
        console.error(chalk.red('Error:'), error.message);
        done(false);
      }
    });
  }

  async reconnect(): Promise<void> {
    if (this.ws) {
      this.stopRecording(true);
      this.player.stop();
      const old = this.ws;
      this.connected = false;
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

  /** Send raw JSON over the live socket when open. */
  sendJson(payload: object): void {
    if (this.isOpen) {
      this.ws!.send(JSON.stringify(payload));
    }
  }

  // ----- Inbound message dispatch -----

  async handleLiveAPIResponse(
    response: any,
    spinner?: any,
    resolveConnection?: (value: boolean) => void
  ): Promise<void> {
    // Setup complete
    if (response.setupComplete) {
      spinner?.succeed(chalk.green('✅ Connected to Gemini Flash Live Preview!'));
      console.log(chalk.green(`✓ Mode: ${this.host.isVoiceMode() ? 'AUDIO (voice)' : 'TEXT'}`));
      console.log(chalk.green(`✓ Voice Name: ${this.voiceName}`));
      console.log(chalk.green('✓ Ready for real-time conversation!\n'));
      if (this.host.isVoiceMode()) {
        if (this.canRecord()) {
          console.log(chalk.cyan('🎤 Continuous listening is ON. Start speaking anytime.'));
          this.startRecording();
        } else {
          console.log(chalk.yellow('🎤 Mic capture unavailable — type a message and the AI replies with voice.'));
        }
        console.log(chalk.gray('   You can also just type text; responses are spoken aloud.\n'));
      }
      console.log(chalk.gray('─'.repeat(60)) + '\n');
      this.setState(this.host.isVoiceMode() ? VoiceState.LISTENING : VoiceState.IDLE);
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

      if (sc.inputTranscription?.text) {
        this.userTranscript += sc.inputTranscription.text;
        this.setState(VoiceState.PROCESSING_USER);
      }
      if (sc.outputTranscription?.text) {
        this.modelTranscript += sc.outputTranscription.text;
        this.setState(VoiceState.SPEAKING);
      }

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

      // Barge-in / interruption: stop playing stale audio immediately.
      if (sc.interrupted) {
        this.handleBargeIn();
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

      if (functionResponses.length > 0 && this.isOpen) {
        this.ws!.send(JSON.stringify({
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

  /**
   * Barge-in: the server confirmed the user interrupted the model.
   * Stop playback instantly so the user is heard over Rose, flush partial
   * model transcript so nothing is lost, and return to LISTENING.
   */
  handleBargeIn(): void {
    if (this.state === VoiceState.SPEAKING || this.state === VoiceState.THINKING) {
      this.setState(VoiceState.INTERRUPTING);
    }
    this.player.stop(); // kill stale playback immediately
    if (this.modelTranscript.trim()) {
      // Keep whatever partial output arrived before interruption.
      this.finalizeTurn();
    }
    console.log(chalk.yellow('\n⚠️  Response interrupted — listening…'));
    this.setState(VoiceState.LISTENING);
  }

  /** Flush transcripts to history and print a tidy summary at end of a turn. */
  finalizeTurn(): void {
    const userText = this.userTranscript.trim();
    const modelText = this.modelTranscript.trim();
    const history = this.host.getChatHistory();

    if (userText) {
      // Replace the placeholder we pushed when recording started, if present.
      const last = history[history.length - 1];
      if (last && last.role === 'user' && last.parts[0]?.text === '[voice input]') {
        last.parts[0].text = userText;
      } else {
        history.push({ role: 'user', parts: [{ text: userText }] });
      }
      console.log(chalk.blue('\n🗣️  You (voice): ') + chalk.white(userText));
    }

    if (modelText) {
      history.push({ role: 'model', parts: [{ text: modelText }] });
      if (this.host.isVoiceMode()) {
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
    this.setState(this.host.isVoiceMode() && this.recording ? VoiceState.LISTENING : VoiceState.IDLE);
  }

  // ----- Microphone / screen capture -----

  startRecording(): void {
    if (!this.connected) {
      console.log(chalk.yellow('⚠️  Not connected. Use /voice first.\n'));
      return;
    }
    if (!this.canRecord()) {
      console.log(chalk.yellow('⚠️  Microphone capture unavailable (ffmpeg or input device missing).'));
      console.log(chalk.gray('   Type your message instead — the AI will still reply with voice.\n'));
      return;
    }
    if (this.recording) {
      return;
    }

    this.recording = true;
    this.userTranscript = '';

    if (process.env.ENABLE_SCREEN_SHARE === 'true') {
      const intervalMs = parseInt(process.env.SCREEN_CAPTURE_INTERVAL_MS || '2000', 10);
      this.screenInterval = setInterval(() => void this.sendScreenCapture(), intervalMs);
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

    console.log(chalk.red(`\n🔴 MIC ACTIVE ("${this.micDevice}"). AI will respond automatically.`));
    this.setState(VoiceState.LISTENING);
  }

  stopRecording(silent = false): void {
    if (this.screenInterval) {
      clearInterval(this.screenInterval);
      this.screenInterval = null;
    }
    if (!this.recording && !this.recorder) return;
    this.recording = false;
    this.recorder?.stop();
    this.recorder = null;
    if (!silent) {
      console.log(chalk.yellow('⏹️  Recording stopped — waiting for the AI to respond...\n'));
    }
  }

  async sendScreenCapture(): Promise<void> {
    if (!this.connected || !this.isOpen) return;
    try {
      const imgBuffer = await screenshot({ format: 'jpg' });
      this.sendJson({
        realtimeInput: {
          video: {
            mimeType: 'image/jpeg',
            data: imgBuffer.toString('base64'),
          }
        },
      });
    } catch (err: any) {
      logToJSON('screen_capture_error', err.message);
    }
  }

  sendRealtimeAudio(chunk: Buffer): void {
    if (!this.connected || !this.isOpen) return;
    this.sendJson({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          data: chunk.toString('base64'),
        },
      },
    });
  }

  // ----- Export / device UI -----

  getAudioBuffer(): Buffer[] {
    return this.audioBuffer;
  }

  clearAudioBuffer(): void {
    this.audioBuffer = [];
  }

  async saveConversation(sessionLabel: string, history: any[], voiceModeEnabled: boolean): Promise<void> {
    const spinner = ora({ text: chalk.cyan('💾 Saving conversation...'), discardStdin: false }).start();
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = path.join(process.cwd(), 'conversations');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const textFile = path.join(outputDir, `conversation_${timestamp}.txt`);
      let textContent = `Gemini Flash Live - Conversation\n`;
      textContent += `Session: ${sessionLabel}\n`;
      textContent += `Date: ${new Date().toLocaleString()}\n`;
      textContent += `Voice Mode: ${voiceModeEnabled ? 'Enabled' : 'Disabled'}\n`;
      textContent += `Messages: ${history.length}\n`;
      textContent += `\n${'='.repeat(60)}\n\n`;
      history.forEach((msg: any, index: number) => {
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

  showVoices(currentVoice: string): void {
    console.log(chalk.bold.magenta('\n🎤 Available Voices:\n'));
    const voices = [
      { name: 'Puck', desc: 'Default voice, friendly and natural' },
      { name: 'Charon', desc: 'Deep and authoritative' },
      { name: 'Kore', desc: 'Warm and expressive' },
      { name: 'Fenrir', desc: 'Strong and confident' },
      { name: 'Aoede', desc: 'Melodic and pleasant' },
    ];
    voices.forEach((voice) => {
      const current = voice.name === currentVoice ? chalk.green(' (Current)') : '';
      console.log(`  ${chalk.cyan(voice.name)}${current} - ${chalk.gray(voice.desc)}`);
    });
    console.log(chalk.gray('\n  To change voice, use: /voice <name>   (e.g. /voice Charon)\n'));
  }

  async showMics(selectIndex?: number): Promise<void> {
    if (!this.tools.ffmpeg) {
      console.log(chalk.yellow('\n⚠️  ffmpeg not available — cannot list microphones.\n'));
      return;
    }
    if (this.micDevices.length === 0) this.micDevices = await listInputDevices();

    if (typeof selectIndex === 'number') {
      if (selectIndex >= 0 && selectIndex < this.micDevices.length) {
        this.micDevice = this.micDevices[selectIndex];
        console.log(chalk.green(`✓ Microphone set to: ${this.micDevice}\n`));
        if (this.recording) {
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
}
