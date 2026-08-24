import chalk from 'chalk';
import path from 'path';
import { MemoryService } from '../../memory.js';
import { LearningStore, FeedbackProcessor } from '../../learning.js';
import type { CommandArgs } from '../context.js';

/** /memory /learning /preferences /strategies /feedback */
export async function handleMemoryCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts, raw } = args;

  switch (cmd) {
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
      } else if (arg === 'index' || arg === 'reindex') {
        console.log(chalk.cyan(`\n${arg === 'reindex' ? 'Rebuilding' : 'Building'} semantic vector index...`));
        const status = await MemoryService.reindex();
        console.log(chalk.green('âœ“ Semantic index ready.'));
        console.log(chalk.white(`  Files:      ${status.files}`));
        console.log(chalk.white(`  Chunks:     ${status.chunks}`));
        console.log(chalk.white(`  Embedded:   ${status.embedded}`));
        if (status.failed > 0) console.log(chalk.red(`  Failed:     ${status.failed}`));
        console.log(chalk.gray(`  Model:      ${status.embeddingModel} (v${status.indexVersion})\n`));
      } else if (arg === 'status') {
        const s = MemoryService.indexStatus();
        console.log(chalk.cyan('\nðŸ§  Semantic Index Status'));
        console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€'));
        console.log(chalk.white(`  Chunks indexed: ${s.chunks}`));
        console.log(chalk.white(`  Embedding model: ${s.embeddingModel} (v${s.indexVersion})`));
        console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n'));
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
        console.log(chalk.gray(`Commands: search, list, index, reindex, status, delete, clear, reload\n`));
      }
      break;

    case '/learning': {
      const prefsList = LearningStore.getPreferences();
      const stratsList = LearningStore.getStrategies();
      const explicit = prefsList.filter(p => p.source === 'explicit').length;
      const inferred = prefsList.filter(p => p.source === 'inferred' && p.status === 'CANDIDATE').length;
      const validated = stratsList.filter(s => s.status === 'VALIDATED' || s.status === 'PREFERRED').length;
      const stale = prefsList.filter(p => p.status === 'STALE').length;
      console.log(chalk.cyan(`\nðŸ“š Learning Status`));
      console.log(chalk.gray(`â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`));
      console.log(`Explicit preferences: ${explicit}`);
      console.log(`Inferred candidates: ${inferred}`);
      console.log(`Validated strategies: ${validated}`);
      console.log(`Stale patterns: ${stale}`);
      console.log(chalk.gray(`â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n`));
      break;
    }

    case '/preferences':
      if (arg === 'forget' && raw.split(' ')[2]) {
        const id = raw.split(' ')[2];
        if (LearningStore.deletePreference(id)) console.log(chalk.green(`Deleted preference ${id}`));
        else console.log(chalk.red(`Preference ${id} not found.`));
        break;
      }

      {
        const allPrefs = LearningStore.getPreferences();
        console.log(chalk.cyan(`\nâš™ï¸ Learned Preferences`));
        console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€'));
        for (const p of allPrefs) {
          console.log(`- [${p.id}] [${p.scope}${p.projectName ? ':' + p.projectName : ''}] ${p.key} = ${p.value} (${p.status})`);
        }
        if (allPrefs.length === 0) console.log(chalk.gray('  No preferences learned yet.'));
        console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n'));
      }
      break;

    case '/strategies': {
      const allStrats = LearningStore.getStrategies();
      console.log(chalk.cyan(`\nðŸ§  Learned Strategies`));
      console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€'));
      for (const s of allStrats) {
        console.log(`- [${s.id}] [${s.domain}] ${s.situation}`);
        console.log(`  Status: ${s.status}, Success: ${(s.successCount / ((s.successCount + s.failureCount) || 1) * 100).toFixed(0)}% (${s.successCount} wins, ${s.failureCount} fails)`);
      }
      if (allStrats.length === 0) console.log(chalk.gray('  No strategies learned yet.'));
      console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n'));
      break;
    }

    case '/feedback':
      if (!arg) {
        console.log(chalk.yellow('Usage: /feedback <message>'));
        break;
      }
      FeedbackProcessor.processFeedback(arg);
      console.log(chalk.green(`Feedback recorded: "${arg}"`));
      break;

    default:
      return false;
  }
  return false;
}

