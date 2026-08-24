export type InvariantResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type ScenarioStatus = 'PASS' | 'DEGRADED' | 'RECOVERED' | 'RECOVERED_WITH_WARNING' | 'FAILED' | 'CRITICAL_FAILURE' | 'SECURITY_VIOLATION' | 'DATA_INTEGRITY_VIOLATION';

export interface ReliabilityInvariant {
    id: string;
    description: string;
    check(context: any): Promise<InvariantResult>;
}

export interface ScenarioResult {
    id: string;
    status: ScenarioStatus;
    detection: boolean;
    recovery: boolean;
    verification: boolean;
    violations: string[];
    recoveryTimeMs: number;
    log: string[];
}

export interface ReliabilityScenario {
    id: string;
    name: string;
    setup(): Promise<void>;
    inject(): Promise<void>;
    run(): Promise<void>;
    verify(): Promise<ScenarioResult>;
    cleanup(): Promise<void>;
}
