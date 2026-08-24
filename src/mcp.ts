import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import chalk from 'chalk';

export class McpClientManager {
    private static clients: Map<string, Client> = new Map();

    public static async connectServer(serverId: string, command: string, args: string[], env: any): Promise<any[]> {
        const transport = new StdioClientTransport({
            command,
            args,
            env: { ...process.env, ...env }
        });

        const client = new Client(
            { name: "gemini-voice-chat", version: "1.0.0" },
            { capabilities: {} }
        );

        // Bind error handler
        client.onerror = (error) => {
            console.error(chalk.red(`[MCP ${serverId}] Error: ${error.message}`));
        };

        try {
            await client.connect(transport);
            this.clients.set(serverId, client);

            const toolsList = await client.listTools();
            return toolsList.tools.map((t: any) => ({
                name: t.name,
                description: t.description || `MCP Tool: ${t.name}`,
                parameters: {
                    type: 'OBJECT',
                    properties: t.inputSchema?.properties || {},
                    required: t.inputSchema?.required || []
                }
            }));
        } catch (error: any) {
            throw new Error(`Failed to initialize MCP client for ${serverId}: ${error.message}`);
        }
    }

    public static async callTool(serverId: string, toolName: string, args: any): Promise<any> {
        const client = this.clients.get(serverId);
        if (!client) {
            throw new Error(`MCP Server ${serverId} is not connected.`);
        }

        try {
            // Revert the namespace we added during registration
            const originalToolName = toolName.replace(`mcp_${serverId}_`, '');
            const result = await client.callTool({
                name: originalToolName,
                arguments: args
            });

            if (result.isError) {
                throw new Error((result.content as any[]).map((c:any) => c.text).join('\n'));
            }

            return (result.content as any[]).map((c:any) => c.text).join('\n');
        } catch (e: any) {
            throw new Error(`MCP tool execution failed: ${e.message}`);
        }
    }

    public static getClientStatuses(): { id: string, connected: boolean }[] {
        return Array.from(this.clients.keys()).map(id => ({ id, connected: true }));
    }
}
