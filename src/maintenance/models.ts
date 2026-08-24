export type MaintenanceTaskType = 
    | "dependency-update"
    | "plugin-update"
    | "mcp-update"
    | "schema-migration"
    | "config-migration"
    | "runtime-migration"
    | "repair";

export type MaintenanceTaskStatus = 
    | "detected"
    | "planned"
    | "simulating"
    | "ready"
    | "running"
    | "verifying"
    | "completed"
    | "rolled-back"
    | "failed"
    | "ignored";

export type MaintenanceRisk = "low" | "medium" | "high" | "critical";

export interface MaintenanceTask {
    id: string;
    type: MaintenanceTaskType;
    target: string; // The package or config name
    currentVersion?: string;
    targetVersion?: string;
    status: MaintenanceTaskStatus;
    risk: MaintenanceRisk;
    transactionId?: string; // ID of the transaction executing this task
    simulationBranchId?: string; // ID of the simulation branch
    description: string;
    createdAt: number;
    updatedAt: number;
}

export interface DependencyInfo {
    name: string;
    currentVersion: string;
    source: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'git' | 'local';
    type: 'direct' | 'transitive' | 'dev' | 'peer';
    usedBy: string[]; // List of dependents (files, plugins, etc.)
    lastVerified: number;
    securityAdvisories?: { id: string; severity: string; url: string }[];
}

export interface MaintenanceException {
    target: string;
    scope: 'global' | 'project';
    ignoreUntil?: number; // Timestamp
    reason: string;
}

export interface MaintenanceReport {
    timestamp: number;
    detectedCount: number;
    tasks: MaintenanceTask[];
    overallRisk: MaintenanceRisk;
    recommendations: string[];
}
