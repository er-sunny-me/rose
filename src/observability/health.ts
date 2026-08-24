export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'offline';

export interface ComponentHealth {
    componentId: string;
    componentType: 'agent' | 'worker' | 'provider' | 'model' | 'tool' | 'mcp' | 'automation' | 'goal' | 'subsystem' | 'federatedAgent';
    state: HealthState;
    signals: {
        availability?: number;
        errorRate?: number;
        latencyP95?: number;
        queueDepth?: number;
        resourcePressure?: number;
        recentFailures?: number;
        sloStatus?: 'pass' | 'fail' | 'warning';
    };
    lastUpdated: number;
}

export class HealthMonitor {
    private static components: Map<string, ComponentHealth> = new Map();

    public static updateHealth(id: string, type: ComponentHealth['componentType'], signals: Partial<ComponentHealth['signals']>) {
        const existing = this.components.get(id) || {
            componentId: id,
            componentType: type,
            state: 'unknown',
            signals: {},
            lastUpdated: Date.now()
        };

        existing.signals = { ...existing.signals, ...signals };
        existing.lastUpdated = Date.now();
        existing.state = this.calculateState(existing.signals);
        
        this.components.set(id, existing);
    }

    private static calculateState(signals: ComponentHealth['signals']): HealthState {
        if (signals.errorRate !== undefined && signals.errorRate > 0.5) return 'unhealthy';
        if (signals.availability !== undefined && signals.availability === 0) return 'offline';
        if (signals.sloStatus === 'fail') return 'unhealthy';
        
        if (signals.errorRate !== undefined && signals.errorRate > 0.1) return 'degraded';
        if (signals.resourcePressure !== undefined && signals.resourcePressure > 0.9) return 'degraded';
        if (signals.sloStatus === 'warning') return 'degraded';

        return 'healthy';
    }

    public static getHealth(id: string): ComponentHealth | undefined {
        return this.components.get(id);
    }

    public static getAllHealth(): ComponentHealth[] {
        return Array.from(this.components.values());
    }
}
