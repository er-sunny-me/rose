import { MaintenanceEngine } from './src/maintenance/engine.js';
import { EventStore } from './src/runtime/events.js';
import { TransactionManager } from './src/transaction.js';
import { SimulationEngine } from './src/simulation/engine.js';
import { PolicyEngine } from './src/policy/engine.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

import { ModelRouter } from './src/router.js';

async function run() {
    console.log(chalk.bold.yellow('\n--- Maintenance Engine Integration Test ---\n'));

    ModelRouter.initialize();
    EventStore.init();
    await TransactionManager.init();

    // 1. Scan for maintenance tasks
    console.log(chalk.cyan('Running Audit...'));
    const report = await MaintenanceEngine.runAudit(process.cwd());
    
    if (report.detectedCount === 0) {
        console.log(chalk.red('No tasks detected. This test expects the mock scanner to return some dummy tasks.'));
        return;
    }

    // Pick a task to upgrade
    const passTask = report.tasks.find(t => t.target === 'chalk');
    const failTask = report.tasks.find(t => t.target.startsWith('dummy-outdated'));

    if (passTask) {
        console.log(chalk.cyan(`\nExecuting Maintenance Pipeline for Task: ${passTask.target}...`));
        const success = await MaintenanceEngine.executeTask(passTask.id);
        console.log(`Pipeline Result: ${success ? 'SUCCESS' : 'FAILED'}`);
    }

    if (failTask) {
        console.log(chalk.cyan(`\nExecuting Maintenance Pipeline for Failing Task: ${failTask.target}...`));
        const failSuccess = await MaintenanceEngine.executeTask(failTask.id);
        console.log(`Pipeline Result: ${failSuccess ? 'SUCCESS' : 'FAILED'} (Expected to Fail)`);
    }

    console.log(chalk.bold.green('\nTest Complete.\n'));
}

run().catch(console.error);
