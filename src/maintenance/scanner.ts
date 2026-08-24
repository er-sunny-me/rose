import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import { DependencyInfo, MaintenanceTask, MaintenanceRisk } from './models.js';
import { WorldModel } from '../world/model.js';

export class MaintenanceScanner {
    private static ignoredPackages: string[] = [];

    public static async scanDependencies(workspaceRoot: string): Promise<MaintenanceTask[]> {
        console.log(chalk.blue(`[MaintenanceScanner] Scanning dependencies in ${workspaceRoot}...`));
        const tasks: MaintenanceTask[] = [];

        // 1. Detect package manager
        let source: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm';
        if (fs.existsSync(path.join(workspaceRoot, 'pnpm-lock.yaml'))) source = 'pnpm';
        else if (fs.existsSync(path.join(workspaceRoot, 'yarn.lock'))) source = 'yarn';
        else if (fs.existsSync(path.join(workspaceRoot, 'bun.lockb'))) source = 'bun';

        // 2. Read package.json
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            console.log(chalk.yellow(`[MaintenanceScanner] No package.json found at ${pkgPath}`));
            return tasks;
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        // 3. (Mocked) Check for outdated versions and security advisories
        // In reality, this would run `npm outdated --json` or `npm audit --json`
        for (const [name, currentVersion] of Object.entries(deps)) {
            if (this.ignoredPackages.includes(name)) continue;

            const isDev = !!(pkg.devDependencies && pkg.devDependencies[name]);
            
            // Generate some mock tasks for testing purposes
            if (name === 'chalk' || name.startsWith('dummy-outdated')) {
                const targetVersion = name === 'chalk' ? '5.0.0' : '2.0.0'; // mock
                const risk: MaintenanceRisk = name.startsWith('dummy') ? 'medium' : 'low';

                const task: MaintenanceTask = {
                    id: crypto.randomBytes(4).toString('hex'),
                    type: 'dependency-update',
                    target: name,
                    currentVersion: String(currentVersion),
                    targetVersion,
                    status: 'detected',
                    risk,
                    description: `Update ${name} from ${currentVersion} to ${targetVersion}`,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                tasks.push(task);
                console.log(chalk.yellow(`[MaintenanceScanner] Detected outdated dependency: ${name} (${currentVersion} -> ${targetVersion})`));
            }
        }

        return tasks;
    }

    public static getDependencyImpact(packageName: string): string[] {
        // Query the Phase 24 Dependency Graph
        const forwardDeps = WorldModel.getForwardDependencies(packageName);
        return forwardDeps.map(edge => edge.to);
    }
}
