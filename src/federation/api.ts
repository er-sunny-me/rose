import { Router } from 'express';
import { IdentityManager } from './identity.js';
import { TrustRegistry } from './trust.js';
import { DelegationManager, DelegationGrant } from './delegation.js';

export const federationRouter = Router();

// Step 4 & 5: Handshake & Version negotiation
federationRouter.post('/hello', (req, res) => {
    const remoteIdentity = req.body.identity;
    if (!remoteIdentity) {
        return res.status(400).json({ error: 'Missing identity in handshake' });
    }

    const localIdentity = IdentityManager.getIdentity();
    
    // Register or update trust registry as pending/unknown (Default from plan)
    TrustRegistry.registerOrUpdate(remoteIdentity, req.ip || 'unknown');

    res.json({
        identity: localIdentity,
        acceptedProtocol: 'v1'
    });
});

// Step 9 & 10: Delegation Request
federationRouter.post('/delegate', (req, res) => {
    const { grant, payload } = req.body;
    
    if (!grant || !payload) {
        return res.status(400).json({ error: 'Missing grant or payload' });
    }

    const remoteAgent = TrustRegistry.getAgent(grant.issuerAgentId);
    if (!remoteAgent) {
        return res.status(401).json({ error: 'Unknown agent identity' });
    }

    if (!TrustRegistry.isTrusted(remoteAgent.id)) {
        return res.status(403).json({ error: 'Agent is not trusted for delegation' });
    }

    if (!remoteAgent.identity.publicIdentity) {
        return res.status(401).json({ error: 'Missing public key for verification' });
    }

    const isValid = DelegationManager.verifyGrant(grant, remoteAgent.identity.publicIdentity);
    if (!isValid) {
        return res.status(403).json({ error: 'Invalid or expired delegation grant signature' });
    }

    // Pass to local execution engine wrapped in the scope of the grant
    // (Actual execution integration would hook into TaskExecutor here)
    
    res.json({
        requestId: grant.tokenId,
        status: 'accepted',
        message: 'Delegation accepted and queued'
    });
});

// Step 11: Heartbeat
federationRouter.post('/heartbeat', (req, res) => {
    const { agentId } = req.body;
    if (agentId) {
        const agent = TrustRegistry.getAgent(agentId);
        if (agent) {
            agent.lastSeen = Date.now();
            agent.status = 'online';
        }
    }
    res.json({ status: 'alive' });
});

// Step 15: Remote cancellation
federationRouter.post('/cancel', (req, res) => {
    const { payload, signature } = req.body;
    if (!payload || !signature) {
        return res.status(400).json({ error: 'Missing payload or signature' });
    }

    try {
        const payloadStr = JSON.stringify(payload);
        const remoteAgent = TrustRegistry.getAgent(payload.requesterId);
        if (!remoteAgent || !remoteAgent.identity.publicIdentity) {
            return res.status(401).json({ error: 'Unknown or unverifiable agent' });
        }

        const isValid = IdentityManager.verify(payloadStr, signature, remoteAgent.identity.publicIdentity);
        if (!isValid) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // Pass to local TaskExecutor to cancel
        // TaskExecutor.cancel(payload.requestId);

        res.json({ status: 'cancelled' });
    } catch (e) {
        res.status(500).json({ error: 'Cancellation failed' });
    }
});

// Step 16: Status query
federationRouter.get('/status', (req, res) => {
    const requestId = req.query.requestId as string;
    if (!requestId) {
        return res.status(400).json({ error: 'Missing requestId' });
    }
    
    // Query actual local task status
    // const status = TaskExecutor.getStatus(requestId);
    const status = 'running'; // Mock

    res.json({ status });
});
