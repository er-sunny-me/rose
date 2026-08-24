import chalk from 'chalk';
import fs from 'fs';
import { input, select, confirm } from '@inquirer/prompts';
import { Config } from './config.js';

interface ProxyModel {
    id: string;
    description: string;
}

async function fetchProxyModels(proxyUrl: string): Promise<ProxyModel[]> {
    try {
        const response = await fetch(`${proxyUrl}/v1/models`);
        if (!response.ok) return [];
        const data: any = await response.json();
        if (data.data && Array.isArray(data.data)) {
            return data.data.map((m: any) => ({
                id: m.id,
                description: m.description || m.id
            }));
        }
        return [];
    } catch (e) {
        return [];
    }
}

export async function runSetupWizard() {
    console.log(chalk.bold.magenta('\n🌹 Rose Agent Setup 🌹\n'));
    console.log(chalk.gray('Use arrow keys to navigate, Enter to select.\n'));

    // ─── 1. Agent Identity ───
    console.log(chalk.bold.cyan('── Agent Identity ──'));
    const agentName = await input({ message: 'Agent Name:', default: 'Rose' });

    // ─── 2. Provider Selection ───
    console.log(chalk.bold.cyan('\n── AI Provider ──'));
    const provider = await select({
        message: 'Select Primary AI Provider:',
        choices: [
            { name: '🔌 Antigravity Proxy  (Claude, GPT via local proxy)', value: 'proxy' },
            { name: '🟢 Google Gemini      (Direct API)', value: 'gemini' },
            { name: '🟣 Anthropic Claude   (Direct API)', value: 'anthropic' },
            { name: '🔵 OpenAI GPT         (Direct API)', value: 'openai' }
        ]
    });

    // ─── 3. Model Selection ───
    console.log(chalk.bold.cyan('\n── Default Model ──'));
    let agentModel = '';
    
    if (provider === 'proxy') {
        // Fetch models LIVE from proxy
        const proxyUrl = 'http://localhost:8642';
        console.log(chalk.gray('  Fetching models from proxy...'));
        const models = await fetchProxyModels(proxyUrl);
        
        if (models.length > 0) {
            const choices = models.map(m => ({
                name: `${m.description.padEnd(35)} (${m.id})`,
                value: m.id
            }));
            
            agentModel = await select({
                message: `Select Default Model (${models.length} available):`,
                choices
            });
        } else {
            console.log(chalk.yellow('  ⚠ Could not reach proxy at localhost:8642'));
            console.log(chalk.yellow('  Make sure antigravity-proxy-ai is running.'));
            agentModel = await input({ message: 'Enter model ID manually:', default: 'claude-sonnet-4-6' });
        }
    } else if (provider === 'gemini') {
        agentModel = await select({
            message: 'Select Default Model:',
            choices: [
                { name: 'Gemini 2.0 Flash       (Fast)', value: 'gemini-2.0-flash' },
                { name: 'Gemini 2.0 Pro Exp     (Smart)', value: 'gemini-2.0-pro-exp' }
            ]
        });
    } else if (provider === 'anthropic') {
        agentModel = await select({
            message: 'Select Default Model:',
            choices: [
                { name: 'Claude 3.5 Sonnet      (Thinking)', value: 'claude-3-5-sonnet-20241022' },
                { name: 'Claude 3 Opus          (Most Capable)', value: 'claude-3-opus-20240229' },
                { name: 'Claude 3.5 Haiku       (Fast)', value: 'claude-3-5-haiku-20241022' }
            ]
        });
    } else if (provider === 'openai') {
        agentModel = await select({
            message: 'Select Default Model:',
            choices: [
                { name: 'GPT-4o                 (Smart)', value: 'gpt-4o' },
                { name: 'GPT-4o Mini            (Fast)', value: 'gpt-4o-mini' },
                { name: 'GPT-4 Turbo            (Powerful)', value: 'gpt-4-turbo' }
            ]
        });
    }

    // ─── 4. API Keys ───
    console.log(chalk.bold.cyan('\n── API Keys ──'));
    let geminiKey = '';
    let anthropicKey = '';
    let openaiKey = '';
    let proxyUrl = 'http://localhost:8642';

    if (provider === 'proxy') {
        proxyUrl = await input({ message: 'Proxy URL:', default: 'http://localhost:8642' });
    } else if (provider === 'gemini') {
        geminiKey = await input({ message: 'Gemini API Key:' });
        if (!geminiKey.trim()) console.log(chalk.yellow('  ⚠ Add later in ~/.rose/config.json'));
    } else if (provider === 'anthropic') {
        anthropicKey = await input({ message: 'Anthropic API Key:' });
        if (!anthropicKey.trim()) console.log(chalk.yellow('  ⚠ Add later in ~/.rose/config.json'));
    } else if (provider === 'openai') {
        openaiKey = await input({ message: 'OpenAI API Key:' });
        if (!openaiKey.trim()) console.log(chalk.yellow('  ⚠ Add later in ~/.rose/config.json'));
    }

    const addMoreKeys = await confirm({ message: 'Add API keys for other providers?', default: false });
    if (addMoreKeys) {
        if (provider !== 'gemini') geminiKey = await input({ message: 'Gemini API Key (Enter to skip):' });
        if (provider !== 'anthropic') anthropicKey = await input({ message: 'Anthropic API Key (Enter to skip):' });
        if (provider !== 'openai') openaiKey = await input({ message: 'OpenAI API Key (Enter to skip):' });
    }

    // ─── 5. Environment & Security ───
    console.log(chalk.bold.cyan('\n── Environment & Security ──'));
    const envStr = await select({
        message: 'Environment:',
        choices: [
            { name: 'Development', value: 'development' },
            { name: 'Production', value: 'production' }
        ]
    });

    const requireApprovals = await confirm({ message: 'Require human approval for dangerous actions?', default: true });
    const allowFederation = await confirm({ message: 'Allow Agent Federation (network)?', default: false });

    // ─── 6. Server & Logging ───
    console.log(chalk.bold.cyan('\n── Server & Logging ──'));
    const portStr = await input({ message: 'Default Server Port:', default: '3000' });
    
    const logLevel = await select({
        message: 'Log Level:',
        choices: [
            { name: 'Info', value: 'info' },
            { name: 'Debug', value: 'debug' },
            { name: 'Warn', value: 'warn' },
            { name: 'Error', value: 'error' }
        ]
    });

    // ─── Save ───
    console.log(chalk.cyan('\nSaving configuration...'));

    const globalDir = Config.getGlobalDir();
    if (!fs.existsSync(globalDir)) {
        fs.mkdirSync(globalDir, { recursive: true });
    }

    const updates: any = {
        agent: { name: agentName.trim() || 'Rose', model: agentModel, provider },
        keys: {},
        proxy: { enabled: provider === 'proxy', url: proxyUrl },
        security: { requireApprovals, allowFederation },
        server: { port: parseInt(portStr, 10) || 3000 },
        observability: { logLevel },
        env: envStr
    };

    if (geminiKey.trim()) updates.keys.gemini = geminiKey.trim();
    if (anthropicKey.trim()) updates.keys.anthropic = anthropicKey.trim();
    if (openaiKey.trim()) updates.keys.openai = openaiKey.trim();

    Config.saveConfig(updates);
    console.log(chalk.green('✓ Saved to ~/.rose/config.json'));

    // ─── Summary ───
    console.log(chalk.bold.magenta('\n── Summary ──'));
    console.log(chalk.white(`  Agent:      ${updates.agent.name}`));
    console.log(chalk.white(`  Provider:   ${provider}`));
    console.log(chalk.white(`  Model:      ${agentModel}`));
    console.log(chalk.white(`  Keys:       Gemini ${geminiKey.trim() ? '✓' : '✗'}  Anthropic ${anthropicKey.trim() ? '✓' : '✗'}  OpenAI ${openaiKey.trim() ? '✓' : '✗'}`));
    if (provider === 'proxy') console.log(chalk.white(`  Proxy URL:  ${proxyUrl}`));
    console.log(chalk.white(`  Port:       ${portStr || '3000'}  Env: ${envStr}  Log: ${logLevel}`));

    console.log(chalk.green('\n✅ Setup Complete! Run ') + chalk.bold('rose chat') + chalk.green(' to start.\n'));
}
