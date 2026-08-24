// Audio I/O backend built on ffmpeg / ffplay (no native modules required).
//
// The Gemini Live API expects 16 kHz, 16-bit, mono PCM as input and returns
// 24 kHz, 16-bit, mono PCM as output. We capture the microphone with ffmpeg
// (dshow on Windows, avfoundation on macOS, alsa/pulse on Linux) and play the
// model's audio with ffplay by streaming raw PCM over stdin.

import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

export function logToJSON(component: string, message: string) {
  try {
    const logPath = 'C:\\Users\\alone\\OneDrive\\Desktop\\Rose\\logs.json';
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), component, message }) + '\n';
    fs.appendFileSync(logPath, entry);
  } catch (e) {}
}

const execFileP = promisify(execFile);

export const INPUT_SAMPLE_RATE = 16000; // Live API input requirement
export const OUTPUT_SAMPLE_RATE = 24000; // Live API output format

export interface AudioTools {
  ffmpeg: boolean;
  ffplay: boolean;
}

/** Returns whether ffmpeg and ffplay are available on the PATH. */
export async function detectTools(): Promise<AudioTools> {
  const check = async (bin: string): Promise<boolean> => {
    try {
      await execFileP(bin, ['-version']);
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffplay] = await Promise.all([check('ffmpeg'), check('ffplay')]);
  return { ffmpeg, ffplay };
}

/** The ffmpeg input format for the current platform. */
function inputFormat(): string {
  switch (process.platform) {
    case 'win32':
      return 'dshow';
    case 'darwin':
      return 'avfoundation';
    default:
      return 'alsa';
  }
}

/** Wrap a raw device name in the platform-specific ffmpeg `-i` argument. */
function inputArg(device: string): string {
  switch (process.platform) {
    case 'win32':
      return `audio=${device}`;
    case 'darwin':
      return `:${device}`; // audio-only device index for avfoundation
    default:
      return device; // alsa hw id, e.g. "default"
  }
}

/**
 * Enumerate audio input (microphone) devices. Currently only implemented for
 * Windows (dshow); other platforms return an empty list and the caller falls
 * back to the platform default device.
 */
export async function listInputDevices(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  // ffmpeg prints the device list to stderr and exits non-zero on purpose.
  const stderr = await execFileP('ffmpeg', [
    '-hide_banner',
    '-list_devices',
    'true',
    '-f',
    'dshow',
    '-i',
    'dummy',
  ])
    .then((r) => r.stderr)
    .catch((e: any) => (e && e.stderr) || '');

  const devices: string[] = [];
  const re = /"([^"]+)"\s+\(audio\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) devices.push(m[1]);
  return devices;
}

/** Streams microphone audio as 16 kHz/mono/16-bit PCM chunks. */
export class MicRecorder {
  private proc: ChildProcess | null = null;

  constructor(private readonly device: string) {}

  get active(): boolean {
    return this.proc !== null;
  }

  start(onChunk: (chunk: Buffer) => void, onError: (err: Error) => void): void {
    if (this.proc) return;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      inputFormat(),
      '-i',
      inputArg(this.device),
      '-ar',
      String(INPUT_SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => onChunk(d));
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) {
        logToJSON('ffmpeg_mic', text);
        // Only surface real errors if it contains typical failure words
        if (/cannot|not found|no such|error opening|ENOENT/i.test(text)) {
          onError(new Error(text));
        }
      }
    });
    proc.on('error', (e) => {
      logToJSON('ffmpeg_mic_error', e.message);
      onError(e);
    });
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }
}

/**
 * Plays 24 kHz/mono/16-bit PCM by streaming it into a persistent ffplay
 * process over stdin. The process stays alive across turns for gapless,
 * low-latency playback and is killed on interruption or shutdown.
 */
export class AudioPlayer {
  private proc: ChildProcess | null = null;

  private ensure(): void {
    if (this.proc) return;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nodisp',
      '-f',
      's16le',
      '-ar',
      String(OUTPUT_SAMPLE_RATE),
      '-ch_layout',
      'mono',
      '-i',
      'pipe:0',
    ];
    logToJSON('ffplay_spawn', 'Spawning ffplay with args: ' + args.join(' '));
    const proc = spawn('ffplay', args);
    this.proc = proc;
    proc.stderr?.on('data', (d) => logToJSON('ffplay_stderr', d.toString().trim()));
    proc.on('error', (e) => {
      logToJSON('ffplay_error', e.message);
      if (this.proc === proc) this.proc = null;
    });
    proc.on('close', (code) => {
      logToJSON('ffplay_close', `Exited with code ${code}`);
      if (this.proc === proc) this.proc = null;
    });
  }

  write(chunk: Buffer): void {
    this.ensure();
    try {
      this.proc?.stdin?.write(chunk);
    } catch {
      /* player exited; next write recreates it */
      this.proc = null;
    }
  }

  /** Immediately stop playback (barge-in / interruption / shutdown). */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }
}

/** Prepend a 44-byte WAV header to raw little-endian PCM so it is playable. */
export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
