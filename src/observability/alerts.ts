export interface ObservabilityAlert {
    id: string;
    type: 'slo_breach' | 'error_budget_low' | 'dependency_failure' | 'queue_saturation' | 'budget_threshold' | 'security_event' | 'remote_agent_outage';
    message: string;
    severity: 'info' | 'warning' | 'critical';
    timestamp: number;
    correlationId?: string; // For deduplication
}

export class AlertSystem {
    private static alerts: ObservabilityAlert[] = [];

    public static fire(type: ObservabilityAlert['type'], severity: ObservabilityAlert['severity'], message: string, correlationId?: string) {
        // Deduplication: if an alert with the same type & correlationId fired recently (e.g., 5 mins), ignore it
        if (correlationId) {
            const recent = this.alerts.find(a => 
                a.type === type && 
                a.correlationId === correlationId &&
                Date.now() - a.timestamp < 5 * 60 * 1000
            );
            if (recent) return; // Deduplicated
        }

        const alert: ObservabilityAlert = {
            id: `alt-${Date.now()}`,
            type,
            message,
            severity,
            timestamp: Date.now(),
            correlationId
        };

        this.alerts.push(alert);
        
        // Feed into RCA System as incident candidate if critical
        if (severity === 'critical') {
            // RCAEngine.reportSymptom(...)
        }
    }

    public static getAlerts(): ObservabilityAlert[] {
        return this.alerts;
    }
}
