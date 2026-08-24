/**
 * Phase 33 — Setup entry point.
 *
 * Decides between the full-screen TUI, plain mode and non-interactive
 * guidance, and handles `--reset` safely. Everything below this line is
 * presentation; persistence always goes through configService (spec 55, 73).
 */
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { Screen } from '../tui/screen.js';
import { Config } from '../config.js';
import {
    hasCompletedSetup, configFileExists, needsSetupMigration,
    SETUP_VERSION, loadDraft,
} from './configService.js';
import { SetupApp, SetupOutcome } from './app.js';
import { runPlainSetup } from './plain.js';

export interface SetupCliOptions {
    reset?: boolean;
    noColor?: boolean;
    plain?: boolean;
    debug?: boolean;
}

function applyNoColor(): void {
    process.env.FORCE_COLOR = '0';
}

/** Message shown when Rose is launched with no configuration in a non-TTY. */
export function printNonInteractiveSetupGuidance(): void {
    console.log(chalk.yellow('\nRose setup requires an interactive terminal.\n'));
    console.log('Configure without the wizard using:');
    console.log(chalk.bold.cyan('  rose config set agent.provider gemini'));
    console.log(chalk.bold.cyan('  rose config set keys.gemini <your-key>'));
    console.log(chalk.gray('\nOr set environment variables: GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY\n'));
}

/**
 * True when bare `rose` should launch first-run setup instead of the normal
 * experience (spec 2). Existing pre-Phase-33 configs are migrated silently.
 */
export function shouldRunFirstRunSetup(): boolean {
    return !hasCompletedSetup();
}

/** One-time migration notice + marker for legacy installs (spec 46). */
export function maybeMigrateLegacySetup(): boolean {
    if (!configFileExists()) return false;
    if (hasCompletedSetup() && !needsSetupMigration()) return false;
    try {
        const cfgPath = path.join(Config.getGlobalDir(), 'config.json');
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (raw.agent?.provider || raw.proxy?.url) {
            raw.setup = { version: SETUP_VERSION, completedAt: new Date().toISOString(), configurationVersion: 1 };
            const tmp = cfgPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
            fs.renameSync(tmp, cfgPath);
            Config.reload();
            return true;
        }
    } catch { /* leave state untouched on any parse/IO problem */ }
    return false;
}

/** Handle `rose setup` with flags. Returns after setup completes or aborts. */
export async function runSetupCommand(opts: SetupCliOptions): Promise<void> {
    if (opts.noColor) applyNoColor();

    // Non-interactive guard (spec 55)
    if (!Screen.supportsInteractive() && !opts.plain) {
        if (process.stdout.isTTY === false) {
            printNonInteractiveSetupGuidance();
            process.exitCode = 1;
            return;
        }
        // stdin not a TTY (piped) — same guidance.
        printNonInteractiveSetupGuidance();
        process.exitCode = 1;
        return;
    }

    // Reset flow: destructive to CONFIG only, never to user data (spec 4)
    if (opts.reset && !(Screen.supportsInteractive() && !opts.plain)) {
        // Plain-mode reset uses a simple prompt.
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
            message: 'Reset ALL settings to defaults? Memory/projects are kept. A backup is made first.',
            default: false,
        });
        if (!ok) {
            console.log(chalk.gray('Reset cancelled — nothing was changed.'));
            return;
        }
        performConfigReset();
        console.log(chalk.green('✓ Configuration reset. Starting fresh setup...\n'));
    }

    const useTui = Screen.supportsInteractive() && !opts.plain;
    const mode: 'wizard' | 'manager' = hasCompletedSetup() ? 'manager' : 'wizard';

    if (useTui) {
        const app = new SetupApp({ mode, debug: opts.debug });

        if (opts.reset) {
            // The reset confirmation renders as the first screen of the TUI.
            app.confirm(
                'Reset configuration?',
                [
                    'This restores ALL settings to defaults.',
                    '',
                    'Kept safe: memory vault, learning data, projects, conversations.',
                    'Removed: keys, appearance and web settings stored in config.json.',
                    '',
                    'A backup of your current configuration is created first.',
                ],
                ['Reset', 'Cancel'],
                (idx) => {
                    if (idx === 0) {
                        try {
                            performConfigReset();
                            app.draft = loadFreshDraft();
                            app.toast('Configuration reset — continuing with defaults.');
                        } catch (e: any) {
                            app.toast(`Reset failed: ${e.message}`);
                            app.requestExit = true;
                        }
                    } else {
                        app.requestExit = true;
                    }
                },
            );
        }

        try {
            const outcome: SetupOutcome = await app.run();
            printOutcomeSummary(outcome);
        } catch (err) {
            restoreAfterCrash(err);
        }
        return;
    }

    // Plain fallback shares the same app state/service pipeline.
    const plainApp = new SetupApp({ mode: 'wizard', debug: opts.debug });
    const result = await runPlainSetup(plainApp);
    printOutcomeSummary({ completed: result.completed, launchRose: false });
}

function loadFreshDraft() {
    // Config.reload() already ran inside performConfigReset(), so the static
    // import sees the reset state.
    return loadDraft();
}

function performConfigReset(): void {
    const globalDir = Config.getGlobalDir();
    const configPath = path.join(globalDir, 'config.json');
    if (fs.existsSync(configPath)) {
        const backupDir = path.join(globalDir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(configPath, path.join(backupDir, `config-pre-reset-${stamp}.json`));
        fs.unlinkSync(configPath);
        Config.reload();
    }
}

function printOutcomeSummary(outcome: SetupOutcome): void {
    if (!outcome.completed) {
        console.log(chalk.yellow('\nSetup closed without completing. Nothing was saved.\n'));
        return;
    }
    console.log(chalk.green('\n✓ Setup complete.'));
    console.log(chalk.gray('  rose          start chatting'));
    console.log(chalk.gray('  rose web      open the Web Control Panel'));
    console.log(chalk.gray('  rose setup    reconfigure anytime\n'));
}

/** Restore terminal and report cleanly instead of dumping a stack trace (spec 66). */
function restoreAfterCrash(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('NON_INTERACTIVE')) {
        printNonInteractiveSetupGuidance();
        return;
    }
    console.error(chalk.red(`\n✗ Setup crashed: ${message}`));
    if (message.includes('readkey') || message.toLowerCase().includes('raw mode')) {
        console.error(chalk.gray('Your terminal has been restored. Try `rose setup --plain`.'));
    } else {
        console.error(chalk.gray('Your terminal has been restored. Run `rose setup --debug` for details.'));
    }
}
