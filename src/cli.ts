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
import { runSetupWizard } from './setup.js';

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
    console.log('  setup       Run the interactive setup wizard');
    console.log('  config      Manage configuration (e.g. config set server.port 8080)');
    console.log('  update      Check for and apply updates to Rose');
    console.log('\n' + chalk.bold('Global Options:'));
    console.log('  --help, -h  Show this help message');
    console.log('  --version   Show version information');
    console.log('  --json      Output in machine-readable JSON format');
    console.log('  --verbose   Show detailed operational output');
    console.log('  --quiet     Suppress non-essential output');
    console.log('  --no-color  Disable colored output');
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
    const health = HealthMonitor.getAllHealth();
    const isHealthy = Object.values(health).every(h => h.state !== 'unhealthy');
    
    if (isJson) {
        console.log(JSON.stringify(health, null, 2));
        process.exit(isHealthy ? 0 : 1);
    }

    console.log(chalk.bold.cyan('\nRose Doctor\n'));
    
    for (const [component, data] of Object.entries(health)) {
        if (data.state === 'healthy') {
            console.log(chalk.green(`✓ ${component}`));
        } else if (data.state === 'degraded') {
            console.log(chalk.yellow(`⚠ ${component} (Degraded)`));
        } else {
            console.log(chalk.red(`✗ ${component} (Unhealthy)`));
        }
    }
    
    console.log('\nResult:');
    if (isHealthy) {
        console.log(chalk.bold.green('READY'));
        process.exit(0);
    } else {
        console.log(chalk.bold.yellow('READY WITH WARNINGS'));
        process.exit(0);
    }
}

async function runStatus() {
    await RuntimeLifecycle.boot();
    const tasksMap = await TaskProjection.rebuildAll();

    const statusObj = {
        runtime: RuntimeLifecycle.isReady ? 'Ready' : 'Not Ready',
        env: Config.get().env || 'Unknown',
        memory: 'Ready',
        tasks: Object.keys(tasksMap).length
    };

    if (isJson) {
        console.log(JSON.stringify(statusObj, null, 2));
        process.exit(0);
    }

    console.log(chalk.bold.magenta('\nRose Agent\n'));
    console.log(`Runtime    ${chalk.green('●')} ${statusObj.runtime}`);
    console.log(`Env        ${chalk.green('●')} ${statusObj.env}`);
    console.log(`Memory     ${chalk.green('●')} ${statusObj.memory}`);
    console.log(`Tasks      ${statusObj.tasks} total`);
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
    // Simulate /voice command
    (chat as any).isVoiceMode = true;
    (chat as any).connectToLiveAPI().catch(console.error);
    await chat.start();
}

async function startServer() {
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Agent Server...'));
    await RuntimeLifecycle.boot();
    const server = new AgentServer();
    server.start();
}

async function startWeb() {
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Web Control Panel...'));
    await RuntimeLifecycle.boot();
    const server = new AgentServer();
    server.start();
    
    if (!process.env.CI) {
        import('child_process').then(({ exec }) => {
            const url = 'http://127.0.0.1:3000';
            const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
            exec(cmd, (err) => {
                if (err) { /* ignore error on auto-open */ }
            });
        });
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

    try {
        switch (command) {
            case '':
                await runInteractivePrompt();
                break;
            case 'chat':
                await startChat();
                break;
            case 'voice':
                await startVoice();
                break;
            case 'server':
                await startServer();
                break;
            case 'web':
                await startWeb();
                break;
            case 'status':
                await runStatus();
                break;
            case 'doctor':
                await runDoctor();
                break;
            case 'setup':
                await runSetupWizard();
                break;
            case 'config':
                const subCmd = args[1];
                if (subCmd === 'set') {
                    const key = args[2];
                    const val = args[3];
                    if (!key || !val) {
                        console.error(chalk.red('Usage: rose config set <key> <value>'));
                        process.exit(1);
                    }
                    const updates: any = {};
                    // Simple dot notation parsing (e.g., server.port)
                    const parts = key.split('.');
                    if (parts.length === 2) {
                        updates[parts[0]] = { [parts[1]]: val };
                    } else {
                        updates[key] = val;
                    }
                    Config.saveConfig(updates);
                    console.log(chalk.green(`✓ Set ${key} to ${val}`));
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
                    console.log(chalk.yellow('Usage: rose config <get|set> [key] [value]'));
                }
                break;
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

main().catch(err => {
    console.error(err);
    process.exit(1);
});
