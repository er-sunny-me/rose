#!/usr/bin/env node
import { RuntimeLifecycle, GeminiLiveChat, requireProviderConfigured } from './index.js';
import { AgentServer } from './server.js';
import { Config } from './config.js';
import chalk from 'chalk';
import * as readline from 'readline';
import { HealthMonitor, MetricsSystem } from './observability/index.js';
import { Supervisor } from './agents.js';
import { GoalManager } from './goals/manager.js';
import { TaskRouter } from './tasks.js';
import fs from 'fs';
import os from 'os';
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
import fsSync from 'fs';

function PACKAGE_NAME_LABEL(): string { return 'rose-ai'; }

function savedServerFromFile(): string {
    try { return fsSync.readFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), 'utf8').trim(); } catch { return ''; }
}

let automaticMeshAgentStarted = false;

/** Start the saved PC mesh agent as part of normal long-running Rose startup. */
async function startAutomaticMeshAgent(): Promise<void> {
    if (automaticMeshAgentStarted) return;
    const serverUrl = process.env.ROSE_SERVER || savedServerFromFile();
    if (!serverUrl) return;

    const { Secrets } = await import('./security/secrets.js');
    const password = process.env.ROSE_API_TOKEN
        || await Secrets.get('mesh-api-password', Config.get().web?.token ?? undefined);
    if (!password) return;

    automaticMeshAgentStarted = true;
    const { PcMeshAgent } = await import('./mesh-client.js');
    const agent = new PcMeshAgent({
        serverUrl,
        displayName: 'PC · ' + (os.hostname?.() ?? 'this machine'),
        capabilities: ['terminal', 'filesystem', 'browser'],
        executeGoal: async (goal) => {
            const { SessionManager } = await import('./session.js');
            const session = SessionManager.createSession('mesh-' + Date.now());
            return await session.taskExecutor.executeTask(goal, goal);
        },
    });
    void agent.connect();
}

/** Phase 37: mesh REST base — ROSE_SERVER env > ~/.rose/mesh-server.txt > local AgentServer. */
function resolveMeshBase(): string {
    const envServer = process.env.ROSE_SERVER;
    let saved = '';
    try { saved = fsSync.readFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), 'utf8').trim(); } catch { /* none */ }
    const remote = envServer || saved;
    if (remote) return remote.replace(/\/$/, '') + '/api';
    return 'http://127.0.0.1:' + (Config.get().server.port || 3000) + '/api/v1';
}

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
    console.log('  tui         Start the Rose chat TUI (full-screen, shows live model info)');
    console.log('  voice       Start voice mode with Gemini Live');
    console.log('  web         Start the Agent Server and Web Control Panel');
    console.log('  server      Start the Agent Server API directly');
    console.log('  status      Show current system status');
    console.log('  doctor      Run system diagnostics and health checks');
    console.log('  setup       Open the Rose configuration experience (TUI)');
    console.log('  config      Manage configuration (bare `rose config` opens settings)');
    console.log('  agents      Agent Mesh: list/connect/inspect/revoke/remove/link/unlink/links/approve-link/capabilities/task');
  console.log('  update      Check for and apply updates to Rose');
    console.log(chalk.gray('  update --check / --dry-run'));
    console.log('  auth        Manage OS-stored credentials (status|set|remove)');
    console.log('  extensions  Verify/trust/revoke signed extensions');
    console.log('  browser     Manage saved browser sessions (sessions|logout|clear)');
    console.log('  mcp-server  Expose Rose read-only tools over MCP stdio');
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

    try {
        const { loadIdentity } = await import('./mesh-client.js');
        const id = loadIdentity();
        let serverUrl = id?.serverUrl;
        
        if (!serverUrl) {
            const fsSync = await import('fs');
            const path = await import('path');
            const serverFile = path.join(Config.getGlobalDir(), 'mesh-server.txt');
            if (fsSync.existsSync(serverFile)) {
                serverUrl = fsSync.readFileSync(serverFile, 'utf8').trim();
            }
        }

        if (serverUrl) {
            console.log(chalk.bold.magenta('\nAgent Mesh\n'));
            console.log(`Server     ${chalk.green('●')} ${serverUrl}`);
            if (id?.deviceId) {
                console.log(`Device ID  ● ${id.deviceId}`);
                if (id.agentId) console.log(`Agent ID   ● ${id.agentId}`);
            } else {
                console.log(`Status     ${chalk.yellow('○')} PC not paired yet`);
            }

            const token = process.env.ROSE_API_TOKEN || Config.get().web?.token;
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            try {
                const res = await fetch(`${serverUrl}/api/agents`, { headers, method: 'GET' });
                if (res.ok) {
                    const agents = await res.json();
                    if (Array.isArray(agents) && agents.length > 0) {
                        console.log(`\nConnected Devices (${agents.length}):`);
                        for (const a of agents) {
                            const me = a.agentId === id?.agentId ? ' (This PC)' : '';
                            const platform = a.platform ? `[${a.platform}] ` : '';
                            const dot = a.status === 'online' ? chalk.green('●') : chalk.gray('○');
                            console.log(`  ${dot} ${platform}${a.displayName || a.agentId}${me}`);
                        }
                    } else {
                        console.log(`\nConnected Devices: (0)`);
                    }
                } else {
                    console.log(`\nConnected Devices: (Failed to fetch - HTTP ${res.status})`);
                }
            } catch (e) {
                console.log(`\nConnected Devices: (Server unreachable)`);
            }
        }
    } catch (e) {
        // ignore if mesh isn't available
    }

    console.log('');
    // Delay exit slightly to allow native fetch sockets to close gracefully on Windows (fixes uv_handle_closing assert)
    setTimeout(() => process.exit(0), 20);
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
        if (choice === 'chat' || choice === 'tui') {
            void startTuiChat();
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
            console.log(chalk.yellow(`Unknown option '${choice}'. Try 'rose tui' or 'rose --help'.`));
            process.exit(0);
        }
    });
}

