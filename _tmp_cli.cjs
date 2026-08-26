// Patch cli.ts: mesh base resolution + `rose agents connect` command.
const fs = require('fs');
let s = fs.readFileSync('src/cli.ts', 'utf8');

// 1) Helper: resolveMeshBase()
if (!s.includes('function resolveMeshBase')) {
  s = s.replace(
    "function PACKAGE_NAME_LABEL(): string { return 'rose-ai'; }",
    `function PACKAGE_NAME_LABEL(): string { return 'rose-ai'; }

/** Phase 37: mesh REST base — ROSE_SERVER env > ~/.rose/mesh-server.txt > local AgentServer. */
function resolveMeshBase(): string {
    const envServer = process.env.ROSE_SERVER;
    let saved = '';
    try { saved = fsSync.readFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), 'utf8').trim(); } catch { /* none */ }
    const target = envServer || saved || ('http://127.0.0.1:' + (Config.get().server.port || 3000));
    return target.replace(/\\/\$/, '') + '/api/v1';
}`
  );
}

// 2) runAgentsCommand: use resolveMeshBase()
s = s.replace(
  "    const base = `http://${Config.get().web?.host || '127.0.0.1'}:${Config.get().web?.port || Config.get().server.port || 3000}/api/v1`;",
  "    const base = resolveMeshBase();"
);

// 3) Add `connect` subcommand inside runAgentsCommand switch
s = s.replace(
  "        case 'pair': {",
  `        case 'connect': {
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
            fsSync.writeFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), serverUrl);

            await RuntimeLifecycle.boot();
            const { PcMeshAgent } = await import('./mesh-client.js');
            const agent = new PcMeshAgent({
                serverUrl,
                displayName: 'PC · ' + (os.hostname?.() ?? 'this machine'),
                capabilities: ['terminal', 'filesystem', 'browser'],
                executeGoal: async (goal) => {
                    // Execute with the REAL local agent core (planner + tools).
                    const chat = new GeminiLiveChat();
                    const executor = (chat as any).taskExecutor;
                    const result = await executor.executeTask(goal, goal);
                    return typeof result === 'string' ? result : String(result);
                },
            });
            console.log(chalk.bold.cyan('\\n🔗 Connecting this PC to the Agent Mesh…'));
            await agent.connect();
            // Keep the process alive while the socket runs.
            await new Promise(() => {}); // connector handles Ctrl+C via SIGINT default? ensure below
            break;
        }
        case 'pair': {`
);

// helper for saved file used in connect
s = s.replace(
  "/** Phase 37: mesh REST base — ROSE_SERVER env > ~/.rose/mesh-server.txt > local AgentServer. */",
  `function savedServerFromFile(): string {
    try { return fsSync.readFileSync(path.join(Config.getGlobalDir(), 'mesh-server.txt'), 'utf8').trim(); } catch { return ''; }
}

/** Phase 37: mesh REST base — ROSE_SERVER env > ~/.rose/mesh-server.txt > local AgentServer. */`
);

// 4) help text
s = s.replace(
  "  console.log('  agents      Agent Mesh: list/pair/approve/inspect/revoke/task');",
  "  console.log('  agents      Agent Mesh: list/pair/connect/approve/inspect/revoke/task');"
);

fs.writeFileSync('src/cli.ts', s);
console.log('cli patched | connect cmd:', s.includes("case 'connect':"), '| base fn:', s.includes('function resolveMeshBase'), '| help:', s.includes('list/pair/connect'));
