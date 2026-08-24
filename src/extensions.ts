import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { McpClientManager } from './mcp.js';
import { Capability } from './capabilities.js';

export interface ExtensionManifest {
    id: string;
    name: string;
    type: "plugin" | "mcp";
    version: string;
    description?: string;
    capabilities?: Capability[];
    tools?: any[]; // Static tools if any
}

export class ExtensionRegistry {
    private static extensions: Map<string, ExtensionManifest> = new Map();
    private static activeCapabilities: Set<Capability> = new Set();
    private static extensionTools: any[] = [];

    public static async discoverAndLoad(): Promise<void> {
        try {
            // Load MCP configurations
            const mcpConfigPath = path.join(process.cwd(), 'mcp.json');
            try {
                const configData = await fs.readFile(mcpConfigPath, 'utf8');
                const config = JSON.parse(configData);
                
                if (config.mcpServers) {
                    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
                        const mcpCfg = serverConfig as any;
                        const manifest: ExtensionManifest = {
                            id: `mcp.${serverId}`,
                            name: serverId,
                            type: 'mcp',
                            version: '1.0.0',
                        };
                        this.extensions.set(manifest.id, manifest);
                        
                        console.log(chalk.gray(`[EXTENSION] Loading MCP server: ${serverId}`));
                        try {
                            const tools = await McpClientManager.connectServer(serverId, mcpCfg.command, mcpCfg.args || [], mcpCfg.env || {});
                            if (tools) {
                                // Add namespace to tools
                                for (const t of tools) {
                                    t.name = `mcp_${serverId}_${t.name}`;
                                    this.extensionTools.push(t);
                                }
                                console.log(chalk.green(`[EXTENSION] Loaded MCP server ${serverId} with ${tools.length} tools.`));
                            }
                        } catch (e: any) {
                            console.log(chalk.red(`[EXTENSION] Failed to connect MCP server ${serverId}: ${e.message}`));
                        }
                    }
                }
            } catch (e: any) {
                if (e.code !== 'ENOENT') {
                    console.log(chalk.red(`[EXTENSION] Error reading mcp.json: ${e.message}`));
                }
            }

            // Here we would also discover local `plugins/` directories if needed
            // e.g. read plugins/*/manifest.json
        } catch (e: any) {
            console.error(chalk.red(`[EXTENSION] Critical failure during discovery: ${e.message}`));
        }
    }

    public static getExtensions(): ExtensionManifest[] {
        return Array.from(this.extensions.values());
    }

    public static getExtensionTools(): any[] {
        return this.extensionTools;
    }

    public static getCapabilities(): Capability[] {
        return Array.from(this.activeCapabilities);
    }
}
