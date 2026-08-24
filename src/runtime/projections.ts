import { EventStore, RuntimeEvent } from './events.js';
import { AgentTask, TaskStep } from '../tasks.js';
import { AgentTransaction, TransactionAction, TransactionCheckpoint } from '../transaction.js';

export class TaskProjection {
    public static async rebuildAll(): Promise<Map<string, AgentTask>> {
        const events = await EventStore.read('task');
        const tasks = new Map<string, AgentTask>();

        for (const evt of events) {
            let task = tasks.get(evt.aggregateId);
            
            switch (evt.type) {
                case 'task.created':
                    tasks.set(evt.aggregateId, {
                        id: evt.aggregateId,
                        goal: evt.payload.goal,
                        status: 'executing',
                        steps: evt.payload.steps || [],
                        definitionOfDone: evt.payload.dod,
                        createdAt: evt.timestamp,
                        updatedAt: evt.timestamp
                    });
                    break;
                case 'task.status_changed':
                    if (task) {
                        task.status = evt.payload.status;
                        task.updatedAt = evt.timestamp;
                    }
                    break;
                case 'task.step.started':
                    if (task) {
                        const step = task.steps[evt.payload.stepIndex];
                        if (step) step.status = 'running';
                        task.updatedAt = evt.timestamp;
                    }
                    break;
                case 'task.step.completed':
                    if (task) {
                        const step = task.steps[evt.payload.stepIndex];
                        if (step) {
                            step.status = 'completed';
                            step.result = evt.payload.result;
                        }
                        task.updatedAt = evt.timestamp;
                    }
                    break;
                case 'task.step.failed':
                    if (task) {
                        const step = task.steps[evt.payload.stepIndex];
                        if (step) {
                            step.status = 'failed';
                            step.error = evt.payload.error;
                        }
                        task.updatedAt = evt.timestamp;
                    }
                    break;
            }
        }
        return tasks;
    }

    public static async getTask(taskId: string): Promise<AgentTask | null> {
        const tasks = await this.rebuildAll();
        return tasks.get(taskId) || null;
    }
}

export class TransactionProjection {
    public static async rebuildAll(): Promise<Map<string, AgentTransaction>> {
        const events = await EventStore.read('transaction');
        const txs = new Map<string, AgentTransaction>();

        for (const evt of events) {
            let tx = txs.get(evt.aggregateId);
            
            switch (evt.type) {
                case 'transaction.prepared':
                    txs.set(evt.aggregateId, {
                        id: evt.aggregateId,
                        taskId: evt.payload.taskId,
                        status: evt.payload.simulate ? 'SIMULATING' : 'PREPARING',
                        checkpoints: [],
                        actions: [],
                        createdAt: evt.timestamp,
                        updatedAt: evt.timestamp
                    });
                    break;
                case 'transaction.status_changed':
                    if (tx) {
                        tx.status = evt.payload.status;
                        tx.updatedAt = evt.timestamp;
                    }
                    break;
                case 'transaction.checkpoint.created':
                    if (tx) {
                        tx.checkpoints.push(evt.payload.checkpoint);
                        tx.updatedAt = evt.timestamp;
                    }
                    break;
                case 'transaction.action.recorded':
                    if (tx) {
                        tx.actions.push(evt.payload.action);
                        tx.updatedAt = evt.timestamp;
                    }
                    break;
            }
        }
        return txs;
    }
}

export class GoalProjection {
    public static async rebuildAll(): Promise<Map<string, any>> {
        const events = await EventStore.read('goal');
        const goals = new Map<string, any>();

        for (const evt of events) {
            let goal = goals.get(evt.aggregateId);
            
            switch (evt.type) {
                case 'goal.created':
                    goals.set(evt.aggregateId, {
                        ...evt.payload.goal,
                        id: evt.aggregateId,
                        createdAt: evt.timestamp,
                        updatedAt: evt.timestamp
                    });
                    break;
                case 'goal.status_changed':
                    if (goal) {
                        goal.status = evt.payload.status;
                        goal.updatedAt = evt.timestamp;
                    }
                    break;
                case 'goal.criterion.verified':
                    if (goal) {
                        const crit = goal.successCriteria.find((c: any) => c.id === evt.payload.criterionId);
                        if (crit) {
                            crit.isVerified = true;
                            crit.verifiedAt = evt.timestamp;
                            crit.evidence = evt.payload.evidence;
                        }
                        
                        // Update progress
                        const verifiedCount = goal.successCriteria.filter((c: any) => c.isVerified).length;
                        goal.progressPercentage = Math.round((verifiedCount / goal.successCriteria.length) * 100);
                        goal.updatedAt = evt.timestamp;
                    }
                    break;
                case 'goal.priority.changed':
                    if (goal) {
                        goal.priority = evt.payload.priority;
                        goal.updatedAt = evt.timestamp;
                    }
                    break;
            }
        }
        return goals;
    }
}
