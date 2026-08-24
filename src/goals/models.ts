export type GoalStatus = 'draft' | 'active' | 'paused' | 'blocked' | 'at_risk' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type GoalPriority = 'critical' | 'high' | 'normal' | 'low';
export type GoalScope = 'global' | 'project' | 'workspace' | 'service' | 'automation' | 'session';

export interface GoalConstraints {
    maxRuntimeMinutesPerRun?: number;
    maxTasksPerRun?: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxCost?: number;
    allowedCapabilities?: string[];
    forbiddenCapabilities?: string[];
    allowedProjects?: string[];
    allowedServices?: string[];
    requireApproval?: boolean;
    activeHours?: { start: string, end: string }; // e.g. "09:00", "22:00"
}

export interface SuccessCriterion {
    id: string;
    description: string;
    isVerified: boolean;
    verifiedAt?: number;
    evidence?: string;
    verificationMethod?: 'manual' | 'tool' | 'heuristic' | 'llm';
}

export interface AgentGoal {
    id: string;
    title: string;
    objective: string;
    status: GoalStatus;
    priority: GoalPriority;
    scope?: GoalScope;
    constraints?: GoalConstraints;
    successCriteria: SuccessCriterion[];
    
    deadline?: number;
    progressPercentage: number;
    completedTasksCount: number;
    activeTasksCount: number;
    blockedTasksCount: number;
    
    parentGoalId?: string;
    dependencies?: string[]; // goal IDs
    
    createdAt: number;
    updatedAt: number;
}
