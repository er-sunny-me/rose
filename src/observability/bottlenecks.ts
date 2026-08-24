import { CapacityEngine } from './capacity.js';
import { MetricsSystem } from './metrics.js';

export interface BottleneckEvent {
    primaryBottleneck: string;
    secondarySymptoms: string[];
    severity: 'low' | 'medium' | 'high' | 'critical';
    detectedAt: number;
}

export class BottleneckAnalyzer {
    public static analyze(): BottleneckEvent | null {
        // Detect bottleneck dynamically based on capacity and metrics
        const qForecast = CapacityEngine.forecastQueueSaturation();
        
        const metrics = MetricsSystem.getMetrics();
        const mcpLatencyMetrics = metrics.filter(m => m.name.includes('latency') && m.name.includes('mcp'));
        
        let highMcpLatency = false;
        if (mcpLatencyMetrics.length > 0) {
            const avg = mcpLatencyMetrics.reduce((a, b) => a + b.value, 0) / mcpLatencyMetrics.length;
            if (avg > 1500) highMcpLatency = true; // >1.5s
        }

        if (qForecast.growthRatePerHour > 0 && highMcpLatency) {
            // Queue grows -> Workers busy -> MCP latency increases -> Tasks remain longer
            return {
                primaryBottleneck: 'MCP Latency',
                secondarySymptoms: ['Queue growth', 'Worker saturation'],
                severity: 'high',
                detectedAt: Date.now()
            };
        }

        return null;
    }
}
