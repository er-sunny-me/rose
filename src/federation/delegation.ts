import { IdentityManager } from './identity.js';
import crypto from 'crypto';

export interface DelegationGrant {
    tokenId: string;
    targetAgentId: string;
    issuerAgentId: string;
    task: string;
    capabilities: string[];
    scope: Record<string, any>;
    issuedAt: number;
    expiresAt: number;
    signature?: string;
}

export class DelegationManager {
    public static createGrant(targetAgentId: string, task: string, capabilities: string[], scope: Record<string, any>, ttlSeconds: number = 600): DelegationGrant {
        const grant: DelegationGrant = {
            tokenId: crypto.randomUUID(),
            targetAgentId,
            issuerAgentId: IdentityManager.getAgentId(),
            task,
            capabilities,
            scope,
            issuedAt: Date.now(),
            expiresAt: Date.now() + (ttlSeconds * 1000)
        };

        const payload = `${grant.tokenId}:${grant.targetAgentId}:${grant.issuerAgentId}:${grant.task}:${grant.capabilities.join(',')}:${grant.expiresAt}`;
        grant.signature = IdentityManager.sign(payload);
        
        return grant;
    }

    public static verifyGrant(grant: DelegationGrant, issuerPublicKey: string): boolean {
        if (Date.now() > grant.expiresAt) return false;
        if (!grant.signature) return false;
        
        const payload = `${grant.tokenId}:${grant.targetAgentId}:${grant.issuerAgentId}:${grant.task}:${grant.capabilities.join(',')}:${grant.expiresAt}`;
        return IdentityManager.verify(payload, grant.signature, issuerPublicKey);
    }
}
