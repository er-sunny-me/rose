export type PolicyDecisionResult = 'ALLOW' | 'DENY' | 'CONFIRM' | 'ALLOW-LIMITED' | 'EVALUATING';

export interface IdentityContext {
    actor: string; // The user, or component that initiated the request
    executor: string; // The agent or worker doing the work
    trustDomain: 'TRUSTED_CORE' | 'TRUSTED_USER_CODE' | 'RESTRICTED_PLUGIN' | 'UNTRUSTED_MCP' | 'TEST_SANDBOX' | 'FEDERATED_REMOTE';
    environment?: string; // e.g., 'development', 'production'
}

export interface PolicyDecision {
    decision: PolicyDecisionResult;
    reasons: string[];
    policyId?: string;
    constraints?: {
        maxFiles?: number;
        maxNetworkRequests?: number;
        timeoutMs?: number;
    };
}

export interface CapabilityGrant {
    id: string;
    capability: string; // e.g. 'filesystem.write', 'network.access'
    scope: string; // e.g. workspace path, or url
    taskId?: string; // Optional task scoping
    expiresAt?: number; 
}

export interface PolicyAsCode {
    id: string;
    description: string;
    subject: {
        type: 'agent' | 'user' | 'system' | 'global';
        id?: string;
    };
    capabilities: string[];
    scope: {
        workspace?: string;
        network?: 'allow' | 'deny';
    };
    restrictions: {
        destructive: 'deny' | 'confirm';
        untrusted: 'deny' | 'confirm';
    };
}
