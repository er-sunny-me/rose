import { WorldEntity } from '../world/model.js';

export type ToolSimulationMode = 'real' | 'dry_run' | 'simulate' | 'unsupported';
export type SimulationStatus = 'draft' | 'running' | 'completed' | 'failed' | 'stale' | 'promoted' | 'cancelled';

export interface SimulationSnapshot {
    id: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    entities: WorldEntity[]; // Cloned world state at the time of creation
}

export interface RiskPrediction {
    category: string;
    description: string;
    probability: number; // 0.0 to 1.0
    impact: 'low' | 'medium' | 'high' | 'critical';
}

export interface ChangeImpact {
    entityId: string;
    changeType: 'created' | 'modified' | 'deleted';
    description: string;
}

export interface SimulationOutcome {
    branchId: string;
    strategy: string;
    expectedState: string;
    expectedChanges: ChangeImpact[];
    predictedRisks: RiskPrediction[];
    estimatedCostTokens: number;
    estimatedDurationMs: number;
    confidenceScore: number; // 0.0 to 1.0
    assumptions: string[];
    verificationPlan: string[];
}

export interface SimulationBranch {
    id: string;
    snapshotId: string;
    strategy: string;
    status: SimulationStatus;
    outcome?: SimulationOutcome;
    createdAt: number;
    updatedAt: number;
}
