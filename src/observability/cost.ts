export interface CostRecord {
    id: string;
    targetId: string; // Task ID, Goal ID, Agent ID, etc.
    targetType: 'task' | 'goal' | 'agent' | 'model' | 'provider' | 'remote_agent';
    costAmount: number;
    currency: string;
    timestamp: number;
}

export interface Budget {
    id: string;
    targetType: 'task' | 'goal' | 'agent' | 'provider' | 'daily' | 'monthly';
    targetId: string; // e.g. "goal-123" or "daily-global"
    limitAmount: number;
    currency: string;
}

export class CostEngine {
    private static costs: CostRecord[] = [];
    private static budgets: Budget[] = [];

    public static recordCost(targetId: string, targetType: CostRecord['targetType'], amount: number, currency: string = 'USD') {
        if (amount === undefined || isNaN(amount)) return; // "unknown" cost

        this.costs.push({
            id: crypto.randomUUID(),
            targetId,
            targetType,
            costAmount: amount,
            currency,
            timestamp: Date.now()
        });
    }

    public static setBudget(budget: Budget) {
        const existingIndex = this.budgets.findIndex(b => b.targetType === budget.targetType && b.targetId === budget.targetId);
        if (existingIndex >= 0) {
            this.budgets[existingIndex] = budget;
        } else {
            this.budgets.push(budget);
        }
    }

    public static getBudgetStatus(targetType: Budget['targetType'], targetId: string): { limit: number; spent: number; remaining: number; percentageUsed: number } | null {
        const budget = this.budgets.find(b => b.targetType === targetType && b.targetId === targetId);
        if (!budget) return null;

        const spent = this.costs
            .filter(c => c.targetType === targetType && c.targetId === targetId)
            .reduce((sum, c) => sum + c.costAmount, 0);

        return {
            limit: budget.limitAmount,
            spent,
            remaining: Math.max(0, budget.limitAmount - spent),
            percentageUsed: (spent / budget.limitAmount) * 100
        };
    }

    /** Phase 36: aggregated spend view for the dashboard (never raw secrets). */
    public static getSummary(): {
        records: CostRecord[];
        budgets: Array<Budget & { status?: ReturnType<typeof CostEngine.getBudgetStatus> }>;
        totalsByTargetType: Record<string, number>;
    } {
        const totalsByTargetType: Record<string, number> = {};
        for (const r of this.costs) {
            totalsByTargetType[r.targetType] = (totalsByTargetType[r.targetType] || 0) + r.costAmount;
        }
        return {
            records: [...this.costs],
            budgets: this.budgets.map(b => ({ ...b, status: this.getBudgetStatus(b.targetType, b.targetId) ?? undefined })),
            totalsByTargetType,
        };
    }}


