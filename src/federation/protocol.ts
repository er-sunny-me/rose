import { AgentIdentity } from './identity.js';

export interface AgentMessage {
    protocolVersion: string;
    messageId: string;
    type: string;
    sender: AgentIdentity;
    receiver: string; // Target agentId
    timestamp: number;
    correlationId?: string;
    payload: any;
    signature?: string;
}

export interface DelegationRequest {
    id: string;
    callerAgentId: string;
    targetAgentId: string;
    task: string;
    capabilitiesRequired: string[];
    inputArtifacts?: string[];
    constraints?: any;
    deadline?: number;
    budget?: any;
}

export interface ArtifactReference {
    id: string;
    name: string;
    hash: string;
    type: string;
    size: number;
}

export interface VerificationResult {
    passed: boolean;
    method: string;
    details: string;
}

export interface DelegationResult {
    requestId: string;
    status: 'completed' | 'partial' | 'failed' | 'cancelled';
    summary: string;
    artifacts?: ArtifactReference[];
    evidence?: any[];
    verification?: VerificationResult;
    usage?: any;
}