/** Phase 36: `rose tui` — full-screen chat TUI (replaces the old readline `rose chat`). */
async function startTuiChat() {
    requireProviderConfigured();
    if (!isQuiet) console.log(chalk.cyan('Starting Rose TUI...'));
    await RuntimeLifecycle.boot();
    await startAutomaticMeshAgent();
    const { ChatTui } = await import('./tui/chatApp.js');
    const chat = new ChatTui();
    try {
        await chat.run();
    } catch (err: any) {
        if (!String(err.message).includes('NON_INTERACTIVE')) throw err;
        console.log(chalk.yellow('\nRose TUI needs an interactive terminal.'));
        console.log(chalk.gray('Non-interactive shells can use the Web Control Panel: ') + chalk.bold.cyan('rose web'));
        process.exitCode = 1;
        return;
    }
    // `/voice` inside the TUI hands over to the voice-to-voice app directly.
    if ((chat as any).voiceRequested) {
        if (!isQuiet) console.log(chalk.cyan('Launching voice mode...\n'));
        await startVoice();
    }
    // `/opentui` hands over to the OpenTUI sandbox demo.
    if ((chat as any).openTuiRequested) {
        if (!isQuiet) console.log(chalk.cyan('Launching OpenTUI sandbox...\n'));
        const { runOpenTuiDemo } = await import('./tui/opentui-demo.js');
        await runOpenTuiDemo();
    }
}

