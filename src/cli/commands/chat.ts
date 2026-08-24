import chalk from 'chalk';
import fs from 'fs';
import { InteractionLayer } from '../../ux.js';
import { getSystemInstruction } from '../../context.js';
import type { CliContext, CommandArgs } from '../context.js';

/** Conversation/session/output commands: /exit /clear /history /save /config
 *  /help /debug /verbose /compact /normal /sessions /session /attach /detach
 *  /attachments /context */
export async function handleChatCommands(ctx: CliContext, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts } = args;

  switch (cmd) {
    case '/exit':
    case '/quit':
      ctx.shutdown();
      return true;

    case '/clear':
      ctx.setChatHistory([]);
      ctx.voice.clearAudioBuffer();
      console.log(chalk.green('✓ Chat history and audio buffer cleared\n'));
      break;

    case '/history': {
      const history = ctx.getChatHistory();
      console.log(chalk.bold.yellow('\n📜 Chat History:\n'));
      if (history.length === 0) {
        console.log(chalk.gray('  No messages yet.\n'));
        break;
      }
      history.forEach((msg: any, index: number) => {
        const role = msg.role === 'user' ? chalk.blue('👤 You') : chalk.green('🤖 AI');
        const text = msg.parts[0]?.text || '[Non-text content]';
        const preview = text.length > 80 ? text.substring(0, 80) + '...' : text;
        console.log(`${chalk.gray(`[${index + 1}]`)} ${role}: ${preview}`);
      });
      console.log();
      break;
    }

    case '/context':
      if (arg === 'stats') {
        const { stats } = await ctx.contextManager.buildContext({
          systemInstructions: getSystemInstruction(),
          activeSkills: '',
          memory: '',
          chatHistory: ctx.getChatHistory(),
          currentInput: ''
        });
        console.log(chalk.cyan(`\n📊 Context Stats:`));
        console.log(chalk.white(`Budget: ${stats.budget} tokens`));
        console.log(chalk.white(`Usage:  ${stats.usage} tokens (${stats.percent}%)`));
        console.log(chalk.gray(`Messages: ${ctx.getChatHistory().length}\n`));
      } else if (arg === 'compact') {
        console.log(chalk.yellow(`\nCompacting context...`));
        await ctx.contextManager.compactConversation(ctx.getChatHistory());
        const history = ctx.getChatHistory();
        ctx.setChatHistory(history.slice(Math.max(0, history.length - 2)));
        console.log(chalk.green(`✓ Conversation summarized.`));
        console.log(chalk.gray(`Messages reduced to ${ctx.getChatHistory().length}.\n`));
      } else {
        console.log(chalk.gray('Commands: /context stats, /context compact'));
      }
      break;

    case '/save':
      await ctx.voice.saveConversation(ctx.getSessionLabel(), ctx.getChatHistory(), ctx.voice.isConnected);
      break;

    case '/help':
      printHelp();
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
      console.log(chalk.white(`  ● ${ctx.getSessionLabel() || 'default'} ${chalk.green('(Active)')}`));
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    case '/session':
      if (!arg) {
        console.log(chalk.yellow('Usage: /session <use|clear> [args...]'));
        break;
      }
      {
        const sessionCmd = arg.toLowerCase();
        if (sessionCmd === 'use' && parts[2]) {
          ctx.switchSession(parts[2]);
          console.log(chalk.green(`✓ Switched to session: ${parts[2]}`));
        } else if (sessionCmd === 'clear') {
          ctx.clearCurrentSessionContext();
          console.log(chalk.green(`✓ Current session cleared.`));
        } else {
          console.log(chalk.yellow('Usage: /session <use|clear> [args...]'));
        }
      }
      break;

    case '/attach':
      if (!arg) {
        console.log(chalk.yellow('Usage: /attach <filepath>'));
        break;
      }
      {
        const attachPath = parts.slice(1).join(' ');
        if (fs.existsSync(attachPath)) {
          const attachments = ctx.getAttachments();
          attachments.push(attachPath);
          InteractionLayer.renderAttachmentPreview(attachPath, `${(fs.statSync(attachPath).size / 1024).toFixed(1)} KB`);
        } else {
          InteractionLayer.renderError(`File not found: ${attachPath}`);
        }
      }
      break;

    case '/detach':
      if (!arg) {
        ctx.setAttachments([]);
        InteractionLayer.renderSuccess('All attachments cleared.');
      } else {
        const detachPath = parts.slice(1).join(' ');
        ctx.setAttachments(ctx.getAttachments().filter(p => p !== detachPath));
        InteractionLayer.renderSuccess(`Detached ${detachPath}`);
      }
      break;

    case '/attachments':
      if (ctx.getAttachments().length === 0) {
        console.log(chalk.gray('No files attached.'));
      } else {
        ctx.getAttachments().forEach(p => InteractionLayer.renderAttachmentPreview(p));
      }
      break;

    default:
      return false;
  }
  return false;
}

function printHelp(): void {
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
}
