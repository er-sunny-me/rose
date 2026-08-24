import fs from 'fs';
import path from 'path';
import { PolicyAsCode, CapabilityGrant } from './models.js';

export class PolicyStore {
    private static policies: Map<string, PolicyAsCode> = new Map();
    private static activeGrants: Map<string, CapabilityGrant> = new Map();
    private static policyDir = path.join(process.cwd(), '.gemini', 'policies');

    public static init() {
        if (!fs.existsSync(this.policyDir)) fs.mkdirSync(this.policyDir, { recursive: true });
        this.loadPolicies();
    }

    private static loadPolicies() {
        if (!fs.existsSync(this.policyDir)) return;
        const files = fs.readdirSync(this.policyDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const p = JSON.parse(fs.readFileSync(path.join(this.policyDir, file), 'utf8'));
                this.policies.set(p.id, p as PolicyAsCode);
            } catch (e) {
                console.error(`Failed to load policy ${file}`, e);
            }
        }
    }

    public static getPolicy(id: string): PolicyAsCode | undefined {
        return this.policies.get(id);
    }

    public static getAllPolicies(): PolicyAsCode[] {
        return Array.from(this.policies.values());
    }

    public static addPolicy(policy: PolicyAsCode) {
        this.policies.set(policy.id, policy);
        if (!fs.existsSync(this.policyDir)) fs.mkdirSync(this.policyDir, { recursive: true });
        fs.writeFileSync(path.join(this.policyDir, `${policy.id}.json`), JSON.stringify(policy, null, 2));
    }

    public static issueGrant(grant: CapabilityGrant) {
        this.activeGrants.set(grant.id, grant);
    }

    public static revokeGrant(id: string) {
        this.activeGrants.delete(id);
    }

    public static getActiveGrants(): CapabilityGrant[] {
        return Array.from(this.activeGrants.values()).filter(g => !g.expiresAt || g.expiresAt > Date.now());
    }
}
