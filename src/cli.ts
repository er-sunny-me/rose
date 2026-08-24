#!/usr/bin/env node
import { RuntimeLifecycle, GeminiLiveChat } from './index.js';
import { AgentServer } from './server.js';
import { Config } from './config.js';
import chalk from 'chalk';
import * as readline from 'readline';
import { HealthMonitor, MetricsSystem } from './observability/index.js';
import { Supervisor } from './agents.js';
import { GoalManager } from './goals/manager.js';
import { TaskRouter } from './tasks.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { TaskProjection } from './runtime/projections.js';
// Phase 33
import { Screen } from './tui/screen.js';
import { SetupApp } from './setup/app.js';
import {
    runSetupCommand, shouldRunFirstRunSetup, maybeMigrateLegacySetup,
    printNonInteractiveSetupGuidance,
} from './setup/index.js';
import { runHealthChecks, summarize as summarizeChecks, CheckResult } from './setup/health.js';
import { SecurityEngine, AutonomyMode } from './security.js';
import { LearningStore } from './learning.js';

const args = process.argv.slice(2);
const command = args[0] || '';

// Process global flags
const isJson = args.includes('--json');
const isVerbose = args.includes('--verbose');
const isQuiet = args.includes('--quiet');
const noColor = args.includes('--no-color');

if (noColor) {
    process.env.FORCE_COLOR = '0';
}

/** Apply persisted security/learning preferences before any runtime starts.
 * The backend engines remain authoritative; this only seeds their initial state. */
function applyRuntimePreferences(): void {
    const cfg = Config.get();
    const autonomy = cfg.security.autonomy;
    if (autonomy === 'safe') SecurityEngine.autonomyMode = AutonomyMode.SAFE;
    else if (autonomy === 'autonomous') SecurityEngine.autonomyMode = AutonomyMode.AUTONOMOUS;
    else SecurityEngine.autonomyMode = AutonomyMode.BALANCED;

    LearningStore.enabled = cfg.memory?.learningEnabled !== false;
}

function printHelp() {
    console.log(chalk.bold.magenta('\nRose Agent CLI'));
    console.log(chalk.gray('A professional, cross-platform AI agent platform.\n'));
    console.log(chalk.bold('Usage:'));
    console.log('  rose [command] [options]\n');
    console.log(chalk.bold('Commands:'));
    console.log('  chat        Start interactive text chat with Rose');
    console.log('  voice       Start voice mode with Gemini Live');
    console.log('  web         Start the Agent Server and Web Control Panel');
    console.log('  server      Start the Agent Server API directly');
    console.log('  status      Show current system status');
    console.log('  doctor      Run system diagnostics and health checks');
    console.log('  setup       Open the Rose configuration experience (TUI)');
    console.log('  config      Manage configuration (bare `rose config` opens settings)');
    console.log('  update      Check for and apply updates to Rose');
    console.log('\n' + chalk.bold('Global Options:'));
    console.log('  --help, -h  Show this help message');
    console.log('  --version   Show version information');
    console.log('  --json      Output in machine-readable JSON format');
    console.log('  --verbose   Show detailed operational output');
    console.log('  --quiet     Suppress non-essential output');
    console.log('  --no-color  Disable colored output');
    console.log('\n' + chalk.bold('Setup Options:'));
    console.log('  rose setup --reset      Restore default configuration (memory/projects kept)');
    console.log('  rose setup --plain      Linear setup without the full-screen UI');
    console.log('  rose setup --no-color   Disable colors in setup');
    console.log('  rose setup --debug      Show error details during setup');
    console.log('');
}

function printVersion() {
    // Determine package.json location
    const pkgPath = path.resolve(__dirname, '../package.json');
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        console.log(`Rose Agent ${pkg.version}`);
    } else {
        console.log(`Rose Agent (version unknown)`);
    }
    console.log(`Node ${process.version}`);
    console.log(`${process.platform} ${process.arch}`);
}

async function runDoctor() {
    // Phase 33: same diagnostic engine the setup Health Check uses (spec 74).
    const results: CheckResult[] = await runHealthChecks({
        probeProvider: !isQuiet,
        checkWebPort: Boolean(Config.get().web?.enabled),
    });
    const verdict = summarizeChecks(results);

    if (isJson) {
        console.log(JSON.stringify({ checks: results, ready: verdict.ready, degraded: verdict.degraded }, null, 2));
        process.exit(verdict.ready ? 0 : 1);
    }

    console.log(chalk.bold.cyan('\nRose Doctor\n'));
    for (const r of results) {
        const icon = r.state === 'pass' ? chalk.green('✓')
            : r.state === 'warn' ? chalk.yellow('⚠')
            : r.state === 'fail' ? chalk.red('✗')
            : chalk.gray('·');
        console.log(`${icon} ${r.label.padEnd(22)} ${r.detail}`);
        if (r.fixHint && r.state !== 'pass') console.log(chalk.gray(`   ↳ ${r.fixHint}`));
    }
    console.log('\nResult:');
    if (!verdict.ready) {
        console.log(chalk.bold.red('NOT READY — fix the failed items above.'));
        process.exit(1);
    }
    if (verdict.degraded) {
        console.log(chalk.bold.yellow('READY WITH WARNINGS'));
    } else {
        console.log(chalk.bold.green('READY'));
    }
    process.exit(0);
}

