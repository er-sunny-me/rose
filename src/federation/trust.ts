import { FederatedAgent, AgentIdentity } from './identity.js';
import fs from 'fs';
import path from 'path';

export class TrustRegistry {
    private static agents: Map<string, FederatedAgent> = new Map();
    private static REGISTRY_FILE = path.join(process.cwd(), '.gemini', 'federation_trust.json');

    public static initialize() {
        if (fs.existsSync(this.REGISTRY_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.REGISTRY_FILE, 'utf8'));
                this.agents = new Map(Object.entries(data));
            } catch (e) {
                console.error('Failed to load trust registry:', e);
            }
        }
    }

    private static save() {
        fs.writeFileSync(this.REGISTRY_FILE, JSON.stringify(Object.fromEntries(this.agents), null, 2));
    }

    public static registerOrUpdate(identity: AgentIdentity, endpoint: string): FederatedAgent {
        let agent = this.agents.get(identity.agentId);
        
        if (!agent) {
            agent = {
                id: identity.agentId,
                identity,
                endpoint,
                status: 'online',
                trust: 'unknown',
                capabilities: [],
                lastSeen: Date.now()
            };
            this.agents.set(identity.agentId, agent);
        } else {
            agent.identity = identity;
            agent.endpoint = endpoint;
            agent.status = 'online';
            agent.lastSeen = Date.now();
        }
        
        this.save();
        return agent;
    }

    public static getAgent(agentId: string): FederatedAgent | undefined {
        return this.agents.get(agentId);
    }

    public static setTrust(agentId: string, trust: 'unknown' | 'pending' | 'trusted' | 'restricted' | 'blocked' | 'revoked') {
        const agent = this.agents.get(agentId);
        if (agent) {
            agent.trust = trust;
            if (trust === 'revoked' || trust === 'blocked') {
                agent.status = 'offline'; // conceptually block interaction
            }
            this.save();
        }
    }

    public static getAllAgents(): FederatedAgent[] {
        return Array.from(this.agents.values());
    }

    public static isTrusted(agentId: string): boolean {
        const agent = this.agents.get(agentId);
        return !!agent && (agent.trust === 'trusted' || agent.trust === 'restricted');
    }
}
