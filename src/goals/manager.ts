import crypto from 'crypto';
import chalk from 'chalk';
import { AgentGoal, GoalStatus, GoalPriority } from './models.js';
import { EventStore } from '../runtime/events.js';
import { GoalProjection } from '../runtime/projections.js';
import { Telemetry } from '../telemetry.js';

export class GoalManager {
    private static goals: Map<string, AgentGoal> = new Map();

    public static async init() {
        this.goals = await GoalProjection.rebuildAll();
    }

    public static getGoals(): AgentGoal[] {
        return Array.from(this.goals.values());
    }

    public static getGoal(id: string): AgentGoal | undefined {
        return this.goals.get(id);
    }

    public static async createGoal(params: Omit<AgentGoal, 'id' | 'status' | 'progressPercentage' | 'completedTasksCount' | 'activeTasksCount' | 'blockedTasksCount' | 'createdAt' | 'updatedAt'>): Promise<AgentGoal> {
        const goal: AgentGoal = {
            ...params,
            id: crypto.randomBytes(4).toString('hex'),
            status: 'active',
            progressPercentage: 0,
            completedTasksCount: 0,
            activeTasksCount: 0,
            blockedTasksCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        this.goals.set(goal.id, goal);
        await EventStore.append('goal', goal.id, 'goal.created', { goal });
        Telemetry.recordEvent('goal.created', 'agent', 'started', undefined, { goalId: goal.id, title: goal.title });
        
        return goal;
    }

    public static async updateStatus(id: string, status: GoalStatus) {
        const goal = this.goals.get(id);
        if (goal) {
            goal.status = status;
            goal.updatedAt = Date.now();
            await EventStore.append('goal', id, 'goal.status_changed', { status });
        }
    }

    public static async verifyCriterion(goalId: string, criterionId: string, evidence: string) {
        const goal = this.goals.get(goalId);
        if (goal) {
            const crit = goal.successCriteria.find(c => c.id === criterionId);
            if (crit) {
                crit.isVerified = true;
                crit.verifiedAt = Date.now();
                crit.evidence = evidence;
                
                const verifiedCount = goal.successCriteria.filter(c => c.isVerified).length;
                goal.progressPercentage = Math.round((verifiedCount / goal.successCriteria.length) * 100);
                goal.updatedAt = Date.now();
                
                await EventStore.append('goal', goalId, 'goal.criterion.verified', { criterionId, evidence });
                
                if (goal.progressPercentage === 100) {
                    await this.updateStatus(goalId, 'completed');
                }
            }
        }
    }
}
