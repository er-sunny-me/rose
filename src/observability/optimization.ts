export interface OptimizationCandidate {
    id: string;
    target: string;
    problem: string;
    proposal: string;
    expectedBenefit?: unknown;
    expectedRisk?: unknown;
    evidenceIds?: string[];
    simulationId?: string;
    status: 'candidate' | 'simulating' | 'recommended' | 'approved' | 'applied' | 'rejected';
}

export class OptimizationEngine {
    private static candidates: OptimizationCandidate[] = [];

    public static propose(candidate: Omit<OptimizationCandidate, 'id' | 'status'>): string {
        const id = `opt-${Date.now()}`;
        this.candidates.push({
            ...candidate,
            id,
            status: 'candidate'
        });
        return id;
    }

    public static getCandidates(): OptimizationCandidate[] {
        return this.candidates;
    }

    public static setStatus(id: string, status: OptimizationCandidate['status']) {
        const cand = this.candidates.find(c => c.id === id);
        if (cand) {
            cand.status = status;
        }
    }
}
