import fs from 'fs';
import path from 'path';
import os from 'os';
import { AppearanceConfig } from './tui/theme.js';

export interface SetupState {
    /** Version of the setup flow this configuration was completed with. */
    version: number;
    completedAt?: string;
    configurationVersion: number;
}

export interface AppConfig {
    env: 'development' | 'test' | 'simulation' | 'production' | 'recovery' | 'maintenance';
    agent: {
        name: string;
        model: string;
        provider: 'gemini' | 'anthropic' | 'openai' | 'proxy' | 'ollama' | 'openrouter';
    };
    keys: {
        gemini?: string;
        anthropic?: string;
        openai?: string;
        openrouter?: string;
        github?: string;
        google?: string;
    };
    proxy: {
        enabled: boolean;
        url: string;
    };
    server: {
        port: number;
    };
    storage: {
        baseDir: string;
    };
    security: {
        requireApprovals: boolean;
        allowFederation: boolean;
        /** Phase 33: maps to SecurityEngine autonomy modes. */
        autonomy?: 'safe' | 'balanced' | 'autonomous';
    };
    observability: {
        logLevel: 'debug' | 'info' | 'warn' | 'error';
    };
    /** Phase 33 sections â€” all optional so pre-Phase-33 configs keep loading. */
    workspace?: {
        path?: string;
    };
    memory?: {
        learningEnabled?: boolean;
        obsidianVaultPath?: string;
        maxEntriesPerType?: number;
    };
    appearance?: AppearanceConfig;
    /** Phase 35: OpenRouter endpoint override (defaults to the official API). */
    openrouter?: {
        baseUrl?: string;
    };
    web?: {
        enabled?: boolean;
        host?: string;
        port?: number;
    };
    setup?: SetupState;
}

class ConfigurationEngine {
    private config: AppConfig;

    constructor() {
        this.config = this.loadConfig();
    }

    public getGlobalDir(): string {
        if (process.env.ROSE_HOME) return process.env.ROSE_HOME;
        return path.join(os.homedir(), '.rose');
    }

