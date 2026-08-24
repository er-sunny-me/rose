export type NormalizedErrorType = 
    | 'provider_error'
    | 'tool_error'
    | 'timeout'
    | 'network_error'
    | 'policy_denied'
    | 'approval_required'
    | 'validation_error'
    | 'resource_exhausted'
    | 'worker_failure'
    | 'remote_agent_failure'
    | 'storage_error'
    | 'unknown';

export interface NormalizedError {
    type: NormalizedErrorType;
    originalError: any;
    message: string;
    timestamp: number;
    dimensions?: Record<string, string>;
}

export class ErrorTaxonomy {
    public static classify(error: any): NormalizedError {
        const msg = (error?.message || String(error)).toLowerCase();
        let type: NormalizedErrorType = 'unknown';

        if (msg.includes('timeout')) type = 'timeout';
        else if (msg.includes('network') || msg.includes('econnrefused')) type = 'network_error';
        else if (msg.includes('policy') || msg.includes('deny')) type = 'policy_denied';
        else if (msg.includes('provider') || msg.includes('429')) type = 'provider_error';
        else if (msg.includes('tool')) type = 'tool_error';
        else if (msg.includes('remote') || msg.includes('federation')) type = 'remote_agent_failure';

        return {
            type,
            originalError: error,
            message: error?.message || String(error),
            timestamp: Date.now()
        };
    }
}
