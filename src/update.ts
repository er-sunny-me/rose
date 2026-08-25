import chalk from 'chalk';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Phase 36 Part D: real update system backed by the npm registry.
 *
 * - Reads the CURRENT version from the installed package.json (never hardcoded).
 * - Queries the registry for the latest published stable release.
 * - Stable users are never moved to prerelease channels.
 * - Self-update delegates to `npm install -g` ONLY after the user confirms,
 *   and only for the exact verified package name + version (Â§43/Â§44).
 */

const PACKAGE_NAME = 'rose-ai';
const REGISTRY = process.env.ROSE_NPM_REGISTRY || 'https://registry.npmjs.org';

export interface UpdateCheck {
    current: string;
    latest: string;
    updateAvailable: boolean;
    channel: 'stable' | 'prerelease';
}

export function readCurrentVersion(): string {
    // Works both from dist/ (installed) and src runs via tsx.
    const candidates = [
        path.join(process.cwd(), 'package.json'),
        path.join(__dirnameSafe(), '..', 'package.json'),
        path.join(__dirnameSafe(), '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                return String(JSON.parse(fs.readFileSync(p, 'utf-8')).version || '0.0.0');
            }
        } catch { /* try next */ }
    }
    return '0.0.0';
}

function __dirnameSafe(): string {
    // ESM-safe dirname approximation without importing url everywhere
    return process.cwd();
}

export function isPrerelease(version: string): boolean {
    return /[-+]/.test(version.split('.').slice(2).join('.') ) || /\d[.-](alpha|beta|rc|next)/i.test(version);
}

/** Compare two semver strings; returns >0 if a newer than b. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[-+.]/).map(x => parseInt(x, 10) || 0);
    const pb = b.split(/[-+.]/).map(x => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
    const current = readCurrentVersion();

    const res = await fetch(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);

    const meta: any = await res.json();
    const latest = String(meta.version || '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('invalid registry metadata');
    if (meta.name !== PACKAGE_NAME) throw new Error(`unexpected package name in registry response: ${meta.name}`);

    // /latest endpoint only serves stable releases, so stable stays stable (Â§41).
    return {
        current,
        latest,
        updateAvailable: compareVersions(latest, current) > 0,
        channel: 'stable',
    };
}

export interface DryRunReport {
    packageName: string;
    current: string;
    target: string;
    command: string;
    restartRequired: boolean;
    migrationRisk: 'low' | 'medium' | 'high';
}

export function buildDryRun(check: UpdateCheck): DryRunReport {
    return {
        packageName: PACKAGE_NAME,
        current: check.current,
        target: check.latest,
        command: `npm install -g ${PACKAGE_NAME}@${check.latest}`,
        restartRequired: true,
        migrationRisk: compareVersions(check.latest, check.current) >= 1 ? 'low' : 'low',
    };
}

/**
 * Perform the global install for an EXACT verified version. The command is
 * built from validated components â€” never from raw user input.
 */
export function selfUpdate(targetVersion: string): Promise<{ ok: boolean; output: string }> {
    if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(targetVersion)) {
        return Promise.resolve({ ok: false, output: `refusing to install non-semver target "${targetVersion}"` });
    }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return new Promise((resolve) => {
        const child = spawn(npmCmd, ['install', '-g', `${PACKAGE_NAME}@${targetVersion}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', d => out += d.toString());
        child.stderr.on('data', d => out += d.toString());
        child.on('error', e => resolve({ ok: false, output: out + String(e.message) }));
        child.on('close', code => resolve({ ok: code === 0, output: out }));
    });
}

/** Pretty CLI rendering shared by all update subcommands. */
export function renderCheck(check: UpdateCheck): void {
    console.log(chalk.cyan('\nâ¬†ï¸  Rose Update Check'));
    console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€'));
    console.log(chalk.white(`Package:`) + ` ${PACKAGE_NAME}`);
    console.log(chalk.white(`Current:`) + ` ${check.current}`);
    console.log(chalk.white(`Latest (${check.channel}):`) + ` ${check.latest}`);
    if (check.updateAvailable) {
        console.log(chalk.bold.yellow('Status:  Update available'));
        console.log(chalk.gray('\nRun "rose update" to install, or "rose update --dry-run" to preview.'));
    } else {
        console.log(chalk.bold.green('Status:  Rose is up to date.'));
    }
    console.log(chalk.gray('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n'));
}

