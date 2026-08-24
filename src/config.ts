import fs from 'fs';
import path from 'path';
import os from 'os';

export interface AppConfig {
    env: 'development' | 'test' | 'simulation' | 'production' | 'recovery' | 'maintenance';
    agent: {
        name: string;
        model: string;
        provider: 'gemini' | 'anthropic' | 'openai' | 'proxy';
    };
    keys: {
        gemini?: string;
        anthropic?: string;
        openai?: string;
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
    };
    observability: {
        logLevel: 'debug' | 'info' | 'warn' | 'error';
    };
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
                openai: process.env.OPENAI_API_KEY
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
                const gc = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
                if (gc.env) cfg.env = gc.env;
                if (gc.agent?.name) cfg.agent.name = gc.agent.name;
                if (gc.agent?.model) cfg.agent.model = gc.agent.model;
                if (gc.agent?.provider) cfg.agent.provider = gc.agent.provider;
                if (gc.keys?.gemini) cfg.keys.gemini = gc.keys.gemini;
                if (gc.keys?.anthropic) cfg.keys.anthropic = gc.keys.anthropic;
                if (gc.keys?.openai) cfg.keys.openai = gc.keys.openai;
                if (gc.proxy?.enabled !== undefined) cfg.proxy.enabled = gc.proxy.enabled;
                if (gc.proxy?.url) cfg.proxy.url = gc.proxy.url;
                if (gc.server?.port) cfg.server.port = gc.server.port;
                if (gc.security?.requireApprovals !== undefined) cfg.security.requireApprovals = gc.security.requireApprovals;
                if (gc.security?.allowFederation !== undefined) cfg.security.allowFederation = gc.security.allowFederation;
                if (gc.observability?.logLevel) cfg.observability.logLevel = gc.observability.logLevel;
                // Backwards compatibility: old config had agent.apiKey
                if (gc.agent?.apiKey && !gc.keys?.gemini) cfg.keys.gemini = gc.agent.apiKey;
            } catch (e) {
                console.error('Failed to parse global config.json:', e);
            }
        }

        // Project Config Override (gemini.config.json)
        const configPath = path.join(process.cwd(), 'gemini.config.json');
        if (fs.existsSync(configPath)) {
            try {
                const projectConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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

    public saveConfig(updates: Partial<AppConfig>) {
        // Deep merge updates
        this.config = { ...this.config, ...updates };
        
        // Ensure global dir exists
        const globalDir = this.getGlobalDir();
        if (!fs.existsSync(globalDir)) {
            fs.mkdirSync(globalDir, { recursive: true });
        }
        
        const configPath = path.join(globalDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    }

    public get(): AppConfig {
        return this.config;
    }
}

export const Config = new ConfigurationEngine();
