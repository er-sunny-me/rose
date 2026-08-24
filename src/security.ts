import path from 'path';
import chalk from 'chalk';
import * as readline from 'readline';
import crypto from 'crypto';
import { GlobalSecurityInvariant } from './reliability/invariants.js';
import { PolicyEngine } from './policy/engine.js';
import { IdentityContext } from './policy/models.js';

export async function confirmAction(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(chalk.yellow(`\n⚠️  PERMISSION REQUIRED: ${message} (y/N) `), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export enum ActionRisk {
    READ = "READ",
    WRITE = "WRITE",
    EXECUTE = "EXECUTE",
    EXTERNAL_ACTION = "EXTERNAL_ACTION",
    DESTRUCTIVE = "DESTRUCTIVE",
    SENSITIVE = "SENSITIVE",
    SYSTEM = "SYSTEM"
}

export enum AutonomyMode {
    SAFE = "safe",
    BALANCED = "balanced",
    AUTONOMOUS = "autonomous"
}

export class SecurityEngine {
    public static autonomyMode: AutonomyMode = AutonomyMode.BALANCED;
    public static workspaceRoot: string = process.cwd();

    private static pendingApprovals: Map<string, { expiresAt: number }> = new Map();

    public static async evaluateAction(toolName: string, args: any, rawPromptContext?: string, identity?: IdentityContext): Promise<{ allowed: boolean, risk: ActionRisk, message: string }> {
        const risk = this.classifyAction(toolName, args);
        let requiresConfirmation = this.doesRequireConfirmation(risk);
        
        // Log Audit
        console.log(chalk.gray(`[AUDIT] Tool: ${toolName} | Risk: ${risk}`));

        let blocked = false;
        if (rawPromptContext && rawPromptContext.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')) {
            blocked = true;
        }
        GlobalSecurityInvariant.recordAttempt(blocked);

        if (!this.validatePathBoundaries(toolName, args) || blocked) {
            const msg = blocked ? `Security Block: Adversarial prompt detected.` : `Security Block: Action attempted to traverse outside the allowed workspace (${this.workspaceRoot}).`;
            console.log(chalk.red(`[SECURITY] ${msg}`));
            return { allowed: false, risk, message: msg };
        }

        // Policy Engine Governance Gate
        if (identity) {
            const resourceStr = args.command || args.path || args.query || '';
            const policyDecision = await PolicyEngine.evaluate(toolName, resourceStr, identity);
            
            if (policyDecision.decision === 'DENY') {
                const msg = `Policy Blocked: ${policyDecision.reasons.join(' ')}`;
                console.log(chalk.red(`[SECURITY] ${msg}`));
                return { allowed: false, risk, message: msg };
            }
            if (policyDecision.decision === 'CONFIRM') {
                requiresConfirmation = true;
            }
        }

        if (requiresConfirmation) {
            const approvalKey = `${toolName}:${JSON.stringify(args)}`;
            const existing = this.pendingApprovals.get(approvalKey);
            if (existing && existing.expiresAt > Date.now()) {
                this.pendingApprovals.delete(approvalKey);
                return { allowed: true, risk, message: "Approved." };
            }

            console.log(chalk.yellow(`\n[SECURITY] The agent wants to execute a ${risk} action.`));
            console.log(chalk.cyan(`Tool: ${toolName}`));
            console.log(chalk.cyan(`Args: ${JSON.stringify(args, null, 2)}`));
            
            const allowed = await confirmAction(`Allow this action?`);
            if (allowed) {
                // To prevent infinite loops we execute immediately since this is synchronous to execution
                // We don't really need the expiration logic here if we block the thread, but we add it if needed later
                console.log(chalk.green(`[SECURITY] Action approved by user.`));
                return { allowed: true, risk, message: "Approved." };
            } else {
                console.log(chalk.red(`[SECURITY] Action denied by user.`));
                return { allowed: false, risk, message: "Action denied by user." };
            }
        }

        return { allowed: true, risk, message: "Allowed by policy." };
    }

    private static classifyAction(toolName: string, args: any): ActionRisk {
        if (toolName === 'execute_command') {
            const cmd = (args.command || '').toLowerCase();
            if (/(rm|del|format|format-volume|clear-recyclebin|remove-item) /i.test(cmd)) return ActionRisk.DESTRUCTIVE;
            if (/(git push|curl -x post)/i.test(cmd)) return ActionRisk.EXTERNAL_ACTION;
            if (/(npm start|npm test|npm run|tsc|node)/i.test(cmd)) return ActionRisk.EXECUTE;
            return ActionRisk.SYSTEM; // Default shell execution is highly privileged
        }
        if (toolName === 'save_memory') return ActionRisk.WRITE;
        if (toolName === 'search_memory') return ActionRisk.READ;
        if (toolName === 'service_email' && args.action === 'send_email') return ActionRisk.EXTERNAL_ACTION;
        if (toolName === 'service_calendar' && (args.action === 'create_event' || args.action === 'cancel_event')) return ActionRisk.WRITE;
        if (toolName.startsWith('service_')) return ActionRisk.READ;
        
        if (toolName.startsWith('mcp_')) {
            // Assume MCP writes/external unless known read
            return ActionRisk.EXTERNAL_ACTION;
        }

        return ActionRisk.READ;
    }

    private static doesRequireConfirmation(risk: ActionRisk): boolean {
        if (risk === ActionRisk.DESTRUCTIVE || risk === ActionRisk.EXTERNAL_ACTION || risk === ActionRisk.SENSITIVE) {
            return true;
        }
        if (risk === ActionRisk.SYSTEM || risk === ActionRisk.WRITE) {
            return this.autonomyMode === AutonomyMode.SAFE;
        }
        return false;
    }

    private static validatePathBoundaries(toolName: string, args: any): boolean {
        // Simple check to prevent path traversals in commands
        if (toolName === 'execute_command') {
            const cmd = args.command || "";
            if (cmd.includes('../') || cmd.includes('..\\')) {
                // Deny upward traversal
                return false;
            }
            if (cmd.toLowerCase().includes('c:\\windows')) {
                return false;
            }
        }
        return true;
    }

    public static redactSecrets(text: string): string {
        if (typeof text !== 'string') return text;
        // Redact potential tokens
        let redacted = text.replace(/(ghp|sk|xox[pboa]|AIza)[a-zA-Z0-9_-]{20,}/g, '[REDACTED_SECRET]');
        // Redact apparent bearer tokens
        redacted = redacted.replace(/Bearer [a-zA-Z0-9_\-\.]{20,}/g, 'Bearer [REDACTED_SECRET]');
        // Strip env output that looks like secrets
        redacted = redacted.replace(/[A-Z0-9_]*TOKEN[A-Z0-9_]*\s*=\s*.+/g, 'TOKEN=[REDACTED_SECRET]');
        redacted = redacted.replace(/[A-Z0-9_]*KEY[A-Z0-9_]*\s*=\s*.+/g, 'KEY=[REDACTED_SECRET]');
        return redacted;
    }
}

// Publish the workspace boundary to the command sandbox (Phase 34).
import { setWorkspaceBoundary } from './security/sandbox.js';
setWorkspaceBoundary(SecurityEngine.workspaceRoot);
