export interface SLO {
    id: string;
    name: string;
    indicator: 'availability' | 'successful_request_rate' | 'p50_latency' | 'p95_latency' | 'tool_success_rate' | 'automation_success_rate';
    target: number;
    windowMs: number; // e.g., 24 hours
    dimensions?: Record<string, string>;
}

export interface SLOResult {
    sloId: string;
    actual: number;
    status: 'PASS' | 'WARN' | 'FAIL';
    errorBudgetTotal: number;
    errorBudgetRemaining: number;
    policyState: 'normal' | 'caution' | 'stability-first' | 'freeze';
}

export class SLOSystem {
    private static slos: SLO[] = [];

    public static register(slo: SLO) {
        this.slos.push(slo);
    }

    public static evaluate(sloId: string, currentActualValue: number): SLOResult | null {
        const slo = this.slos.find(s => s.id === sloId);
        if (!slo) return null;

        // Simplified for % based targets where higher is better (e.g. 99.5%)
        // Or lower is better for latency (e.g. 5000ms)
        const isHigherBetter = slo.indicator.includes('rate') || slo.indicator === 'availability';
        
        let pass = false;
        let warn = false;
        
        if (isHigherBetter) {
            pass = currentActualValue >= slo.target;
            warn = !pass && currentActualValue >= slo.target * 0.99; // Within 1% of target
        } else {
            pass = currentActualValue <= slo.target;
            warn = !pass && currentActualValue <= slo.target * 1.1; // Within 10% of target latency
        }

        let status: 'PASS' | 'WARN' | 'FAIL' = 'FAIL';
        if (pass) status = 'PASS';
        else if (warn) status = 'WARN';

        // Error Budget Calculation (Simplified)
        let errorBudgetTotal = 0;
        let errorBudgetRemaining = 0;
        if (isHigherBetter) {
            errorBudgetTotal = 100 - slo.target;
            errorBudgetRemaining = currentActualValue > slo.target ? errorBudgetTotal : (100 - currentActualValue);
            // Math here is naive, in reality it's based on total requests. 
            // We'll normalize it to a 0-100% remaining of the budget.
            const consumed = (slo.target - currentActualValue) / (100 - slo.target);
            errorBudgetRemaining = Math.max(0, 100 - (consumed * 100));
        }

        let policyState: SLOResult['policyState'] = 'normal';
        if (errorBudgetRemaining < 1) policyState = 'freeze';
        else if (errorBudgetRemaining < 25) policyState = 'stability-first';
        else if (errorBudgetRemaining < 50) policyState = 'caution';

        if (status === 'PASS') policyState = 'normal';

        return {
            sloId,
            actual: currentActualValue,
            status,
            errorBudgetTotal,
            errorBudgetRemaining,
            policyState
        };
    }
}