async function startVoice() {
    requireProviderConfigured();
    if (!isQuiet) console.log(chalk.cyan('Starting Rose Voice...'));
    await RuntimeLifecycle.boot();
    await startAutomaticMeshAgent();
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
    await startAutomaticMeshAgent();
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
    await startAutomaticMeshAgent();
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

/** Humanized "how long ago" for mesh presence display. */
function relTime(ts?: number): string {
    if (!ts) return 'never';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

/** Phase 37 — `rose agents` subcommands against the local Agent Server. */
async function runAgentsCommand(rest: string[]) {
    const sub = rest[0] || 'list';
    const base = resolveMeshBase();

    const api = async (path: string, init?: RequestInit) => {
        const token = process.env.ROSE_API_TOKEN || Config.get().web?.token;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${base}${path}`, { ...init, headers });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body } as { status: number; body: any };
    };

    switch (sub) {
        case 'connect': {
            // Run THIS PC as a mesh agent: pairing + live delegation receiver.
            const serverUrl = process.env.ROSE_SERVER || rest[1] || savedServerFromFile();
            if (!serverUrl) {
                console.error(chalk.red('Usage: rose agents connect <server-url>   e.g. http://192.168.1.5:3000'));
                process.exitCode = 1;
                break;
            }
            try {
                fsSync.mkdirSync(path.join(Config.getGlobalDir(), '.'), { recursive: true });
            } catch { /* exists */ }
            const { Secrets } = await import('./security/secrets.js');
            const password = process.env.ROSE_API_TOKEN || Config.get().web?.token;
            if (!password) {
                console.error(chalk.red('Set ROSE_API_TOKEN to the mesh API password before connecting.'));
                process.exitCode = 1;
                return;
            }
            await Secrets.set('mesh-api-password', password);
            fsSync.writeFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), serverUrl);

            await RuntimeLifecycle.boot();
            const { PcMeshAgent } = await import('./mesh-client.js');
            const agent = new PcMeshAgent({
                serverUrl,
                displayName: 'PC · ' + (os.hostname?.() ?? 'this machine'),
                capabilities: ['terminal', 'filesystem', 'browser'],
                executeGoal: async (goal) => {
                    // Execute with the REAL local agent core: planner → tools → verification.
                    const { SessionManager } = await import('./session.js');
                    const session = SessionManager.createSession('mesh-' + Date.now());
                    return await session.taskExecutor.executeTask(goal, goal);
                },
            });
            console.log(chalk.bold.cyan('\n🔗 Connecting this PC to the Agent Mesh…'));
            await agent.connect();
            // Keep the process alive while the socket runs.
            await new Promise(() => {}); // connector handles Ctrl+C via SIGINT default? ensure below
            break;
        }
        case 'inspect': {
            const id = rest[1];
            if (!id) { console.error(chalk.red('Usage: rose agents inspect <agentId>')); process.exitCode = 1; return; }
            const r = await api(`/agents/${encodeURIComponent(id)}`);
            if (r.status !== 200) { console.error(chalk.red('✗ not found')); process.exitCode = 1; return; }
            const a = r.body;
            console.log(chalk.bold.cyan(`\n🔍 ${a.displayName} (${a.agentId})`));
            console.log(`  Platform : ${a.platform}`);
            console.log(`  Status   : ${a.status}   Trust: ${a.trust}`);
            console.log(`  Caps     : ${a.capabilities.join(', ') || '(none)'}`);
            console.log(`  Last seen: ${a.lastSeen ? new Date(a.lastSeen).toLocaleString() : 'never'}\n`);
            return;
        }
        case 'revoke': {
            const id = rest[1];
            if (!id) { console.error(chalk.red('Usage: rose agents revoke <agentId>')); process.exitCode = 1; return; }
            const r = await api(`/agents/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'revoke failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Revoked ${id}. The device must pair again.`));
            return;
        }
        case 'remove':
        case 'forget': {
            const id = rest[1];
            if (!id) { console.error(chalk.red('Usage: rose agents remove <agentId>')); process.exitCode = 1; return; }
            const r = await api(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'remove failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Removed ${id} from the mesh registry.`));
            return;
        }
        case 'links': {
            const r = await api('/links');
            if (r.status !== 200) { console.error(chalk.red('✗ Server unreachable or old version.')); process.exitCode = 1; return; }
            console.log(chalk.bold.cyan(`\n🔗 Agent Links (${r.body.activeLinks} active)\n`));
            for (const l of r.body.links ?? []) {
                console.log(`  ${l.state === 'linked' ? chalk.green('●') : l.state === 'pending' ? chalk.yellow('○') : chalk.gray('✕')} ${l.state.padEnd(9)} ${l.a} ↔ ${l.b}   ${chalk.gray(l.linkId)}`);
            }
            if ((r.body.links ?? []).length === 0) console.log(chalk.gray('  No links yet — use: rose agents link <agentA> <agentB>'));
            console.log();
            return;
        }
        case 'link': {
            // Admin-approved A↔B link via the trusted console.
            const a = rest[1], b = rest[2];
            if (!a || !b) { console.error(chalk.red('Usage: rose agents link <agentIdA> <agentIdB>')); process.exitCode = 1; return; }
            const r = await api('/agents/link', { method: 'POST', body: JSON.stringify({ a, b }) });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'link failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Linked ${a} ↔ ${b} (${r.body.link?.linkId})`));
            return;
        }
        case 'unlink': {
            const a = rest[1], b = rest[2];
            if (!a || !b) { console.error(chalk.red('Usage: rose agents unlink <agentIdA> <agentIdB>')); process.exitCode = 1; return; }
            const r = await api('/agents/unlink', { method: 'POST', body: JSON.stringify({ a, b }) });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'unlink failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Unlinked ${a} ↔ ${b}`));
            return;
        }
        case 'approve-link':
        case 'reject-link': {
            const linkId = rest[1];
            if (!linkId) { console.error(chalk.red(`Usage: rose agents ${sub} <linkId>`)); process.exitCode = 1; return; }
            const r = await api(`/links/${encodeURIComponent(linkId)}/${sub === 'approve-link' ? 'approve' : 'reject'}`, { method: 'POST' });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Link ${linkId} → ${r.body.link?.state}`));
            return;
        }
        case 'capabilities': {
            const id = rest[1];
            if (!id) {
                // List every agent's capability summary.
                const r = await api('/mesh');
                for (const a of r.body?.agents ?? []) {
                    console.log(`${a.displayName.padEnd(24)} caps=${(a.capabilities ?? []).length} tools=${(a.tools ?? []).length} mcp=${a.mcp ? 'yes' : 'no '} browser=${a.browser ? 'yes' : 'no '} ${a.agentId}`);
                }
                return;
            }
            const r = await api(`/agents/${encodeURIComponent(id)}/capabilities`);
            if (r.status !== 200) { console.error(chalk.red('✗ not found')); process.exitCode = 1; return; }
            const c = r.body;
            console.log(chalk.bold.cyan(`\n🧩 ${c.agentId} [${c.platform}]`));
            console.log(`  Capabilities : ${c.capabilities.join(', ') || '(none)'}`);
            console.log(`  Tools (${(c.tools ?? []).length})    : ${(c.tools ?? []).slice(0, 12).join(', ')}${(c.tools ?? []).length > 12 ? ', …' : ''}`);
            console.log(`  Skills       : ${(c.skills ?? []).join(', ') || '(none)'}`);
            console.log(`  Providers    : ${(c.providers ?? []).join(', ') || '(none)'}`);
            console.log(`  Memory       : ${(c.memoryCapabilities ?? []).join(', ')}`);
            console.log(`  Browser/MCP  : ${c.browser ? 'browser ✓' : 'no browser'} / ${c.mcp ? 'mcp ✓' : 'no mcp'}\n`);
            return;
        }
        case 'health': {
            const id = rest[1];
            const path2 = id ? `/agents/${encodeURIComponent(id)}/health` : '/mesh';
            const r = await api(path2);
            console.log(JSON.stringify(r.body, null, 2));
            return;
        }
        case 'task': {
            const id = rest[1];
            const goal = rest.slice(2).join(' ');
            if (!id || !goal) { console.error(chalk.red('Usage: rose agents task <agentId> <goal…>')); process.exitCode = 1; return; }
            const r = await api(`/agents/${encodeURIComponent(id)}/tasks`, { method: 'POST', body: JSON.stringify({ goal }) });
            if (r.status !== 200) { console.error(chalk.red('✗ ' + (r.body.error || 'delegation failed'))); process.exitCode = 1; return; }
            console.log(chalk.green(`✓ Delegated task ${r.body.taskId} → ${id}`));
            return;
        }
        default: {
            const r = await api('/mesh');
            if (r.status !== 200) { console.error(chalk.red('✗ Server unreachable — start it with `rose web` first.')); process.exitCode = 1; return; }
            const m = r.body;
            console.log(chalk.bold.magenta('\n🌐 Agent Mesh\n'));
            console.log(`  Agents: ${m.total} total · ${chalk.green(m.online + ' online')} · ${chalk.yellow(m.degraded + ' degraded')} · ${m.offline} offline`);
            for (const a of m.agents) {
                const dot = a.status === 'online' ? chalk.green('●') : a.status === 'degraded' ? chalk.yellow('⚠') : chalk.gray('○');
                console.log(`  ${dot} ${a.displayName.padEnd(24)} ${a.platform.padEnd(10)} ${a.trust.padEnd(9)} ${relTime(a.lastSeen).padEnd(9)} ${a.agentId}`);
            }
            console.log(chalk.gray('\n  connect / inspect / revoke / remove / health / task — API-password authentication required\n'));
            return;
        }
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
            case 'tui':
            case 'chat': // legacy alias — routes to the new TUI
                await requireSetupOnce(startTuiChat);
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
            case 'update': {
                // Phase 36: real npm-registry-backed update flow.
                const { checkForUpdate, renderCheck, buildDryRun, selfUpdate, readCurrentVersion } = await import('./update.js');
                const dryRun = args.includes('--dry-run');
                try {
                    const check = await checkForUpdate();
                    renderCheck(check);
                    if (args.includes('--check')) break;

                    if (!check.updateAvailable) {
                        console.log(chalk.green('Nothing to do — already on the latest stable release.'));
                        break;
                    }

                    const plan = buildDryRun(check);
                    if (dryRun) {
                        console.log(chalk.cyan('\n📋 Update Plan (dry run — nothing installed)'));
                        console.log(chalk.white(`  Target:   ${plan.target}`));
                        console.log(chalk.white(`  Command:  ${plan.command}`));
                        console.log(chalk.white(`  Restart:  ${plan.restartRequired ? 'yes — restart Rose after install' : 'no'}`));
                        console.log(chalk.white(`  Migration risk: ${plan.migrationRisk}`));
                        console.log(chalk.white(`  Preserved: OS credentials, config.json, memory/, event store\n`));
                        break;
                    }

                    console.log(chalk.yellow(`Installing ${PACKAGE_NAME_LABEL()} ${check.latest} globally...`));
                    const result = await selfUpdate(check.latest);
                    if (result.ok) {
                        console.log(chalk.green(`✓ Installed. Previous version was ${readCurrentVersion()}.`));
                        console.log(chalk.cyan('Restart Rose to load the new version, then verify with "rose doctor".'));
                        console.log(chalk.gray('If anything looks wrong: npm install -g rose-ai@' + check.current));
                    } else {
                        console.error(chalk.red('✗ Update failed. Previous installation untouched:'));
                        console.error(chalk.gray(result.output.slice(0, 800)));
                        process.exitCode = 1;
                    }
                } catch (e: any) {
                    console.error(chalk.red(`✗ Update check failed: ${e.message}`));
                    console.error(chalk.gray('Check your internet connection / registry availability.'));
                    process.exitCode = 1;
                }
                break;
            }
            case 'agents': {
                // Phase 37: Agent Mesh management (talks to the local Agent Server).
                await runAgentsCommand(args.slice(1));
                break;
            }
            case 'auth': {
                // Phase 36 Part B: secure credential management.
                const { Secrets } = await import('./security/secrets.js');
                const sub = args[1];
                if (sub === 'status') {
                    const { Config } = await import('./config.js');
                    const cfg = Config.get();
                    const rows = await Secrets.status({
                        gemini: cfg.keys?.gemini,
                        anthropic: cfg.keys?.anthropic,
                        openai: cfg.keys?.openai,
                        github: cfg.keys?.github,
                    });
                    console.log(chalk.bold.cyan('\n🔐 Credential Status'));
                    for (const r of rows) {
                        const src = r.source === 'os-store' ? chalk.green('✓ OS credential store')
                            : r.source === 'env' ? chalk.cyan('• environment variable')
                                : r.source === 'plaintext-config' ? chalk.yellow('⚠ plaintext in config (run migration)')
                                    : chalk.gray('not configured');
                        console.log(`  ${r.credential.padEnd(22)} ${src}`);
                    }
                    console.log();
                } else if (sub === 'set') {
                    const cred = args[2];
                    if (!cred) {
                        console.log(chalk.yellow('Usage: rose auth set <gemini-api-key|anthropic-api-key|openai-api-key|github-token>'));
                        console.log(chalk.gray('(value is read via hidden prompt or ROSE_SECRET_VALUE env; never passed as CLI arg)'));
                        break;
                    }
                    const value = process.env.ROSE_SECRET_VALUE || '';
                    if (!value) {
                        console.error(chalk.red('Set the value in the ROSE_SECRET_VALUE environment variable for this command.'));
                        process.exitCode = 1;
                        break;
                    }
                    await Secrets.set(cred, value);
                    console.log(chalk.green(`✓ Stored ${cred} in the OS credential store.`));
                } else if (sub === 'remove') {
                    const cred = args[2];
                    if (!cred) { console.log(chalk.yellow('Usage: rose auth remove <credential>')); break; }
                    const removed = await Secrets.remove(cred);
                    console.log(removed ? chalk.green(`✓ Removed ${cred} from the OS store.`) : chalk.yellow(`${cred} was not present in the OS store.`));
                } else {
                    console.log(chalk.bold.cyan('\nUsage: rose auth <status|set|remove> [credential]'));
                }
                break;
            }
            case 'extensions': {
                // Phase 36 Part A: provenance management.
                const sub = args[1];
                const { TrustedPublisherRegistry, generatePublisherKeyPair, canonicalDigest, verifyInstalledExtension } = await import('./extensions/signing.js');
                if (sub === 'trust') {
                    const [, , publisher, keyId] = args;
                    const keyFile = args[5] || process.env.ROSE_PUBLISHER_KEY_FILE;
                    if (!publisher || !keyId || !keyFile) {
                        console.log(chalk.yellow('Usage: rose extensions trust <publisher> <keyId> --key <publicKey.pem>'));
                        break;
                    }
                    const pem = fs.readFileSync(keyFile, 'utf-8');
                    TrustedPublisherRegistry.trust(publisher, keyId, pem);
                    console.log(chalk.green(`✓ Publisher "${publisher}" key "${keyId}" is now trusted.`));
                } else if (sub === 'revoke') {
                    const publisher = args[2];
                    if (!publisher) { console.log(chalk.yellow('Usage: rose extensions revoke <publisher> [keyId]')); break; }
                    TrustedPublisherRegistry.revoke(publisher, args[3]);
                    console.log(chalk.green(`✓ Revoked publisher "${publisher}"${args[3] ? ` key ${args[3]}` : ' (all keys)'}.`));
                } else if (sub === 'verify' || sub === 'inspect') {
                    const dir = path.resolve(args[2] || path.join(process.cwd(), 'plugins'));
                    let targets: string[] = [];
                    if (fsSync.existsSync(dir) && fsSync.statSync(dir).isDirectory()) {
                        targets = fsSync.readdirSync(dir).map(d => path.join(dir, d)).filter(d => fsSync.existsSync(path.join(d, 'extension.json')));
                    } else if (fsSync.existsSync(path.join(dir, 'extension.json'))) {
                        targets = [dir];
                    }
                    if (targets.length === 0) {
                        console.log(chalk.yellow(`No extensions found under ${dir}`));
                        break;
                    }
                    for (const t of targets) {
                        const outcome = verifyInstalledExtension(t);
                        const name = outcome.manifest?.name || path.basename(t);
                        console.log(chalk.bold.cyan(`\n📦 ${name}`));
                        console.log(`  Signature: ${outcome.ok ? chalk.green('✓ Valid') : chalk.red('✗ Invalid')} ` +
                            chalk.gray(outcome.failure ? `(${outcome.failure})` : ''));
                        console.log(`  Publisher: ${outcome.manifest?.publisher || chalk.gray('unknown')}`);
                        console.log(`  Key:       ${outcome.keyId || chalk.gray('—')}`);
                        console.log(`  Trust:     ${outcome.ok ? chalk.green('Trusted') : chalk.red('BLOCKED')}`);
                        if (outcome.packageDigest) console.log(chalk.gray(`  Digest:    ${outcome.packageDigest.slice(0, 32)}…`));
                    }
                    console.log();
                } else if (sub === 'generate-key') {
                    const pair = generatePublisherKeyPair(args[2] || 'publisher-key-1');
                    const outDir = path.join(process.cwd(), '.rose', 'keys');
                    fsSync.mkdirSync(outDir, { recursive: true });
                    fsSync.writeFileSync(path.join(outDir, `${pair.keyId}.private.pem`), pair.privateKeyPem, { mode: 0o600 });
                    fsSync.writeFileSync(path.join(outDir, `${pair.keyId}.public.pem`), pair.publicKeyPem);
                    console.log(chalk.green(`✓ Generated Ed25519 keypair "${pair.keyId}" in .rose/keys/`));
                    console.log(chalk.gray('Share ONLY the public key with users who trust your extensions.'));
                } else {
                    console.log(chalk.bold.cyan('\nUsage: rose extensions <verify|inspect|trust|revoke|generate-key> ...'));
                    console.log(chalk.gray('  verify <dir>                     check signatures'));
                    console.log(chalk.gray('  trust <publisher> <keyId>        add trusted public key (--key file)'));
                    console.log(chalk.gray('  revoke <publisher> [keyId]       block a publisher'));
                    console.log(chalk.gray('  generate-key [keyId]             create an Ed25519 publisher keypair'));
                }
                break;
            }
            case 'browser': {
                // Phase 36 Part H: session profile management.
                const sub = args[1];
                const { BrowserSessionManager } = await import('./browser/sessions.js');
                if (sub === 'sessions') {
                    const sessions = BrowserSessionManager.list();
                    if (sessions.length === 0) { console.log(chalk.gray('\nNo saved browser sessions.\n')); break; }
                    console.log(chalk.bold.cyan('\n🌐 Saved Browser Sessions'));
                    for (const s of sessions) {
                        const exp = s.expiresAt && s.expiresAt < Date.now() ? chalk.red('EXPIRED') : chalk.green('active');
                        console.log(`  ${s.profile.padEnd(12)} domains: ${s.allowedDomains.join(', ') || '(any)'} [${exp}]`);
                    }
                    console.log();
                } else if (sub === 'logout') {
                    const profile = args[2] || 'default';
                    const ok = BrowserSessionManager.clear(profile);
                    console.log(ok ? chalk.green(`✓ Cleared browser session "${profile}".`) : chalk.yellow(`No session named "${profile}".`));
                } else if (sub === 'clear') {
                    BrowserSessionManager.clearAll();
                    console.log(chalk.green('✓ All browser sessions cleared.'));
                } else {
                    console.log(chalk.bold.cyan('\nUsage: rose browser <sessions|logout|clear> [profile]'));
                }
                break;
            }
            case 'mcp-server': {
                // Phase 36 Part J: expose allowlisted read-only tools over MCP stdio.
                const { startMcpServer } = await import('./mcp-server.js');
                await startMcpServer();
                break; // serve until stdin closes
            }
            case 'tools':
            case 'capabilities':
            case 'workflows': {
                // Phase 39 — Tool Intelligence CLI (§49/§50/§89).
                const { toolIntelligence, WORKFLOWS } = await import('./intelligence/tool-intelligence.js');
                const json = args.includes('--json');
                const rest39 = args.slice(1).filter(a => a !== '--json');
                if (command === 'capabilities') {
                    const caps = await toolIntelligence.capabilities(rest39[0]);
                    if (json) { console.log(JSON.stringify(caps, null, 2)); break; }
                    console.log(chalk.bold.cyan(`\n🧩 Capabilities (${caps.length})\n`));
                    for (const c of caps) {
                        const mark = c.status === 'Ready' ? chalk.green('✓') : c.status === 'Needs setup' ? chalk.yellow('~') : '✕';
                        console.log(`  ${mark} ${c.id.padEnd(24)} ${c.status.padEnd(12)} risk=${c.risk}  ${chalk.gray(c.tools.join(', ').slice(0, 60))}`);
                    }
                    console.log();
                    break;
                }
                if (command === 'workflows') {
                    if (json) { console.log(JSON.stringify(WORKFLOWS, null, 2)); break; }
                    console.log(chalk.bold.cyan(`\n🔀 Workflows (${WORKFLOWS.length})\n`));
                    for (const w of WORKFLOWS) {
                        console.log(`  • ${w.name} (${w.id})`);
                        for (const s of w.steps) console.log(`      ${s.optional ? '(optional) ' : ''}${s.tool} — ${s.purpose}`);
                    }
                    console.log();
                    break;
                }
                const sub39 = rest39[0] ?? '';
                if (sub39 === 'search') {
                    const q = rest39.slice(1).join(' ');
                    const r = await toolIntelligence.discover({ query: q, topK: 8 });
                    if (json) { console.log(JSON.stringify(r, null, 2)); break; }
                    console.log(chalk.bold.cyan(`\n🔍 Discovery for "${q}" (intent: ${r.intent.domain})\n`));
                    for (const c of r.candidates) {
                        const gate = !c.eligible ? chalk.red(' [blocked: ' + c.ineligibleReason + ']') : c.prerequisitesMet ? '' : chalk.yellow(` [missing: ${c.missingPrerequisites.join(',')}]`);
                        console.log(`  ${c.local ? '▪' : '🌐'} ${String(c.score).padStart(3)}  ${c.toolName.padEnd(28)} ${c.capability.padEnd(18)} risk=${c.risk} health=${c.health}${gate}`);
                    }
                    if (r.workflows.length) console.log(chalk.magenta(`  workflows: ${r.workflows.map(w => w.id).join(', ')}`));
                    if (r.honestFallback) console.log(chalk.yellow(`  ⚠ ${r.honestFallback}`));
                    console.log();
                    break;
                }
                if (sub39 === 'inspect') {
                    const all = await toolIntelligence.all();
                    const m = all.find(t => t.name.toLowerCase() === rest39[1]?.toLowerCase());
                    if (!m) { console.error(chalk.red('✗ unknown tool')); process.exitCode = 1; break; }
                    if (json) { console.log(JSON.stringify(m, null, 2)); break; }
                    console.log(chalk.bold.cyan(`\n🔧 ${m.name}\n`));
                    console.log(`  Description : ${m.description}`);
                    console.log(`  Capability  : ${m.capabilities.join(', ')}`);
                    console.log(`  Use when    : ${(m.useWhen ?? []).join('; ') || '—'}`);
                    console.log(`  Avoid when  : ${(m.avoidWhen ?? []).join('; ') || '—'}`);
                    console.log(`  Prereqs     : ${(m.prerequisites ?? []).join(', ') || 'none'}`);
                    console.log(`  Risk        : ${m.risk}   Side effects: ${m.sideEffects ? m.sideEffectClass : 'read-only'}   Approval hint: ${m.requiresApproval ? 'yes' : 'no'}`);
                    console.log(`  Source      : ${m.source}`);
                    if ((m.examples ?? []).length) console.log(`  Example     : ${m.examples![0]}`);
                    console.log();
                    break;
                }
                if (sub39 === 'refresh') {
                    const n = await toolIntelligence.buildIndex(true);
                    console.log(chalk.green(`✓ Re-indexed ${n} tools.`));
                    break;
                }
                {
                    const all = await toolIntelligence.all();
                    if (json) { console.log(JSON.stringify(all, null, 2)); break; }
                    console.log(chalk.bold.cyan(`\n🔧 Tools (${all.length})\n`));
                    for (const t of all) console.log(`  ${t.risk === 'low' ? '·' : t.risk === 'critical' ? '!' : '+'} ${t.name.padEnd(30)} ${t.capabilities.join(',').padEnd(26)} ${t.source}`);
                    console.log(chalk.gray('\n  search / inspect / refresh subcommands; --json supported\n'));
                }
                break;
            }
            default:
                console.error(chalk.red(`\n? Error: Unknown command '${command}'`));
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
