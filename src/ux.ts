import chalk from 'chalk';

export type DisplayMode = 'normal' | 'verbose' | 'debug' | 'compact';

export class InteractionLayer {
    private static mode: DisplayMode = 'normal';

    public static setMode(mode: DisplayMode) {
        this.mode = mode;
        console.log(chalk.cyan(`UI Mode set to: ${mode}`));
    }

    public static getMode(): DisplayMode {
        return this.mode;
    }

    public static renderTaskProgress(status: string, message: string, detailedLogs?: string) {
        if (this.mode === 'compact') {
            if (status === 'started' || status === 'completed' || status === 'failed') {
                const icon = status === 'completed' ? chalk.green('✓') : (status === 'failed' ? chalk.red('✗') : chalk.cyan('●'));
                console.log(`${icon} ${message}`);
            }
            return;
        }

        let icon = chalk.cyan('●');
        if (status === 'completed') icon = chalk.green('✓');
        else if (status === 'failed') icon = chalk.red('✗');
        else if (status === 'warning' || status === 'replan') icon = chalk.yellow('↻');
        else if (status === 'pending') icon = chalk.gray('○');
        else if (status === 'planning') icon = chalk.magenta('🤔');
        else if (status === 'verifying') icon = chalk.blue('🔍');

        console.log(`${icon} ${message}`);

        if ((this.mode === 'verbose' || this.mode === 'debug') && detailedLogs) {
            console.log(chalk.gray(`   ├─ ${detailedLogs.split('\n').join('\n   ├─ ')}`));
        }
    }

    public static renderSuccess(message: string) {
        console.log(chalk.green(`✓ ${message}`));
    }

    public static renderError(message: string, reason?: string, nextAction?: string) {
        console.log(chalk.red(`✗ ${message}`));
        if (reason) console.log(chalk.gray(`  Reason: ${reason}`));
        if (nextAction) console.log(chalk.yellow(`  Next: ${nextAction}`));
    }

    public static renderAttachmentPreview(filename: string, details?: string) {
        console.log(chalk.gray(`📎 Attached: ${chalk.white(filename)}${details ? ` (${details})` : ''}`));
    }
    
    public static renderWarning(message: string) {
        console.log(chalk.yellow(`⚠ ${message}`));
    }

    public static renderNotification(title: string, message: string) {
        console.log(chalk.magenta('\n──────────────'));
        console.log(chalk.cyan(`🔔 ${title}`));
        console.log();
        console.log(chalk.white(message));
        console.log(chalk.magenta('──────────────\n'));
    }
}