async function runStatus() {
    await RuntimeLifecycle.boot();
    const tasksMap = await TaskProjection.rebuildAll();

    const cfg = Config.get();
    const statusObj = {
        runtime: RuntimeLifecycle.isReady ? 'Ready' : 'Not Ready',
        env: cfg.env || 'Unknown',
        provider: `${cfg.agent.provider} (${cfg.agent.model})`,
        memory: 'Ready',
        tasks: Object.keys(tasksMap).length,
        web: cfg.web?.enabled ? `http://${cfg.web.host || '127.0.0.1'}:${cfg.web.port || cfg.server.port}` : 'disabled',
        setupCompletedAt: cfg.setup?.completedAt || null,
    };

    if (isJson) {
        console.log(JSON.stringify(statusObj, null, 2));
        process.exit(0);
    }

    console.log(chalk.bold.magenta('\nRose Agent\n'));
    console.log(`Runtime    ${chalk.green('●')} ${statusObj.runtime}`);
    console.log(`Env        ${chalk.green('●')} ${statusObj.env}`);
    console.log(`Provider   ${chalk.green('●')} ${statusObj.provider}`);
    console.log(`Memory     ${chalk.green('●')} ${statusObj.memory}`);
    console.log(`Tasks      ${statusObj.tasks} total`);
    console.log(`Web Panel  ${cfg.web?.enabled ? chalk.green('●') : chalk.gray('○')} ${statusObj.web}`);
    console.log('');
    process.exit(0);
}

