export interface PerformanceBaseline {
    operation: string;
    metric: 'latency' | 'cpu' | 'memory' | 'cost';
    p50: number;
    p95: number;
    sampleSize: number;
    lastUpdated: number;
}

export interface RegressionEvent {
    operation: string;
    metric: string;
    baselineValue: number;
    currentValue: number;
    degradationPercent: number;
    timestamp: number;
}

export class PerformanceEngine {
    private static baselines: Map<string, PerformanceBaseline> = new Map();

    public static updateBaseline(operation: string, metric: 'latency' | 'cpu' | 'memory' | 'cost', value: number) {
        const key = `${operation}:${metric}`;
        let b = this.baselines.get(key);
        if (!b) {
            b = { operation, metric, p50: value, p95: value, sampleSize: 1, lastUpdated: Date.now() };
        } else {
            // Exponential moving average for simple dynamic baseline
            const alpha = 0.1;
            b.p50 = (b.p50 * (1 - alpha)) + (value * alpha);
            
            // Very naive p95 tracking for illustration
            if (value > b.p50) {
                b.p95 = (b.p95 * 0.95) + (value * 0.05);
            }
            b.sampleSize++;
            b.lastUpdated = Date.now();
        }
        this.baselines.set(key, b);
    }

    public static detectRegression(operation: string, metric: 'latency' | 'cpu' | 'memory' | 'cost', currentValue: number): RegressionEvent | null {
        const key = `${operation}:${metric}`;
        const b = this.baselines.get(key);
        if (!b || b.sampleSize < 10) return null; // Not enough data to call regression

        // Higher is worse for these metrics
        const thresholdMultiplier = 1.5; // 50% degradation
        
        if (currentValue > b.p95 * thresholdMultiplier) {
            return {
                operation,
                metric,
                baselineValue: b.p95,
                currentValue,
                degradationPercent: ((currentValue - b.p95) / b.p95) * 100,
                timestamp: Date.now()
            };
        }
        return null;
    }
}
