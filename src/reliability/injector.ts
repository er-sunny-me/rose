export type FailureType = 
    | 'model_timeout'
    | 'model_malformed'
    | 'provider_outage'
    | 'tool_timeout'
    | 'tool_crash'
    | 'tool_malformed'
    | 'mcp_disconnect'
    | 'worker_crash'
    | 'network_delay'
    | 'federation_timeout';

export class FailureInjector {
    private static activeFailures: Set<FailureType> = new Set();
    private static isTestModeActive: boolean = false;

    public static enableTestMode() {
        this.isTestModeActive = true;
    }

    public static disableTestMode() {
        this.isTestModeActive = false;
        this.clear();
    }

    public static inject(failure: FailureType) {
        if (!this.isTestModeActive) return; // Safeguard
        this.activeFailures.add(failure);
    }

    public static clear() {
        this.activeFailures.clear();
    }

    public static isActive(failure: FailureType): boolean {
        if (!this.isTestModeActive) return false;
        return this.activeFailures.has(failure);
    }

    // Helper functions for common delays
    public static async applyNetworkDelayIfActive() {
        if (this.isActive('network_delay')) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}