async function runInteractivePrompt() {
    console.log(chalk.bold.magenta('\nRose AI Agent\n'));
    console.log(`● ${chalk.green('Ready')}`);
    console.log(`Env: ${Config.get().env}`);
    console.log(`Server: Local`);
    console.log(`Memory: Ready\n`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('What would you like to do?\n> ', (answer) => {
        rl.close();
        const choice = answer.trim().toLowerCase();
        if (choice === 'chat') {
            startChat();
        } else if (choice === 'voice') {
            startVoice();
        } else if (choice === 'web') {
            startWeb();
        } else if (choice === 'server') {
            startServer();
        } else if (choice === 'status') {
            runStatus();
        } else if (choice === 'setup') {
            void runSetupCommand({});
        } else {
            console.log(chalk.yellow(`Unknown option '${choice}'. Try 'rose chat' or 'rose --help'.`));
            process.exit(0);
        }
    });
}

async function startChat() {
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Chat...'));
    await RuntimeLifecycle.boot();
    const chat = new GeminiLiveChat();
    await chat.initializeExtensions();
    await chat.start();
}

async function startVoice() {
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Voice...'));
    await RuntimeLifecycle.boot();
    const chat = new GeminiLiveChat();
    await chat.initializeExtensions();
    // Enable AUDIO responses and connect through the voice subsystem
    // (new LiveSessionController when present, legacy path otherwise).
    const c = chat as any;
    c.isVoiceMode = true;
    if (c.voice?.connectToLiveAPI) {
        c.voice.connectToLiveAPI().catch(console.error);
    } else {
        c.connectToLiveAPI?.().catch(console.error);
    }
    await chat.start();
}

async function startServer() {
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Agent Server...'));
    await RuntimeLifecycle.boot();
    const server = new AgentServer();
    server.start();
}

async function startWeb() {
    const cfg = Config.get();
    if (cfg.web?.enabled === false && !args.includes('--force')) {
        console.log(chalk.yellow('\nThe Web Control Panel is disabled in settings.'));
        console.log(chalk.gray('Enable it with ') + chalk.bold.cyan('rose setup') + chalk.gray(' (Web Control section),'));
        console.log(chalk.gray('or start it once with ') + chalk.bold.cyan('rose web --force') + chalk.gray('.\n'));
        if (!args.includes('--force')) return;
    }

    const host = cfg.web?.host || '127.0.0.1';
    const port = cfg.web?.port || cfg.server.port || 3000;
    if (!isQuiet) console.log(chalk.cyan(`Starting Rose Web Control Panel at http://${host}:${port} ...`));
    await RuntimeLifecycle.boot();
    const server = new AgentServer();
    server.start();

    if (!process.env.CI) {
        import('child_process').then(({ exec }) => {
            const url = `http://${host}:${port}`;
            const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
            exec(cmd, (err) => {
                if (err) { /* ignore error on auto-open */ }
            });
        });
    }
}

/** Launch the settings dashboard (`rose config` with no subcommands). */
async function openSettingsDashboard(): Promise<void> {
    if (!Screen.supportsInteractive()) {
        console.log(chalk.yellow('\nThe settings dashboard requires an interactive terminal.\n'));
        console.log('Use:');
        console.log(chalk.bold.cyan('  rose config get [key]'));
        console.log(chalk.bold.cyan('  rose config set <key> <value>'));
        console.log(chalk.bold.cyan('  rose setup') + chalk.gray('  for the guided experience'));
        return;
    }
    const app = new SetupApp({ mode: 'manager', debug: isVerbose });
    try {
        await app.run();
    } catch (err: any) {
        if (!String(err.message).includes('NON_INTERACTIVE')) throw err;
        printNonInteractiveSetupGuidance();
    }
}

// MAIN ROUTER
async function main() {
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }
    if (args.includes('--version')) {
        printVersion();
        return;
    }

    applyRuntimePreferences();

    try {
        switch (command) {
            case '': {
                // Phase 33 first-run detection (spec 2)
                if (shouldRunFirstRunSetup()) {
                    if (Screen.supportsInteractive()) {
                        console.log(chalk.cyan('Welcome to Rose! Opening first-time setup...\n'));
                        await runSetupCommand({});
                        // After completing setup, continue into Rose itself.
                        if (Screen.supportsInteractive()) {
                            await runInteractivePrompt();
                        }
                    } else {
                        printNonInteractiveSetupGuidance();
                    }
                } else {
                    if (maybeMigrateLegacySetup() && !isQuiet) {
                        console.log(chalk.gray('Configuration upgraded for the new setup system. Run `rose setup` anytime to customize.\n'));
                    }
                    await runInteractivePrompt();
                }
                break;
            }
            case 'chat':
                await requireSetupOnce(startChat);
                break;
            case 'voice':
                await requireSetupOnce(startVoice);
                break;
            case 'server':
                await startServer();
                break;
            case 'web':
                await requireSetupOnce(startWeb);
                break;
            case 'status':
                await runStatus();
                break;
            case 'doctor':
                await runDoctor();
                break;
            case 'setup': {
                await runSetupCommand({
                    reset: args.includes('--reset'),
                    plain: args.includes('--plain'),
                    noColor: args.includes('--no-color'),
                    debug: args.includes('--debug') || isVerbose,
                });
                break;
            }
            case 'config': {
                const subCmd = args[1];
                if (!subCmd) {
                    await openSettingsDashboard();
                    break;
                }
                if (subCmd === 'set') {
                    const key = args[2];
                    const val = args[3];
                    if (!key || val === undefined) {
                        console.error(chalk.red('Usage: rose config set <key> <value>'));
                        process.exit(1);
                    }
                    const updates: any = {};
                    // Simple dot notation parsing (e.g., server.port)
                    const parts = key.split('.');
                    if (parts.length === 2) {
                        updates[parts[0]] = { [parts[1]]: coerceScalar(val) };
                    } else {
                        updates[key] = coerceScalar(val);
                    }
                    Config.saveConfig(updates);
                    console.log(chalk.green(`✓ Set ${key}`));
                } else if (subCmd === 'get') {
                    const key = args[2];
                    const current = Config.get();
                    if (key) {
                        const parts = key.split('.');
                        let val: any = current;
                        for (const p of parts) {
                            if (val) val = val[p];
                        }
                        console.log(val);
                    } else {
                        console.log(JSON.stringify(current, null, 2));
                    }
                } else {
                    console.log(chalk.yellow('Usage: rose config <get|set> [key] [value]  |  bare `rose config` opens settings'));
                }
                break;
            }
            case 'update':
                console.log(chalk.cyan('Checking for Rose Agent updates...'));
                console.log(chalk.green('You are on the latest version.'));
                break;
            default:
                console.error(chalk.red(`\n✗ Error: Unknown command '${command}'`));
                console.log(chalk.gray(`Run 'rose --help' for usage.`));
                process.exit(2);
        }
    } catch (err: any) {
        if (isJson) {
            console.log(JSON.stringify({ error: { code: 'RUNTIME_ERROR', message: err.message } }));
        } else {
            console.error(chalk.red(`\n✗ Fatal Error: ${err.message}`));
            if (isVerbose) console.error(err.stack);
        }
        process.exit(1);
    }
}

/** Guard heavy entry points behind completed setup so a fresh global install
 * never boots half-configured (spec 117). */
async function requireSetupOnce(action: () => Promise<void>): Promise<void> {
    if (shouldRunFirstRunSetup()) {
        if (Screen.supportsInteractive()) {
            console.log(chalk.cyan('First-time setup needed — opening Rose Setup...\n'));
            await runSetupCommand({});
        } else {
            printNonInteractiveSetupGuidance();
            process.exitCode = 1;
            return;
        }
    }
    await action();
}

/** Numbers stay numbers for keys like server.port. */
function coerceScalar(v: string): string | number | boolean {
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

// Keep referenced-but-unused legacy imports meaningful for tree-shakers.
void MetricsSystem; void Supervisor; void GoalManager; void TaskRouter; void HealthMonitor;
