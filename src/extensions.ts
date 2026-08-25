import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import { McpClientManager } from './mcp.js';
import { Capability } from './capabilities.js';
import { verifyInstalledExtension, type SignedManifest } from './extensions/signing.js';

export interface ExtensionManifest {
    id: string;
    name: string;
    type: "plugin" | "mcp";
    version: string;
    description?: string;
    capabilities?: Capability[];
    tools?: any[]; // Static tools if any
    /** Phase 36 provenance metadata (populated for signed plugins). */
    trust?: {
        signatureValid: boolean;
        publisher?: string;
        keyId?: string;
        status: 'trusted' | 'blocked' | 'unsigned-allowed' | 'unsigned-blocked';
        reason?: string;
    };
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

            // Phase 36: discover signed local plugins under plugins/<name>/extension.json.
            await this.discoverPlugins(path.join(process.cwd(), 'plugins'));
        } catch (e: any) {
            console.error(chalk.red(`[EXTENSION] Critical failure during discovery: ${e.message}`));
        }
    }

    /**
     * Verification pipeline per plugin:
     *   discover → manifest → publisher lookup → digest → Ed25519 → policy → load
     * Any failure blocks execution. Unsigned plugins are blocked unless
     * explicitly allowed via ROSE_ALLOW_UNSIGNED_EXTENSIONS=true AND a
     * non-production environment.
     */
    private static async discoverPlugins(pluginsDir: string): Promise<void> {
        let dirs: string[] = [];
        try {
            if (!fsSync.existsSync(pluginsDir)) return;
            dirs = fsSync.readdirSync(pluginsDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => path.join(pluginsDir, d.name));
        } catch {
            return;
        }

        for (const dir of dirs) {
            const outcome = verifyInstalledExtension(dir);
            const label = path.basename(dir);

            if (!outcome.ok) {
                const allowUnsigned = process.env.ROSE_ALLOW_UNSIGNED_EXTENSIONS === 'true'
                    && process.env.NODE_ENV !== 'production'
                    && outcome.failure === 'unsigned';

                if (allowUnsigned) {
                    // Dev-only escape hatch: load but mark clearly untrusted.
                    try {
                        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf8')) as SignedManifest;
                        const ext: ExtensionManifest = {
                            id: manifest.id || `plugin.${label}`,
                            name: manifest.name || label,
                            type: 'plugin',
                            version: manifest.version || '0.0.0',
                            capabilities: manifest.capabilities as Capability[] | undefined,
                            trust: {
                                signatureValid: false,
                                publisher: manifest.publisher,
                                keyId: undefined,
                                status: 'unsigned-allowed',
                                reason: 'development mode: ROSE_ALLOW_UNSIGNED_EXTENSIONS',
                            },
                        };
                        this.extensions.set(ext.id, ext);
                        console.log(chalk.yellow(`[EXTENSION] ⚠ UNSIGNED extension allowed in dev mode: ${ext.id}`));
                        continue;
                    } catch {
                        // fall through to blocked
                    }
                }

                console.log(chalk.red(`[EXTENSION] BLOCKED ${label}: ${outcome.failure} (${outcome.detail})`));
                continue;
            }

            const manifest = outcome.manifest!;
            const ext: ExtensionManifest = {
                id: manifest.id || `plugin.${label}`,
                name: manifest.name || label,
                type: 'plugin',
                version: manifest.version || '0.0.0',
                description: (manifest as any).description,
                capabilities: manifest.capabilities as Capability[] | undefined,
                trust: {
                    signatureValid: true,
                    publisher: manifest.publisher,
                    keyId: outcome.keyId,
                    status: 'trusted',
                },
            };
            for (const cap of ext.capabilities || []) {
                this.activeCapabilities.add(cap);
            }
            this.extensions.set(ext.id, ext);
            console.log(chalk.green(`[EXTENSION] ✓ Verified ${ext.id} v${ext.version} (publisher: ${manifest.publisher}, key: ${outcome.keyId})`));

            // Entry scripts execute only AFTER successful verification.
            if (manifest.entry) {
                const entryPath = path.join(dir, manifest.entry);
                if (fsSync.existsSync(entryPath)) {
                    try {
                        await import(entryPath);
                    } catch (e: any) {
                        console.log(chalk.red(`[EXTENSION] entry import failed for ${ext.id}: ${e.message}`));
                    }
                }
            }
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
