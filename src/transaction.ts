import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { Telemetry } from './telemetry.js';
import { EventStore } from './runtime/events.js';
import { TransactionProjection } from './runtime/projections.js';
import { roseDataPath } from './storage-paths.js';

const execPromise = promisify(exec);

// ──────────────────────────────────────────────────────────
// SECTION 1: INTERFACES & TYPES
// ──────────────────────────────────────────────────────────

export type SideEffectType = 'READ' | 'PREDICTABLE_WRITE' | 'IRREVERSIBLE_WRITE' | 'EXTERNAL_ACTION' | 'DESTRUCTIVE';

export interface TransactionAction {
    id: string;
    tool: string;
    target: string; // e.g. file path, URL
    sideEffect: SideEffectType;
    status: 'pending' | 'success' | 'failed' | 'rolled_back';
    snapshotId?: string; // ID of the checkpoint/backup taken before this action
    timestamp: number;
}

export interface TransactionCheckpoint {
    id: string;
    type: 'git_stash' | 'git_commit' | 'file_backup' | 'custom_undo';
    target?: string; // specific file backed up
    metadata?: any;
    createdAt: number;
}

export type TransactionStatus = 'PREPARING' | 'SIMULATING' | 'READY' | 'RUNNING' | 'VERIFYING' | 'COMMITTING' | 'COMMITTED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'RECOVERY' | 'FAILED' | 'CANCELLED';

export interface AgentTransaction {
    id: string;
    taskId: string;
    status: TransactionStatus;
    checkpoints: TransactionCheckpoint[];
    actions: TransactionAction[];
    createdAt: number;
    updatedAt: number;
}

// ──────────────────────────────────────────────────────────
// SECTION 2: TRANSACTION MANAGER
// ──────────────────────────────────────────────────────────

export class TransactionManager {
    private static transactions: Map<string, AgentTransaction> = new Map();
    private static BASE_DIR = roseDataPath('transactions');

    public static async init() {
        if (!fs.existsSync(this.BASE_DIR)) {
            fs.mkdirSync(this.BASE_DIR, { recursive: true });
        }
        this.transactions = await TransactionProjection.rebuildAll();
    }

