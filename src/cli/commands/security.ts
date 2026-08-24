import chalk from 'chalk';
import { SecurityEngine, AutonomyMode } from '../../security.js';
import { TransactionManager } from '../../transaction.js';
import { EventStore } from '../../runtime/events.js';
import { TaskProjection } from '../../runtime/projections.js';
import { PolicyStore } from '../../policy/store.js';
import type { CommandArgs } from '../context.js';

/** /security /policies /policy /transactions /transaction /runtime /events */
export async function handleSecurityCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts, raw } = args;

  switch (cmd) {
    case '/security':
      // NOTE: fixed parsing — the original `arg.startsWith('mode ')` could
      // never match because arg is a single token. `/security mode <value>`.
      if (arg === 'mode' && parts[2]) {
        const modeStr = parts[2].toLowerCase();
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
      console.log(chalk.white(`Terminal Sandboxing: `) + chalk.yellow('Layered (parser + allowlist + dir jail)'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      console.log(chalk.gray(`Change mode via: /security mode [safe|balanced|autonomous]\n`));
      break;

    case '/transactions':
      console.log(chalk.cyan('\n📦 Transactions'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      {
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
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    case '/transaction':
      if (arg === 'rollback' && raw.split(' ')[2]) {
        const txId = raw.split(' ')[2];
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
        {
          const txCount = TransactionManager.getTransactions().length;
          const evts = await EventStore.readAll();
          console.log(`Event Store: ${evts.length} durable events logged.`);
          console.log(`Projections: ${txCount} transactions active in memory.`);
        }
        console.log(chalk.gray('────────────────────────────────────────────\n'));
      }
      break;

    case '/events': {
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
    }

    case '/policies': {
      const policies = PolicyStore.getAllPolicies();
      console.log(chalk.cyan(`\n📜 Active Policies (${policies.length} total)`));
      console.log(chalk.gray('────────────────────────────────────────────'));
      if (policies.length === 0) console.log(chalk.gray('  No policies loaded.'));
      for (const p of policies) {
        console.log(`- [${p.id}] ${p.description}`);
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

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

    default:
      return false;
  }
  return false;
}
