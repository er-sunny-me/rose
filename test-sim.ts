import { GoalManager } from './src/goals/manager.js';
import { GoalLoop } from './src/goals/loop.js';
import { SimulationEngine } from './src/simulation/engine.js';
import { WorldModel } from './src/world/model.js';
import { ModelRouter } from './src/router.js';

async function test() {
    WorldModel.init();
    ModelRouter.initialize();
    
    // Mock the router for the test since local proxy is failing
    ModelRouter.route = async (requirements: any, messages: any[]) => {
        if (messages[0].content.includes('Agent Simulation Planner')) {
            return JSON.stringify([
                "Write thorough unit tests and cache the response",
                "Remove heavy dependencies and rewrite logic",
                "Use edge functions to reduce latency"
            ]);
        }
        if (messages[0].content.includes('Agent Simulation Engine')) {
            return JSON.stringify({
                expectedState: "Latency reduced to 50ms",
                expectedChanges: [],
                predictedRisks: [
                    { category: 'reliability', description: 'May drop requests', probability: 0.1, impact: 'low' }
                ],
                estimatedCostTokens: 500,
                estimatedDurationMs: 1500,
                confidenceScore: 0.9,
                assumptions: ["Network is stable"],
                verificationPlan: ["Run benchmark script"]
            });
        }
        return "[]";
    };
    
    // Create a goal
    const goal = await GoalManager.createGoal({
        title: 'Optimize',
        objective: 'Optimize API Latency to <100ms',
        priority: 'high',
        budget: { maxCostTokens: 50000, maxDurationMs: 60000 },
        successCriteria: [],
        constraints: []
    });

    console.log(`Created Goal: ${goal.id}`);

    // Wake the loop - this should trigger Planner -> Simulation -> Promotion
    await GoalLoop.wake();
    
    const branches = SimulationEngine.getBranches();
    console.log(`\nFinal Simulation Branches:`);
    for (const b of branches) {
        console.log(`- Branch ${b.id}: Status=${b.status} Strategy="${b.strategy.substring(0,20)}..."`);
    }
}

test().catch(console.error);
