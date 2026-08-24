import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { ReliabilityScenario, ScenarioResult } from './models.js';
import { FailureInjector } from './injector.js';
import { ProviderOutageScenario, AdversarialPromptScenario, PrivilegeEscalationScenario } from './scenarios.js';

export class ReliabilityLab {
    private static scenarios: ReliabilityScenario[] = [
        new ProviderOutageScenario(),
        new AdversarialPromptScenario(),
        new PrivilegeEscalationScenario()
    ];

    public static getScenarios(): ReliabilityScenario[] {
        return this.scenarios;
    }

    public static async runScenario(id: string): Promise<ScenarioResult | null> {
        const scenario = this.scenarios.find(s => s.id === id);
        if (!scenario) return null;

        console.log(chalk.cyan(`\n🧪 [ReliabilityLab] Running scenario: ${scenario.name}`));
        FailureInjector.enableTestMode();

        let result: ScenarioResult;
        try {
            await scenario.setup();
            await scenario.inject();
            await scenario.run();
            result = await scenario.verify();
        } catch (e: any) {
            result = {
                id: scenario.id,
                status: 'CRITICAL_FAILURE',
                detection: false,
                recovery: false,
                verification: false,
                violations: [e.message],
                recoveryTimeMs: 0,
                log: ['Unhandled exception during scenario execution']
            };
        } finally {
            await scenario.cleanup();
            FailureInjector.disableTestMode();
        }

        this.generateReport(result, scenario.name);
        return result;
    }

    public static async runProfile(profile: 'quick' | 'deep'): Promise<ScenarioResult[]> {
        const results: ScenarioResult[] = [];
        for (const s of this.scenarios) {
            const res = await this.runScenario(s.id);
            if (res) results.push(res);
        }
        return results;
    }

    private static generateReport(result: ScenarioResult, name: string) {
        const report = `# Reliability Report: ${name}

## Scenario
${name} (${result.id})

## Detection
${result.detection ? '✓' : '✗'} Detected failure

## Recovery
${result.recovery ? '✓' : '✗'} Recovered

## Verification
${result.verification ? '✓' : '✗'} Verified integrity

## Violations
${result.violations.length === 0 ? 'None' : result.violations.join('\n')}

## Log
${result.log.join('\n')}
`;
        const dir = path.join(process.cwd(), '.gemini', 'reliability', 'reports');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${result.id}_${Date.now()}.md`), report);
        
        console.log(chalk.green(`Report saved to .gemini/reliability/reports/`));
    }
}
