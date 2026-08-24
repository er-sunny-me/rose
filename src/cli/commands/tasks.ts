import chalk from 'chalk';
import { TaskProjection } from '../../runtime/projections.js';
import type { CliContext, CommandArgs } from '../context.js';

/** /task /tasks /queue */
export async function handleTaskCommands(ctx: CliContext, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg } = args;

  switch (cmd) {
    case '/task':
    case '/tasks':
      if (arg === 'status') {
        const t = ctx.taskExecutor.getActiveTask();
        if (!t) {
          console.log(chalk.gray('No active task.'));
        } else {
          console.log(chalk.cyan(`\nActive Task: ${t.goal}`));
          console.log(chalk.white(`Status: ${t.status}`));
          console.log(chalk.white(`Steps:`));
          t.steps.forEach((s: any, i: number) => {
            let symbol = ' ';
            if (s.status === 'completed') symbol = '✓';
            if (s.status === 'failed') symbol = '✗';
            if (s.status === 'running') symbol = '➜';
            if (s.status === 'pending') symbol = '·';
            console.log(chalk.gray(`  ${symbol} [${i + 1}] ${s.description}`));
          });
          console.log();
        }
      } else if (arg === 'cancel') {
        ctx.taskExecutor.cancelTask();
      } else {
        console.log(chalk.gray('Commands: /task status, /task cancel'));
      }
      break;

    case '/queue':
      console.log(chalk.cyan('\n📋 Task Queue / Active Tasks'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      {
        const tasksMap = await TaskProjection.rebuildAll();
        let qCount = 0;
        for (const [id, t] of tasksMap.entries()) {
          if (t.status === 'executing' || t.status === 'waiting' || t.status === 'planning') {
            console.log(`- [${id}] ${t.goal.substring(0, 50)}... (${chalk.blue(t.status)})`);
            qCount++;
          }
        }
        if (qCount === 0) console.log(chalk.gray('  Queue is empty. No running tasks.'));
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    default:
      return false;
  }
  return false;
}
