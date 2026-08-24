import { AgentGoal } from './models.js';
import { WorldModel } from '../world/model.js';
import { ModelRouter } from '../router.js';
import chalk from 'chalk';

export class GoalPlanner {
    public static async decompose(goal: AgentGoal): Promise<string[]> {
        console.log(chalk.cyan(`[GoalPlanner] Decomposing goal: ${goal.title}...`));
        const worldState = JSON.stringify(WorldModel.getAll().slice(0, 10)); // Top 10 entities
        
        const prompt = `You are the Agent Goal Planner.
Decompose this long-horizon goal into 2-5 distinct actionable objectives or tasks.
Goal: ${goal.objective}
World State: ${worldState}

Return a simple JSON array of strings, each string being an objective. Do not include markdown formatting.`;

        try {
            const result = await ModelRouter.route({ intent: 'planning', capabilities: ['reasoning'] }, [{ role: 'user', content: prompt }]);
            const tasks: string[] = JSON.parse(result.trim());
            return tasks;
        } catch (e) {
            console.error(chalk.red(`[GoalPlanner] Failed to decompose goal.`));
            return ["Perform initial research and environment inspection."];
        }
    }

    public static async nextBestAction(goal: AgentGoal): Promise<string | null> {
        // Simple priority/utility loop
        // If we have blocked tasks, maybe unblock
        // If we have pending success criteria, try to satisfy them
        const unverified = goal.successCriteria.filter(c => !c.isVerified);
        if (unverified.length > 0) {
            return `Satisfy success criterion: ${unverified[0].description}`;
        }
        
        // Value of information: if world model is unknown
        const unknowns = WorldModel.getAll().filter(e => e.state === 'unknown');
        if (unknowns.length > 0) {
            return `Investigate unknown state: ${unknowns[0].type} ${unknowns[0].name || unknowns[0].id}`;
        }
        
        return null;
    }

    public static async generateCandidateStrategies(goal: AgentGoal, maxCandidates: number = 3): Promise<string[]> {
        console.log(chalk.cyan(`[GoalPlanner] Generating up to ${maxCandidates} candidate strategies for goal: ${goal.title}...`));
        const worldState = JSON.stringify(WorldModel.getAll().slice(0, 10));
        
        const prompt = `You are the Agent Simulation Planner.
Generate ${maxCandidates} distinct alternative strategies to achieve the next objective of this goal.
Goal: ${goal.objective}
World State: ${worldState}

For example, strategies could represent tradeoffs like:
- Strategy 1: Safest but slowest (e.g., dry-run and verify everything)
- Strategy 2: Fastest but higher risk (e.g., direct execution)
- Strategy 3: Resource optimized (e.g., use cached or simple models)

Return a simple JSON array of strings, each string being a distinct strategy description. Do not include markdown formatting.`;

        try {
            const result = await ModelRouter.route({ intent: 'planning', capabilities: ['reasoning'] }, [{ role: 'user', content: prompt }]);
            const strategies: string[] = JSON.parse(result.trim());
            return strategies.slice(0, maxCandidates);
        } catch (e: any) {
            console.error(chalk.red(`[GoalPlanner] Failed to generate candidate strategies: ${e.message}`));
            const fallback = await this.nextBestAction(goal);
            return fallback ? [fallback] : [];
        }
    }
}
