import chalk from 'chalk';
import { TaskProjection, TransactionProjection } from './projections.js';
import { EventStore } from './events.js';

export class RuntimeReconciler {
    public static async recover() {
        console.log(chalk.cyan(`\n🔄 [Runtime] Initiating state reconciliation from Event Store...`));
        
        // 1. Recover Tasks
        const tasks = await TaskProjection.rebuildAll();
        let activeTasks = 0;
        let orphanedTasks = 0;
        
        for (const [id, task] of tasks.entries()) {
            if (task.status === 'executing' || task.status === 'waiting' || task.status === 'planning') {
                // If a task is executing but we just started up, it crashed mid-flight.
                // We mark it as orphaned/dead-letter.
                console.log(chalk.yellow(`  [Runtime] Found orphaned task ${id}. Moving to failed/dead-letter.`));
                await EventStore.append('task', id, 'task.status_changed', { status: 'failed', reason: 'Process crashed during execution' });
                orphanedTasks++;
            }
        }
        
        // 2. Recover Transactions
        const txs = await TransactionProjection.rebuildAll();
        let orphanedTxs = 0;
        for (const [id, tx] of txs.entries()) {
            if (['PREPARING', 'SIMULATING', 'READY', 'RUNNING', 'VERIFYING', 'COMMITTING', 'ROLLING_BACK', 'RECOVERY'].includes(tx.status)) {
                console.log(chalk.yellow(`  [Runtime] Found orphaned transaction ${id} (Status: ${tx.status}). Marking failed.`));
                await EventStore.append('transaction', id, 'transaction.status_changed', { status: 'FAILED', reason: 'Process crashed during transaction' });
                orphanedTxs++;
            }
        }

        console.log(chalk.green(`  [Runtime] Reconciliation complete. Rebuilt ${tasks.size} tasks, ${txs.size} transactions.`));
        if (orphanedTasks > 0 || orphanedTxs > 0) {
            console.log(chalk.yellow(`  [Runtime] Recovered ${orphanedTasks} orphaned tasks and ${orphanedTxs} orphaned transactions.`));
        }
    }
}
