import { IdentityContext, PolicyDecision, PolicyAsCode } from './models.js';
import { PolicyStore } from './store.js';
import path from 'path';

export class PolicyEngine {
    public static async evaluate(
        action: string, // e.g. 'filesystem.write'
        resource: string, // e.g. 'C:\foo\bar' or 'command string'
        context: IdentityContext
    ): Promise<PolicyDecision> {
        
        let decision: PolicyDecision = { decision: 'ALLOW', reasons: [] };

        // 1. Identity validation (No privilege escalation via spoofing)
        if (context.executor === 'research-agent' && action === 'execute_command') {
            return { decision: 'DENY', reasons: ['Research agent strictly denied terminal execution.'], policyId: 'hard-boundary' };
        }

        // 2. Trust Domain boundaries
        if (context.trustDomain === 'UNTRUSTED_MCP' && (action === 'execute_command' || action === 'filesystem.write')) {
            return { decision: 'DENY', reasons: ['UNTRUSTED_MCP cannot execute local side effects.'], policyId: 'hard-boundary' };
        }
        if (context.trustDomain === 'FEDERATED_REMOTE' && this.isDestructive(action, resource)) {
            return { decision: 'DENY', reasons: ['FEDERATED_REMOTE cannot execute destructive side effects.'], policyId: 'federation-boundary' };
        }

        // 3. Load policies for the actor/executor
        const policies = PolicyStore.getAllPolicies();
        
        for (const policy of policies) {
            // Very simple evaluation: check if action matches and policy restricts it
            const applies = policy.subject.type === 'global' || policy.subject.id === context.executor;
            if (!applies) continue;

            if (policy.restrictions.destructive === 'deny' && this.isDestructive(action, resource)) {
                return { decision: 'DENY', reasons: [`Policy ${policy.id} denies destructive actions.`], policyId: policy.id };
            }
            if (policy.restrictions.destructive === 'confirm' && this.isDestructive(action, resource)) {
                decision = { decision: 'CONFIRM', reasons: [`Policy ${policy.id} requires confirmation for destructive actions.`], policyId: policy.id };
            }
            if (policy.scope.network === 'deny' && action.startsWith('service_')) {
                return { decision: 'DENY', reasons: [`Policy ${policy.id} denies network access.`], policyId: policy.id };
            }
        }

        // 4. Temporary capability grants overrides
        const grants = PolicyStore.getActiveGrants();
        for (const grant of grants) {
            if (grant.capability === action) {
                // E.g., user approved a specific grant
                decision = { decision: 'ALLOW', reasons: [`Temporary grant ${grant.id} allows action.`] };
            }
        }

        return decision;
    }

    private static isDestructive(action: string, resource: string): boolean {
        if (action === 'execute_command') {
            const cmd = resource.toLowerCase();
            if (/(rm|del|format|clear-recyclebin) /i.test(cmd)) return true;
        }
        return false;
    }
}
