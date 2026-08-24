/**
 * Phase 33 â€” Plain (non-full-screen) setup fallback.
 *
 * Used for --plain, legacy terminals and reduced-accessibility needs
 * (spec 86). Walks the same DraftConfig + validation + apply pipeline as the
 * TUI so behavior is identical; only the presentation differs.
 */
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { SetupApp } from './app.js';
import { applyDraft, validateAll, defaultModelFor, resolveWorkspacePath } from './configService.js';
import { probeProvider } from './health.js';

export async function runPlainSetup(app: SetupApp): Promise<{ completed: boolean }> {
    const d = app.draft;
    console.log(chalk.bold.magenta('\nðŸŒ¹ Rose Setup (plain mode)\n'));

    d.agentName = await input({ message: 'Agent name:', default: d.agentName });

    d.provider = await select({
        message: 'AI provider:',
        choices: [
            { name: 'Antigravity Proxy  (Claude/GPT via local proxy)', value: 'proxy' as const },
            { name: 'Google Gemini     (Direct API · Live voice)', value: 'gemini' as const },
            { name: 'Anthropic Claude  (Direct API)', value: 'anthropic' as const },
            { name: 'OpenAI GPT        (Direct API)', value: 'openai' as const },
            { name: 'Ollama            (Local models)', value: 'ollama' as const },
            { name: 'OpenRouter        (400+ models · external service)', value: 'openrouter' as const },
        ],
        default: d.provider as any,
    });
    if (!d.model || d.model === defaultModelFor(d.provider)) {
        // keep model in sync when provider changed to its default
        d.model = defaultModelFor(d.provider);
    }

    if (d.provider === 'gemini') {
        d.geminiKey = await input({
            message: d.geminiKey ? `Gemini API key (configured ${maskLen(d.geminiKey)}, Enter to keep):` : 'Gemini API key:',
            default: '',
        }) || d.geminiKey;
    } else if (d.provider === 'anthropic') {
        d.anthropicKey = await input({ message: d.anthropicKey ? 'Anthropic API key (Enter to keep):' : 'Anthropic API key:', default: '' }) || d.anthropicKey;
    } else if (d.provider === 'openai') {
        d.openaiKey = await input({ message: d.openaiKey ? 'OpenAI API key (Enter to keep):' : 'OpenAI API key:', default: '' }) || d.openaiKey;
    } else if (d.provider === 'openrouter') {
        d.openrouterKey = await input({ message: d.openrouterKey ? `OpenRouter API key (configured ${maskLen(d.openrouterKey)}, Enter to keep):` : 'OpenRouter API key:', default: '' }) || d.openrouterKey;
    } else if (d.provider === 'ollama') {
        // Local daemon — no credential needed.
    } else {
        d.proxyUrl = await input({ message: 'Proxy URL:', default: d.proxyUrl });
    }

    d.workspacePath = resolveWorkspacePath(await input({ message: 'Workspace directory:', default: d.workspacePath }));

    d.autonomy = await select({
        message: 'Security policy:',
        choices: [
            { name: 'Ask before every tool', value: 'safe' as const },
            { name: 'Ask before sensitive actions (recommended)', value: 'balanced' as const },
            { name: 'Trusted mode', value: 'autonomous' as const },
        ],
        default: d.autonomy,
    });

    const theme = await select({
        message: 'Theme:',
        choices: [
            { name: 'Rose Dark', value: 'roseDark' as const },
            { name: 'Rose Light', value: 'roseLight' as const },
        ],
        default: d.appearance.theme === 'roseLight' ? 'roseLight' : 'roseDark',
    });
    d.appearance.theme = theme;

    d.webEnabled = await confirm({ message: 'Enable the Web Control Panel?', default: d.webEnabled });
    if (d.webEnabled) {
        d.webHost = await input({ message: 'Web host:', default: d.webHost });
        d.webPort = Number(await input({ message: 'Web port:', default: String(d.webPort) })) || d.webPort;
    }

    const errors = validateAll(d);
    if (errors.size > 0) {
        console.error(chalk.red('\nâœ— Configuration invalid:'));
        for (const [field, msg] of errors) {
            console.error(chalk.red(`  - ${field}: ${msg}`));
        }
        return { completed: false };
    }

    const testNow = await confirm({ message: 'Test the provider connection now?', default: true });
    if (testNow) {
        console.log(chalk.cyan('Testing connection...'));
        const result = await probeProvider({
            provider: d.provider,
            model: d.model,
            geminiKey: d.geminiKey || process.env.GEMINI_API_KEY,
            anthropicKey: d.anthropicKey || process.env.ANTHROPIC_API_KEY,
            openaiKey: d.openaiKey || process.env.OPENAI_API_KEY,
            openrouterKey: d.openrouterKey || process.env.OPENROUTER_API_KEY,
            proxyUrl: d.proxyUrl,
        });
        const icon = result.state === 'pass' ? chalk.green('âœ“') : result.state === 'warn' ? chalk.yellow('âš ') : chalk.red('âœ—');
        console.log(`${icon} ${result.label}: ${result.detail}`);
        if (result.fixHint) console.log(chalk.gray(`  ${result.fixHint}`));
        if (result.state === 'fail') {
            const cont = await confirm({ message: 'Connection failed. Save configuration anyway?', default: false });
            if (!cont) return { completed: false };
        }
    }

    console.log(chalk.cyan('\nApplying configuration...'));
    const result = await applyDraft(d);
    if (!result.ok) {
        console.error(chalk.red(`âœ— ${result.error}`));
        return { completed: false };
    }
    console.log(chalk.green('âœ“ Configuration saved.' + (result.backupPath ? ` Backup: ${result.backupPath}` : '')));
    return { completed: true };
}

function maskLen(key: string): string {
    return key.slice(0, 3) + '*'.repeat(Math.min(8, Math.max(0, key.length - 5))) + key.slice(-2);
}


