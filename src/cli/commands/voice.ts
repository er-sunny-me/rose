import chalk from 'chalk';
import { VOICE_NAMES } from '../../voice/live-session.js';
import type { CliContext, CommandArgs } from '../context.js';

/** Voice commands: /voice /text /record /stop /mic /devices /voices */
export async function handleVoiceCommands(ctx: CliContext, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg } = args;
  const voice = ctx.voice;

  switch (cmd) {
    case '/voice':
      if (arg === 'stop' || arg === 'off') {
        // Explicit teardown: mic closed, playback stopped, socket released.
        ctx.setVoiceMode(false);
        voice.stopRecording(true);
        voice.stopPlayback();
        console.log(chalk.yellow('🔇 Voice session stopped. Back to text mode.'));
        break;
      }
      if (arg) {
        const newVoice = arg.charAt(0).toUpperCase() + arg.slice(1).toLowerCase();
        if (VOICE_NAMES.includes(newVoice)) {
          voice.voiceName = newVoice;
          console.log(chalk.green(`✓ Voice changed to: ${newVoice}`));
          if (voice.isConnected) {
            console.log(chalk.yellow('⚠️  Reconnecting to apply voice change...'));
            await voice.reconnect();
          }
        } else {
          console.log(chalk.red(`❌ Unknown voice: ${arg}`));
          console.log(chalk.gray('Use /voices to see available options\n'));
        }
      } else if (!ctx.isVoiceMode()) {
        ctx.setVoiceMode(true);
        console.log(chalk.green('🎙️  Voice mode enabled (AUDIO responses)'));
        console.log(chalk.cyan('🔌 Connecting to Live API...\n'));
        if (voice.isConnected) {
          await voice.reconnect(); // switch modality TEXT -> AUDIO
        } else {
          await voice.connectToLiveAPI();
        }

        // After connection, AI introduces itself
        setTimeout(async () => {
          if (voice.isConnected && ctx.isVoiceMode()) {
            console.log(chalk.cyan('🎤 AI is introducing itself...\n'));
            await ctx.sendLiveTurn('Hi! Please introduce yourself warmly in 1-2 friendly sentences and ask how you can help me today. Be natural and conversational.');
          }
        }, 500);

      } else {
        console.log(chalk.yellow('✓ Voice mode already enabled\n'));
        if (!voice.isConnected) await voice.connectToLiveAPI();
      }
      break;

    case '/text':
      if (ctx.isVoiceMode()) {
        ctx.setVoiceMode(false);
        voice.stopRecording(true);
        voice.stopPlayback();
        console.log(chalk.yellow('⌨️  Text mode enabled (TEXT responses)'));
        if (voice.isConnected) {
          console.log(chalk.yellow('⚠️  Reconnecting to apply mode change...'));
          await voice.reconnect();
        }
        console.log();
      } else {
        console.log(chalk.yellow('✓ Text mode already active\n'));
      }
      break;

    case '/record':
      voice.startRecording();
      break;

    case '/stop':
      voice.stopRecording();
      break;

    case '/mic':
    case '/devices':
      await voice.showMics(arg !== undefined ? parseInt(arg, 10) : undefined);
      break;

    case '/voices':
      voice.showVoices(voice.voiceName);
      break;

    default:
      return false;
  }
  return false;
}
