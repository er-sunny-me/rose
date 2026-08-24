import chalk from 'chalk';
import { AgentTransaction, TransactionManager } from './transaction.js';

export class RecoveryEngine {
    /**
     * Diagnoses a failure and determines the best recovery action.
     * Return true if recovery was handled (e.g. rolled back or repaired).
     */
    public static async diagnoseAndRecover(txId: string, errorMsg: string): Promise<boolean> {
        const tx = TransactionManager.getTransaction(txId);
        if (!tx) return false;

        console.log(chalk.red(`\n🚨 [RECOVERY] Transaction ${txId} failed.`));
        console.log(chalk.red(`  Reason: ${errorMsg}`));

        // 1. Is transient?
        if (this.isTransient(errorMsg)) {
            console.log(chalk.yellow(`  Diagnosis: Transient error. Retrying is recommended by TaskExecutor.`));
            // We just let TaskExecutor retry it if it hasn't exceeded maxRetries
            return false;
        }

        // 2. Are there destructive/irreversible actions?
        const hasIrreversible = tx.actions.some(a => a.sideEffect === 'IRREVERSIBLE_WRITE' || a.sideEffect === 'DESTRUCTIVE');
        if (hasIrreversible) {
            console.log(chalk.red(`  Diagnosis: Transaction contains irreversible actions. Cannot automatically rollback everything.`));
            // We'll still attempt partial rollback of predictable writes
        }

        // 3. Rollback Predictable Writes
        console.log(chalk.yellow(`  Action: Initiating rollback for safe state...`));
        const rollbackSuccess = await TransactionManager.rollback(txId);
        
        if (rollbackSuccess) {
            console.log(chalk.green(`  Result: Rollback successful. Safe to replan or abort.`));
            return true; 
        } else {
            console.log(chalk.red(`  Result: Rollback failed or was partial. Manual intervention may be required.`));
            return true; // We tried to handle it, so we tell TaskExecutor we handled the failure state.
        }
    }

    private static isTransient(errorMsg: string): boolean {
        const lower = errorMsg.toLowerCase();
        return lower.includes('timeout') || 
               lower.includes('network') || 
               lower.includes('econnrefused') || 
               lower.includes('rate limit');
    }
}
