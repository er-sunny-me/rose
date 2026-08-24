import chalk from 'chalk';
import { MaintenanceTask, MaintenanceReport } from './models.js';
import { MaintenanceScanner } from './scanner.js';
import { MaintenancePlanner } from './planner.js';
import { MaintenanceVerifier } from './verifier.js';
import { TransactionManager } from '../transaction.js';
import { EventStore } from '../runtime/events.js';
import { PolicyEngine } from '../policy/engine.js';
import { IncidentManager } from '../rca/manager.js';

export class MaintenanceEngine {
    private static tasks: Map<string, MaintenanceTask> = new Map();

    public static async runAudit(workspaceRoot: string): Promise<MaintenanceReport> {
        console.log(chalk.magenta(`\n[MaintenanceEngine] Starting ecosystem audit...`));
        
        // 1. Detect
        const detectedTasks = await MaintenanceScanner.scanDependencies(workspaceRoot);
        
        for (const task of detectedTasks) {
            this.tasks.set(task.id, task);
            await EventStore.append('maintenance', task.id, 'maintenance.detected', { task });
        }

        const report: MaintenanceReport = {
            timestamp: Date.now(),
            detectedCount: detectedTasks.length,
            tasks: detectedTasks,
            overallRisk: detectedTasks.some(t => t.risk === 'high' || t.risk === 'critical') ? 'high' : 'low',
            recommendations: detectedTasks.map(t => `Upgrade ${t.target} to ${t.targetVersion}`)
        };

        return report;
    }

    public static async executeTask(taskId: string): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.error(chalk.red(`[MaintenanceEngine] Task ${taskId} not found.`));
            return false;
        }

        console.log(chalk.magenta(`\n[MaintenanceEngine] Executing maintenance task: ${task.description}`));

        // 2. Plan
        await MaintenancePlanner.planMigration(task);
        await EventStore.append('maintenance', task.id, 'maintenance.planned', { task });

        // 3. Simulate
        const simPassed = await MaintenancePlanner.simulateUpgrade(task);
        await EventStore.append('maintenance', task.id, 'maintenance.simulated', { task, simPassed });

        if (!simPassed) {
            console.log(chalk.yellow(`[MaintenanceEngine] Aborting task ${taskId} due to simulation failure.`));
            return false;
        }

        // 4. Policy Check
        const policyDecision = await PolicyEngine.evaluate(
            'maintenance.upgrade',
            task.target,
            {
                actor: 'system',
                executor: 'maintenance_engine',
                trustDomain: 'TRUSTED_CORE'
            }
        );

        if (policyDecision.decision === 'DENY') {
            console.log(chalk.red(`[MaintenanceEngine] Policy denied upgrade of ${task.target}: ${policyDecision.reasons.join(', ')}`));
            task.status = 'failed';
            return false;
        }

        // 5. Transaction & Checkpoint
        task.status = 'running';
        await EventStore.append('maintenance', task.id, 'maintenance.started', { task });

        const tx = await TransactionManager.begin(`maintenance-${task.id}`, false);
        task.transactionId = tx.id;
        
        await TransactionManager.createCheckpoint(tx.id, 'package.json'); // Backup package.json before doing anything

        try {
            // 6. Migrate (Mocked actual update)
            console.log(chalk.blue(`[MaintenanceEngine] Applying update to ${task.target}...`));
            TransactionManager.recordAction(tx.id, 'npm', `npm install ${task.target}@${task.targetVersion}`, 'PREDICTABLE_WRITE');
            
            // 7. Test & Verify
            task.status = 'verifying';
            const verification = await MaintenanceVerifier.verifyRegression(task);

            if (verification.passed) {
                // 8. Commit
                await TransactionManager.updateStatus(tx.id, 'COMMITTING');
                task.status = 'completed';
                task.updatedAt = Date.now();
                await TransactionManager.updateStatus(tx.id, 'COMMITTED');
                await EventStore.append('maintenance', task.id, 'maintenance.completed', { task });
                console.log(chalk.green(`[MaintenanceEngine] Task ${task.id} successfully committed.`));
                return true;
            } else {
                // 9. Rollback & Incident Creation
                throw new Error(`Verification failed: ${verification.testResults.join(', ')}`);
            }
        } catch (e: any) {
            console.error(chalk.red(`[MaintenanceEngine] Task ${task.id} failed during execution/verification. Rolling back...`));
            console.error(chalk.red(`[MaintenanceEngine] Error: ${e.message}`));
            
            await TransactionManager.updateStatus(tx.id, 'ROLLING_BACK');
            task.status = 'rolled-back';
            task.updatedAt = Date.now();
            await TransactionManager.updateStatus(tx.id, 'ROLLED_BACK');
            
            await EventStore.append('maintenance', task.id, 'maintenance.rolled_back', { task, error: e.message });

            // Create Incident
            IncidentManager.reportSymptom(`Maintenance upgrade failed for ${task.target}: ${e.message}`, 'high');
            
            return false;
        }
    }
}
