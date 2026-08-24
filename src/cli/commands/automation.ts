import chalk from 'chalk';
import { AutomationEngine } from '../../automation.js';
import { MaintenanceEngine } from '../../maintenance/engine.js';
import type { CommandArgs } from '../context.js';

/** /automations /automation /maintenance */
export async function handleAutomationCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, raw } = args;

  switch (cmd) {
    case '/automations':
      console.log(chalk.cyan('\n⚙️ Automations'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      {
        const autos = AutomationEngine.list();
        if (autos.length === 0) console.log(chalk.gray('  No automations configured.'));
        for (const auto of autos) {
          const status = auto.enabled ? chalk.green('✓ ACTIVE') : chalk.yellow('⏸ PAUSED');
          console.log(`${status} ${chalk.white(auto.name)} [${chalk.gray(auto.id)}]`);
          console.log(`  Trigger: ${auto.trigger.value}`);
          console.log(`  Action: ${auto.action.goal}\n`);
        }
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    case '/automation':
      if (!arg) {
        console.log(chalk.yellow('Usage: /automation <create|pause|resume|run|cancel> [args...]'));
        break;
      }
      {
        const autoParts = raw.split(' ').slice(1);
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
      }
      break;

    case '/maintenance':
      console.log(chalk.cyan('\n🛠️ Maintenance & Governance Engine'));
      console.log(chalk.gray('────────────────────────────────────────────'));

      if (!arg) {
        console.log(chalk.yellow('Usage: /maintenance <scan|execute> [id]'));
        break;
      }

      {
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
      }
      break;

    default:
      return false;
  }
  return false;
}
