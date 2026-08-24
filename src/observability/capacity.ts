import os from 'os';

export interface ResourceCapacity {
    workersTotal: number;
    workersBusy: number;
    cpuPercent: number;
    memoryPercent: number;
    queueDepth: number;
    modelQuotaPercent?: number;
    timestamp: number;
}

export interface ResourceForecast {
    resource: string;
    currentUtilization: number;
    growthRatePerHour: number;
    estimatedSaturationHours?: number;
    confidence: 'high' | 'medium' | 'low';
}

export class CapacityEngine {
    private static history: ResourceCapacity[] = [];

    public static recordCapacity(cap: Omit<ResourceCapacity, 'timestamp' | 'cpuPercent' | 'memoryPercent'>) {
        const memoryPercent = (os.totalmem() - os.freemem()) / os.totalmem() * 100;
        const cpus = os.cpus();
        let cpuPercent = 0;
        // Naive CPU calc for illustration
        if (cpus && cpus.length > 0) {
            cpuPercent = 50; // Mocked for now, proper calculation requires interval sampling
        }

        const fullCap: ResourceCapacity = {
            ...cap,
            cpuPercent,
            memoryPercent,
            timestamp: Date.now()
        };

        this.history.push(fullCap);
        if (this.history.length > 1000) this.history.shift();
    }

    public static forecastQueueSaturation(): ResourceForecast {
        if (this.history.length < 2) {
            return { resource: 'queue', currentUtilization: 0, growthRatePerHour: 0, confidence: 'low' };
        }

        const first = this.history[0];
        const last = this.history[this.history.length - 1];
        
        const hoursDiff = (last.timestamp - first.timestamp) / (1000 * 60 * 60);
        if (hoursDiff < 0.1) { // Need at least some time gap
            return { resource: 'queue', currentUtilization: last.queueDepth, growthRatePerHour: 0, confidence: 'low' };
        }

        const queueGrowth = last.queueDepth - first.queueDepth;
        const growthRatePerHour = queueGrowth / hoursDiff;

        // Say max healthy queue is 100
        const maxHealthyQueue = 100;
        
        let estimatedSaturationHours: number | undefined = undefined;
        if (growthRatePerHour > 0) {
            const remaining = maxHealthyQueue - last.queueDepth;
            if (remaining > 0) {
                estimatedSaturationHours = remaining / growthRatePerHour;
            }
        }

        return {
            resource: 'queue',
            currentUtilization: last.queueDepth,
            growthRatePerHour,
            estimatedSaturationHours,
            confidence: hoursDiff > 1 ? 'high' : 'medium'
        };
    }
}
