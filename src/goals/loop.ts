import chalk from 'chalk';
import { GoalManager } from './manager.js';
import { GoalPlanner } from './planner.js';
import { ObservationEngine } from '../world/observer.js';
import { SecurityEngine } from '../security.js';
import { SimulationEngine } from '../simulation/engine.js';
import { AgentGoal } from './models.js';

export class GoalLoop {
    private static isRunning = false;
    private static maxIterations = 3; // Bounded autonomy

    public static async wake() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(chalk.cyan(`\n⏰ [Goal Loop] Waking up. Evaluating world state and goals...`));
        
        try {
            await this.evaluate();
        } finally {
            this.isRunning = false;
            console.log(chalk.gray(`💤 [Goal Loop] Going to sleep.`));
        }
    }

    private static async evaluate() {
        // Refresh world model
        ObservationEngine.fullRefresh();
        
        const goals = GoalManager.getGoals().filter(g => g.status === 'active');
        if (goals.length === 0) return;

        // Simple prioritization: Critical > High > Normal > Low
        goals.sort((a, b) => {
            const weights = { 'critical': 4, 'high': 3, 'normal': 2, 'low': 1 };
            return weights[b.priority] - weights[a.priority];
        });

        const targetGoal = goals[0];
        
        let iteration = 0;
        while (iteration < this.maxIterations && targetGoal.status === 'active') {
            iteration++;
            console.log(chalk.blue(`\n[Goal Loop] Iteration ${iteration} for Goal: ${targetGoal.title}`));
            
            // Phase 23: Simulation-based planning
            const candidates = await GoalPlanner.generateCandidateStrategies(targetGoal, 3);
            
            if (candidates.length === 0) {
                console.log(chalk.yellow(`[Goal Loop] No next action found. Waiting for world changes.`));
                break;
            }

            console.log(chalk.cyan(`[Goal Loop] Simulating ${candidates.length} candidate strategies...`));
            const snapshot = SimulationEngine.createSnapshot('goal', targetGoal.id);
            const branches = [];
            
            for (const strategy of candidates) {
                const branch = await SimulationEngine.simulateStrategy(snapshot.id, strategy);
                branches.push(branch);
            }

            const bestBranch = SimulationEngine.compare(branches);
            if (!bestBranch) {
                console.log(chalk.red(`[Goal Loop] All simulations failed. Pausing goal.`));
                await GoalManager.updateStatus(targetGoal.id, 'blocked');
                break;
            }

            console.log(chalk.magenta(`[Goal Loop] Selected Best Strategy: ${bestBranch.strategy}`));
            console.log(chalk.gray(`   Confidence: ${bestBranch.outcome?.confidenceScore} | Risks: ${bestBranch.outcome?.predictedRisks.length}`));
            
            // Security check
            const sec = await SecurityEngine.evaluateAction('goal.execute', { action: bestBranch.strategy });
            if (!sec.allowed) {
                console.log(chalk.red(`[Goal Loop] Action blocked by Security Engine. Pausing goal.`));
                await GoalManager.updateStatus(targetGoal.id, 'blocked');
                break;
            }

            // Execute task
            const success = await SimulationEngine.promote(bestBranch.id, `Goal: ${targetGoal.objective}`);
            if (success) {
                console.log(chalk.green(`[Goal Loop] Real execution completed successfully.`));
            } else {
                console.error(chalk.red(`[Goal Loop] Real execution failed.`));
                await GoalManager.updateStatus(targetGoal.id, 'at_risk');
                break;
            }
        }
        
        if (iteration >= this.maxIterations) {
            console.log(chalk.yellow(`[Goal Loop] Reached max iterations (${this.maxIterations}). Yielding to prevent runaway execution.`));
        }
    }
}
