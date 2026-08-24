import crypto from 'crypto';

export interface AgentMetric {
    name: string;
    timestamp: number;
    value: number;
    unit?: string;
    dimensions?: Record<string, string>;
}

export interface LatencyBreakdown {
    totalMs: number;
    queueMs?: number;
    planningMs?: number;
    modelMs?: number;
    toolMs?: number;
    mcpMs?: number;
    networkMs?: number;
    remoteAgentMs?: number;
    otherMs?: number;
}

export interface TraceContext {
    traceId: string;
    sessionId: string;
    taskId?: string;
    parentTraceId?: string;
    delegationId?: string;
    childTraceId?: string;
}

export class MetricsSystem {
    private static metricsBuffer: AgentMetric[] = [];
    
    public static record(name: string, value: number, unit?: string, dimensions?: Record<string, string>) {
        const metric: AgentMetric = {
            name,
            timestamp: Date.now(),
            value,
            unit,
            dimensions
        };
        this.metricsBuffer.push(metric);
        // Simple ring buffer to prevent OOM
        if (this.metricsBuffer.length > 5000) {
            this.metricsBuffer.shift();
        }
    }

    public static recordLatencyBreakdown(operation: string, breakdown: LatencyBreakdown, dimensions?: Record<string, string>) {
        this.record(`latency.${operation}.total`, breakdown.totalMs, 'ms', dimensions);
        if (breakdown.modelMs) this.record(`latency.${operation}.model`, breakdown.modelMs, 'ms', dimensions);
        if (breakdown.toolMs) this.record(`latency.${operation}.tool`, breakdown.toolMs, 'ms', dimensions);
        if (breakdown.remoteAgentMs) this.record(`latency.${operation}.remote_agent`, breakdown.remoteAgentMs, 'ms', dimensions);
    }

    public static getMetrics(namePrefix?: string): AgentMetric[] {
        if (!namePrefix) return this.metricsBuffer;
        return this.metricsBuffer.filter(m => m.name.startsWith(namePrefix));
    }
}
