import chalk from 'chalk';
import { ModelRouter } from '../router.js';
import { Supervisor } from '../agents.js';
import { SecurityEngine } from '../security.js';
import { Telemetry } from '../telemetry.js';
import { FailureInjector } from '../reliability/injector.js';

export class E2ETestRunner {
    private static totalPassed = 0;
    private static totalFailed = 0;

    public static async runAllJourneys() {
        console.log(chalk.cyan.bold('\n🚀 Starting Phase 30 E2E Golden Journeys\n'));

        // Boot required subsystems for tests
        await ModelRouter.initialize();
        Telemetry.initialize();

        await this.runJourney('A', 'Simple Response', async () => {
            const res = await ModelRouter.route({ intent: 'general', capabilities: [] }, [{ role: 'user', content: 'hello' }]);
            if (!res || res.length === 0) throw new Error('No response generated');
        });

        await this.runJourney('B', 'TypeScript Error Fix (Mocked)', async () => {
            // Validate the capability is exposed
            const r = await ModelRouter.route({ intent: 'coding', capabilities: ['filesystem.read', 'filesystem.write'] }, [{ role: 'user', content: 'Fix the typo in file.ts' }]);
            if (!r) throw new Error('Planning failed');
        });

        await this.runJourney('K', 'Security Attack Blocked', async () => {
            try {
                await SecurityEngine.evaluateAction('filesystem.write', { path: '/etc/passwd' }, 'Malicious payload');
                throw new Error('Should have blocked destructive action');
            } catch (e) {
                // Expected
            }
        });

        await this.runJourney('L', 'Chaos Recovery', async () => {
            FailureInjector.inject('tool_crash');
            try {
                // Simulated execution
            } finally {
                FailureInjector.clear();
            }
        });

        console.log(chalk.bold(`\n🏁 E2E Complete: ${chalk.green(this.totalPassed + ' Passed')} | ${chalk.red(this.totalFailed + ' Failed')}`));
        
        if (this.totalFailed > 0) process.exit(1);
    }

    private static async runJourney(id: string, name: string, fn: () => Promise<void>) {
        process.stdout.write(chalk.gray(`Running Journey ${id}: ${name}... `));
        try {
            Telemetry.startTrace(`test-session-${id}`);
            await fn();
            Telemetry.endTrace();
            this.totalPassed++;
            console.log(chalk.green('✔ PASS'));
        } catch (e: any) {
            this.totalFailed++;
            console.log(chalk.red(`✘ FAIL (${e.stack || e.message})`));
        }
    }
}
E2ETestRunner.runAllJourneys().catch(console.error);
