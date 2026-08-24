export type IncidentSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved' | 'closed';
export type HypothesisStatus = 'candidate' | 'supported' | 'rejected' | 'inconclusive' | 'confirmed';

export interface IncidentEvent {
    timestamp: number;
    description: string;
}

export interface RootCauseHypothesis {
    id: string;
    symptom: string;
    cause: string;
    evidenceIds: string[];
    supportingEdges?: string[];
    contradictingEvidenceIds?: string[];
    confidence?: number;
    status: HypothesisStatus;
}

export interface Incident {
    id: string;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    symptoms: string[];
    hypotheses: RootCauseHypothesis[];
    rootCause?: string;
    timeline: IncidentEvent[];
    actions: string[];
    createdAt: number;
    updatedAt: number;
}
