import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SecurityEngine } from './security.js';
import { EventStore } from './runtime/events.js';
import { MemoryService } from './memory.js';

/**
 * Phase 36 Part J: Rose AS an MCP server.
 *
 * External agents connect over stdio and get a strictly allowlisted,
 * READ-ONLY view of Rose. Every request flows through the existing
 * SecurityEngine (identity executor 'mcp-external', trust domain
 * RESTRICTED_PLUGIN) so the Policy Engine governs it exactly like any other
 * tool call — MCP is not a security bypass (§101, §120).
 *
 * Write/execute/browser tools are intentionally NOT exposed.
 */

export const ROSE_MCP_SERVER_INFO = {
    name: 'Rose MCP Server',
    version: '1.0.0',
    protocolVersion: '2024-11-05',
};

/** Read-only allowlist — everything else is denied by design. */
const TOOL_ALLOWLIST = [
    {
        name: 'rose_memory_search',
        description: 'Search Rose memory (hybrid keyword + vector). Read-only.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'What to look up' },
                project: { type: 'string', description: 'Optional project scope' },
            },
            required: ['query'],
        },
        async run(args: any): Promise<string> {
            return await MemoryService.searchHybrid({
                query: String(args.query || ''),
                project: args.project ? String(args.project) : undefined,
                limit: 5,
            }).then(r => JSON.stringify(r, null, 2));
        },
    },
    {
        name: 'rose_obsidian_search',
        description: 'Semantic search over the user\'s configured Obsidian vault with note citations. Read-only.',
        inputSchema: {
            type: 'object' as const,
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
        async run(args: any): Promise<string> {
            const { ObsidianVaultIndex } = await import('./memory/obsidian.js');
            if (!ObsidianVaultIndex.configuredVault()) return 'No Obsidian vault configured.';
            const obs = new ObsidianVaultIndex();
            await obs.ingest();
            const hits = await obs.search(String(args.query || ''), 5);
            return hits.length ? ObsidianVaultIndex.formatCitations(hits) : 'No relevant notes found.';
        },
    },
    {
        name: 'rose_project_status',
        description: 'Current workspace status: cwd, git branch summary, provider health. Read-only.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
        async run(): Promise<string> {
            const { ModelRouter } = await import('./router.js');
            return JSON.stringify({
                cwd: process.cwd(),
                platform: process.platform,
                providers: ModelRouter.getProviders().map(p => ({ id: p.id, health: p.health })),
                autonomyMode: SecurityEngine.autonomyMode,
            }, null, 2);
        },
    },
];

async function audit(type: string, detail: Record<string, unknown>): Promise<void> {
    try {
        await EventStore.append('mcp-server', 'external-agents', type, detail);
    } catch { /* audit is best-effort; never break the protocol loop */ }
}

export async function startMcpServer(): Promise<void> {
    try { EventStore.init(); } catch { /* already initialized */ }

    const server = new Server(
        { name: ROSE_MCP_SERVER_INFO.name, version: ROSE_MCP_SERVER_INFO.version },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        await audit('mcp.request', { kind: 'list_tools' });
        return {
            tools: TOOL_ALLOWLIST.map(t => ({
                name: t.name,
                description: `${t.description} [${ROSE_MCP_SERVER_INFO.name} v${ROSE_MCP_SERVER_INFO.version}]`,
                inputSchema: t.inputSchema,
            })),
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = String(request.params.name || '');
        const args = request.params.arguments ?? {};
        await audit('mcp.request', { kind: 'call_tool', tool: name });

        // Allowlist enforcement BEFORE anything executes.
        const tool = TOOL_ALLOWLIST.find(t => t.name === name);
        if (!tool) {
            await audit('mcp.denied', { tool: name, reason: 'not on read-only allowlist' });
            return {
                content: [{ type: 'text', text: `Tool "${name}" is not exposed. Rose MCP serves a read-only allowlist.` }],
                isError: true,
            };
        }

        // Same Policy Engine every other caller goes through.
        const decision = await SecurityEngine.evaluateAction(
            name,
            args,
            undefined,
            { actor: 'external-mcp-agent', executor: 'mcp-external', trustDomain: 'RESTRICTED_PLUGIN' }
        );
        if (!decision.allowed) {
            await audit('mcp.denied', { tool: name, reason: decision.message });
            return {
                content: [{ type: 'text', text: `Blocked by security policy: ${decision.message}` }],
                isError: true,
            };
        }

        try {
            const result = await tool.run(args);
            await audit('mcp.tool.completed', { tool: name });
            return { content: [{ type: 'text', text: result }] };
        } catch (e: any) {
            await audit('mcp.error', { tool: name, message: e.message });
            return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[${ROSE_MCP_SERVER_INFO.name}] serving ${TOOL_ALLOWLIST.length} read-only tools over stdio`);
}
