import chalk from 'chalk';
import { GoalManager } from '../../goals/manager.js';
import { GoalLoop } from '../../goals/loop.js';
import { WorldModel } from '../../world/model.js';
import { ObservationEngine } from '../../world/observer.js';
import { SimulationEngine } from '../../simulation/engine.js';
import type { CommandArgs } from '../context.js';

/** /goals /goal /simulations /simulation /world */
export async function handleGoalCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts, raw } = args;

  switch (cmd) {
    case '/goals': {
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
    }

    case '/goal':
      if (arg === 'create') {
        const title = raw.split(' ').slice(2).join(' ') || 'New Goal';
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

    case '/simulations': {
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
    }

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

    case '/world':
      console.log(chalk.cyan('\n🌍 World Model Status'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      ObservationEngine.fullRefresh();
      {
        const entities = WorldModel.getAll();
        if (entities.length === 0) console.log(chalk.gray('  World model is empty.'));
        for (const e of entities) {
          let color = chalk.white;
          if (e.state === 'healthy') color = chalk.green;
          if (e.state === 'degraded') color = chalk.yellow;
          if (e.state === 'broken') color = chalk.red;
          console.log(`- ${e.type}: ${e.id} [${color(e.state)}] (Source: ${e.source})`);
        }
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    default:
      return false;
  }
  return false;
}