    public static async begin(taskId: string, simulate: boolean = false): Promise<AgentTransaction> {
        const tx: AgentTransaction = {
            id: crypto.randomBytes(4).toString('hex'),
            taskId,
            status: simulate ? 'SIMULATING' : 'PREPARING',
            checkpoints: [],
            actions: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.transactions.set(tx.id, tx);
        await EventStore.append('transaction', tx.id, 'transaction.prepared', { taskId, simulate });
        
        Telemetry.recordEvent('transaction.begun', 'system', 'started', undefined, { txId: tx.id, simulate });
        return tx;
    }

    public static getTransaction(id: string): AgentTransaction | undefined {
        return this.transactions.get(id);
    }
    
    public static getTransactions(): AgentTransaction[] {
        return Array.from(this.transactions.values());
    }

    public static async updateStatus(txId: string, status: TransactionStatus) {
        const tx = this.transactions.get(txId);
        if (tx) {
            tx.status = status;
            tx.updatedAt = Date.now();
            await EventStore.append('transaction', tx.id, 'transaction.status_changed', { status });
        }
    }

    /**
     * Creates a checkpoint before a risky operation.
     */
    public static async createCheckpoint(txId: string, targetFile?: string): Promise<string | null> {
        const tx = this.transactions.get(txId);
        if (!tx || tx.status === 'SIMULATING') return null;

        const cpId = crypto.randomBytes(4).toString('hex');
        
        // Strategy 1: Git checkpoint if applicable
        try {
            // Very naive check if it's a git repo
            if (fs.existsSync(path.join(process.cwd(), '.git'))) {
                // Not doing a full commit/stash unless requested to avoid messing up user's tree, 
                // but we will do file backup for precise tracking.
            }
        } catch (e) {
            // ignore
        }

        // Strategy 2: File backup
        if (targetFile) {
            const absoluteTarget = path.resolve(process.cwd(), targetFile);
            if (fs.existsSync(absoluteTarget)) {
                const backupPath = path.join(this.BASE_DIR, `${cpId}.backup`);
                fs.copyFileSync(absoluteTarget, backupPath);
                
                const cp: TransactionCheckpoint = {
                    id: cpId,
                    type: 'file_backup',
                    target: absoluteTarget,
                    createdAt: Date.now()
                };
                tx.checkpoints.push(cp);
                await EventStore.append('transaction', tx.id, 'transaction.checkpoint.created', { checkpoint: cp });
                return cpId;
            }
        }

        return null;
    }

    public static recordAction(txId: string, tool: string, target: string, sideEffect: SideEffectType, snapshotId?: string) {
        const tx = this.transactions.get(txId);
        if (!tx) return;

        const action: TransactionAction = {
            id: crypto.randomBytes(4).toString('hex'),
            tool,
            target,
            sideEffect,
            status: 'success',
            snapshotId,
            timestamp: Date.now()
        };
        tx.actions.push(action);
        tx.updatedAt = Date.now();
        EventStore.append('transaction', tx.id, 'transaction.action.recorded', { action });
    }

    public static async commit(txId: string) {
        const tx = this.transactions.get(txId);
        if (!tx) return;

        tx.status = 'COMMITTING';
        
        // Clean up file backups since we don't need them anymore
        for (const cp of tx.checkpoints) {
            if (cp.type === 'file_backup') {
                const backupPath = path.join(this.BASE_DIR, `${cp.id}.backup`);
                if (fs.existsSync(backupPath)) {
                    fs.unlinkSync(backupPath);
                }
            }
        }
        
        tx.status = 'COMMITTED';
        tx.updatedAt = Date.now();
        await EventStore.append('transaction', tx.id, 'transaction.status_changed', { status: 'COMMITTED' });
        Telemetry.recordEvent('transaction.committed', 'system', 'completed', undefined, { txId });
    }

    public static async rollback(txId: string): Promise<boolean> {
        const tx = this.transactions.get(txId);
        if (!tx || tx.status === 'ROLLED_BACK') return false;

        console.log(chalk.yellow(`\n[TX] Rolling back transaction ${txId}...`));
        tx.status = 'ROLLING_BACK';

        let successCount = 0;
        let failCount = 0;

        // Rollback in reverse order
        for (let i = tx.checkpoints.length - 1; i >= 0; i--) {
            const cp = tx.checkpoints[i];
            if (cp.type === 'file_backup' && cp.target) {
                const backupPath = path.join(this.BASE_DIR, `${cp.id}.backup`);
                if (fs.existsSync(backupPath)) {
                    try {
                        fs.copyFileSync(backupPath, cp.target);
                        console.log(chalk.gray(`  Restored file: ${cp.target}`));
                        successCount++;
                    } catch (e: any) {
                        console.error(chalk.red(`  Failed to restore ${cp.target}: ${e.message}`));
                        failCount++;
                    }
                } else {
                    // if target didn't exist before, we should delete it
                    try {
                        if (fs.existsSync(cp.target)) {
                            // AV/indexers can hold brief locks on fresh files.
                            let deleted = false;
                            for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
                                try {
                                    fs.unlinkSync(cp.target);
                                    deleted = true;
                                } catch {
                                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                                }
                            }
                            if (deleted) {
                                console.log(chalk.gray(`  Deleted newly created file: ${cp.target}`));
                                successCount++;
                            } else {
                                failCount++;
                            }
                        }
                    } catch (e: any) {
                         failCount++;
                    }
                }
            }
        }

        // Mark actions as rolled back
        for (const a of tx.actions) {
            if (a.sideEffect === 'PREDICTABLE_WRITE') {
                a.status = 'rolled_back';
            }
        }

        tx.status = failCount === 0 ? 'ROLLED_BACK' : 'FAILED';
        tx.updatedAt = Date.now();
        await EventStore.append('transaction', tx.id, 'transaction.status_changed', { status: tx.status });
        Telemetry.recordEvent('transaction.rollback', 'system', failCount === 0 ? 'completed' : 'failed', undefined, { txId });
        
        return failCount === 0;
    }
}
