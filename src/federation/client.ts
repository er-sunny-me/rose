import { DelegationGrant } from './delegation.js';
import { AgentIdentity, FederatedAgent } from './identity.js';
import { IdentityManager } from './identity.js';
import { TrustRegistry } from './trust.js';

export class FederationClient {
    public static async delegateTask(targetAgentId: string, grant: DelegationGrant, payload: any): Promise<any> {
        const target = TrustRegistry.getAgent(targetAgentId);
        if (!target) throw new Error('Target agent not found in trust registry');
        if (target.trust !== 'trusted' && target.trust !== 'restricted') {
            throw new Error(`Cannot delegate to agent with trust level: ${target.trust}`);
        }

        const url = `${target.endpoint}/api/v1/federation/delegate`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant, payload })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Remote delegation failed: ${err}`);
        }

        return await response.json();
    }

    public static async cancelTask(targetAgentId: string, requestId: string): Promise<boolean> {
        const target = TrustRegistry.getAgent(targetAgentId);
        if (!target) return false;

        const payload = {
            requesterId: IdentityManager.getAgentId(),
            requestId,
            timestamp: Date.now()
        };
        const signature = IdentityManager.sign(JSON.stringify(payload));

        const url = `${target.endpoint}/api/v1/federation/cancel`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload, signature })
            });
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    public static async queryStatus(targetAgentId: string, requestId: string): Promise<string> {
        const target = TrustRegistry.getAgent(targetAgentId);
        if (!target) return 'UNKNOWN';

        const url = `${target.endpoint}/api/v1/federation/status?requestId=${requestId}`;
        try {
            const response = await fetch(url);
            if (!response.ok) return 'UNKNOWN';
            const data = await response.json() as any;
            return data.status || 'UNKNOWN';
        } catch (e) {
            return 'UNKNOWN';
        }
    }
}
