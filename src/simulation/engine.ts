import crypto from 'crypto';
import chalk from 'chalk';
import { WorldModel } from '../world/model.js';
import { SimulationSnapshot, SimulationBranch, SimulationOutcome } from './models.js';
import { ModelRouter } from '../router.js';
import { EventStore } from '../runtime/events.js';
import { TaskExecutor } from '../tasks.js';

export class SimulationEngine {
    private static snapshots: Map<string, SimulationSnapshot> = new Map();
    private static branches: Map<string, SimulationBranch> = new Map();

    public static createSnapshot(targetType: string, targetId: string): SimulationSnapshot {
        const snapshot: SimulationSnapshot = {
            id: crypto.randomBytes(4).toString('hex'),
            targetType,
            targetId,
            createdAt: Date.now(),
            entities: JSON.parse(JSON.stringify(WorldModel.getAll?.() || [])) // Deep clone to freeze state
        };
        this.snapshots.set(snapshot.id, snapshot);
        console.log(chalk.gray(`[Simulation] Created snapshot ${snapshot.id}`));
        return snapshot;
    }

    public static getBranch(id: string): SimulationBranch | undefined {
        return this.branches.get(id);
    }

    public static getBranches(): SimulationBranch[] {
        return Array.from(this.branches.values());
    }

    public static async simulateStrategy(snapshotId: string, strategy: string): Promise<SimulationBranch> {
        const branch: SimulationBranch = {
            id: crypto.randomBytes(4).toString('hex'),
            snapshotId,
            strategy,
            status: 'running',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.branches.set(branch.id, branch);
        console.log(chalk.cyan(`[Simulation] Running simulation branch ${branch.id} for strategy: "${strategy.substring(0, 30)}..."`));

        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot) {
            branch.status = 'failed';
            return branch;
        }

        const prompt = `You are the Agent Simulation Engine.
Your job is to predict the outcomes of executing the following strategy on the provided world state.
Strategy: ${strategy}
World State: ${JSON.stringify(snapshot.entities.slice(0, 10))}

Provide your output as a JSON object matching this structure:
{
  "expectedState": "A short summary of the expected state after execution",
  "expectedChanges": [
    { "entityId": "id", "changeType": "created|modified|deleted", "description": "desc" }
  ],
  "predictedRisks": [
    { "category": "security|reliability|performance|cost", "description": "desc", "probability": 0.5, "impact": "low|medium|high|critical" }
  ],
  "estimatedCostTokens": 1500,
  "estimatedDurationMs": 10000,
  "confidenceScore": 0.8,
  "assumptions": ["assumption 1", "assumption 2"],
  "verificationPlan": ["check 1", "check 2"]
}
Do not include any markdown formatting or extra text. Return only valid JSON.`;

        try {
            const result = await ModelRouter.route({ intent: 'planning', capabilities: ['reasoning'] }, [{ role: 'user', content: prompt }]);
            const outcomeData = typeof result === 'string' ? JSON.parse(result.trim()) : result;
            
            branch.outcome = {
                branchId: branch.id,
                strategy: strategy,
                ...outcomeData
            };
            branch.status = 'completed';
            branch.updatedAt = Date.now();
        } catch (e: any) {
            console.error(chalk.red(`[Simulation] Branch ${branch.id} failed: ${e.message}`));
            branch.status = 'failed';
        }

        return branch;
    }

    public static compare(branches: SimulationBranch[]): SimulationBranch | null {
        const completed = branches.filter(b => b.status === 'completed' && b.outcome);
        if (completed.length === 0) return null;

        // Simple utility function: confidence - (risks penalty) - (cost penalty)
        let bestBranch = completed[0];
        let bestScore = -Infinity;

        for (const b of completed) {
            const outcome = b.outcome!;
            let riskPenalty = 0;
            for (const r of outcome.predictedRisks) {
                let weight = 0;
                if (r.impact === 'critical') weight = 4;
                if (r.impact === 'high') weight = 3;
                if (r.impact === 'medium') weight = 2;
                if (r.impact === 'low') weight = 1;
                riskPenalty += r.probability * weight;
            }
            const costPenalty = outcome.estimatedCostTokens / 10000; // normalize
            
            const score = outcome.confidenceScore - (riskPenalty * 0.2) - (costPenalty * 0.1);
            
            if (score > bestScore) {
                bestScore = score;
                bestBranch = b;
            }
        }

        return bestBranch;
    }

    public static async promote(branchId: string, goalContext: string): Promise<boolean> {
        const branch = this.branches.get(branchId);
        if (!branch || !branch.outcome) {
            console.error(chalk.red(`[Simulation] Cannot promote invalid or incomplete branch ${branchId}.`));
            return false;
        }

        // Revalidate world state (compare current world state to snapshot)
        const currentWorld = WorldModel.getAll();
        const snapshot = this.snapshots.get(branch.snapshotId);
        if (snapshot) {
            // Simplified stale check: if current world has more updated entities than when snapshot was taken
            const isStale = currentWorld.some(cw => {
                const snapEntity = snapshot.entities.find(se => se.id === cw.id);
                return snapEntity && cw.lastObservedAt > snapEntity.lastObservedAt;
            });

            if (isStale) {
                console.log(chalk.yellow(`[Simulation] Snapshot is stale. Revalidation failed. Branch ${branchId} marked as stale.`));
                branch.status = 'stale';
                return false;
            }
        }

        console.log(chalk.green(`[Simulation] Promoting branch ${branchId} to real execution...`));
        branch.status = 'promoted';
        branch.updatedAt = Date.now();

        // Create transaction / execution task
        const executor = new TaskExecutor();
        try {
            await executor.executeTask(branch.strategy, goalContext);
            return true;
        } catch (e: any) {
            console.error(chalk.red(`[Simulation] Real execution of promoted branch failed: ${e.message}`));
            return false;
        }
    }
}
