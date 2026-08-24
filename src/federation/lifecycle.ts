export class DelegationLifecycle {
    private static MAX_DEPTH = 3;
    
    public static validateDelegationRequest(request: { callerAgentId: string }, localAgentId: string, visitedAgents: string[]): boolean {
        if (visitedAgents.includes(localAgentId)) {
            console.error(`[Federation] Loop detected: Agent ${localAgentId} already visited.`);
            return false;
        }
        
        if (visitedAgents.length >= this.MAX_DEPTH) {
            console.error(`[Federation] Max delegation depth exceeded.`);
            return false;
        }
        
        return true;
    }
}