    private loadConfig(): AppConfig {
        const env = (process.env.NODE_ENV as AppConfig['env']) || 'development';

        // Defaults
        const cfg: AppConfig = {
            env,
            agent: {
                name: process.env.ROSE_AGENT_NAME || 'Rose',
                model: process.env.ROSE_AGENT_MODEL || 'gemini-2.0-flash',
                provider: 'proxy'
            },
            keys: {
                gemini: process.env.GEMINI_API_KEY,
                anthropic: process.env.ANTHROPIC_API_KEY,
                openai: process.env.OPENAI_API_KEY,
                openrouter: process.env.OPENROUTER_API_KEY
            },
            proxy: {
                enabled: true,
                url: process.env.PROXY_URL || 'http://localhost:8642'
            },
            server: {
                port: parseInt(process.env.PORT || '3000', 10)
            },
            storage: {
                baseDir: process.env.GEMINI_DIR || this.getGlobalDir()
            },
            security: {
                requireApprovals: process.env.REQUIRE_APPROVALS === 'true' || env === 'production',
                allowFederation: process.env.ALLOW_FEDERATION === 'true'
            },
            observability: {
                logLevel: (process.env.LOG_LEVEL as any) || 'info'
            }
        };

        // Load Global Config (from ~/.rose/config.json)
        const globalConfigPath = path.join(this.getGlobalDir(), 'config.json');
        if (fs.existsSync(globalConfigPath)) {
            try {
                const gc = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8').replace(/^\uFEFF/, ''));
                if (gc.env) cfg.env = gc.env;
                if (gc.agent?.name) cfg.agent.name = gc.agent.name;
                if (gc.agent?.model) cfg.agent.model = gc.agent.model;
                if (gc.agent?.provider) cfg.agent.provider = gc.agent.provider;
                if (gc.keys?.gemini) cfg.keys.gemini = gc.keys.gemini;
                if (gc.keys?.anthropic) cfg.keys.anthropic = gc.keys.anthropic;
                if (gc.keys?.openai) cfg.keys.openai = gc.keys.openai;
                if (gc.keys?.openrouter) cfg.keys.openrouter = gc.keys.openrouter;
                // Phase 35: OpenRouter endpoint configuration
                if (gc.openrouter && typeof gc.openrouter === 'object') cfg.openrouter = gc.openrouter;
                if (gc.proxy?.enabled !== undefined) cfg.proxy.enabled = gc.proxy.enabled;
                if (gc.proxy?.url) cfg.proxy.url = gc.proxy.url;
                if (gc.server?.port) cfg.server.port = gc.server.port;
                if (gc.security?.requireApprovals !== undefined) cfg.security.requireApprovals = gc.security.requireApprovals;
                if (gc.security?.allowFederation !== undefined) cfg.security.allowFederation = gc.security.allowFederation;
                if (gc.observability?.logLevel) cfg.observability.logLevel = gc.observability.logLevel;
                // Backwards compatibility: old config had agent.apiKey
                if (gc.agent?.apiKey && !gc.keys?.gemini) cfg.keys.gemini = gc.agent.apiKey;

                // Phase 33 sections
                if (gc.workspace && typeof gc.workspace === 'object') cfg.workspace = gc.workspace;
                if (gc.memory && typeof gc.memory === 'object') cfg.memory = gc.memory;
                if (gc.appearance && typeof gc.appearance === 'object') cfg.appearance = gc.appearance;
                if (gc.web && typeof gc.web === 'object') cfg.web = gc.web;
                if (gc.setup && typeof gc.setup === 'object') cfg.setup = gc.setup;
            } catch (e) {
                console.error('Failed to parse global config.json:', e);
            }
        }

        // Project Config Override (gemini.config.json)
        const configPath = path.join(process.cwd(), 'gemini.config.json');
        if (fs.existsSync(configPath)) {
            try {
                const projectConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''));
                if (projectConfig.server?.port) cfg.server.port = projectConfig.server.port;
                if (projectConfig.security?.requireApprovals !== undefined) cfg.security.requireApprovals = projectConfig.security.requireApprovals;
                if (projectConfig.security?.allowFederation !== undefined) cfg.security.allowFederation = projectConfig.security.allowFederation;
            } catch (e) {
                console.error('Failed to parse gemini.config.json:', e);
                process.exit(1);
            }
        }

        // Hard overrides for production
        if (cfg.env === 'production') {
            cfg.security.requireApprovals = true; // Cannot be bypassed in prod config
        }

        return cfg;
    }

    /**
     * Persist updates. Writes are atomic (temp file + rename) and the previous
     * configuration is backed up first so a failed save never loses a valid
     * configuration copy (Phase 33 spec 39-40).
     */
    public saveConfig(updates: Partial<AppConfig>) {
        const globalDir = this.getGlobalDir();
        if (!fs.existsSync(globalDir)) {
            fs.mkdirSync(globalDir, { recursive: true });
        }
        const configPath = path.join(globalDir, 'config.json');

        // Backup before overwriting an existing valid configuration.
        if (fs.existsSync(configPath)) {
            this.backupCurrent(configPath, globalDir);
        }

        this.config = { ...this.config, ...updates };

        const tmpPath = configPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf-8');
        fs.renameSync(tmpPath, configPath);
    }

    private backupTimes: number[] = [];
    private backupCurrent(configPath: string, globalDir: string): void {
        try {
            const backupDir = path.join(globalDir, 'backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(configPath, path.join(backupDir, `config-${stamp}.json`));
            // Keep only the 10 most recent backups.
            this.backupTimes = [];
            const all = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('config-') && f.endsWith('.json'))
                .sort();
            while (all.length > 10) {
                const oldest = all.shift();
                if (oldest) fs.unlinkSync(path.join(backupDir, oldest));
            }
        } catch {
            // A failed backup must not block saving; the atomic write still protects partial files.
        }
    }

    /** Re-read configuration from disk (used after setup applies changes). */
    public reload(): void {
        this.config = this.loadConfig();
    }

    public get(): AppConfig {
        return this.config;
    }
}

export const Config = new ConfigurationEngine();


