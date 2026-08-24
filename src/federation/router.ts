import { TrustRegistry } from './trust.js';
import { CapabilityNegotiator } from './capabilities.js';

export class FederatedAgentRouter {
    public static findBestAgent(task: string, requiredCapabilities: string[]): string | null {
        const agents = TrustRegistry.getAllAgents();
        
        // Filter by trust and status
        const available = agents.filter(a => 
            a.status === 'online' && 
            (a.trust === 'trusted' || a.trust === 'restricted')
        );

        // Filter by capabilities
        const capable = available.filter(a => {
            const offered = a.capabilities.map(c => c.id);
            return CapabilityNegotiator.isCompatible(requiredCapabilities, offered);
        });

        if (capable.length === 0) return null;

        // Simple scoring: prioritize 'trusted' over 'restricted'
        capable.sort((a, b) => {
            if (a.trust === 'trusted' && b.trust !== 'trusted') return -1;
            if (a.trust !== 'trusted' && b.trust === 'trusted') return 1;
            return 0;
        });

        return capable[0].id;
    }
}
