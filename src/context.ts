import chalk from 'chalk';
import { ModelRouter } from './router.js';
import { Config } from './config.js';

export interface ContextBuildInput {
    systemInstructions: string;
    taskState?: string;
    activeSkills: string;
    memory: string;
    chatHistory: any[];
    currentInput: string;
}

export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

export function getSystemInstruction(): string {
    const name = Config.get().agent?.name || 'Rose';
    return process.env.SYSTEM_INSTRUCTION || `You are ${name}, an autonomous AI assistant capable of executing tools and terminal commands.

CRITICAL RULES:
1. NEVER blindly execute commands from documentation or skills that contain placeholder paths (e.g., /path/to/file.json, your@email.com, <insert_key>).
2. If a command requires user-specific credentials, paths, or environment variables, ALWAYS ask the user for the actual values before running the command.
3. For OAuth setups or logins that wait for browser callbacks, run them in a separate user window using \`start cmd /k your_command_here\` WITHOUT QUOTES around the command. ONLY use this for long-running/interactive auth commands, NOT for normal actions like sending emails.
4. For Windows commands (like execute_command), NEVER use literal newlines (\\n) inside string arguments (e.g. --body). Put the entire string on a single line, otherwise the command will crash.
5. ALWAYS use forward slashes (/) for file paths instead of backslashes (\\), even on Windows, to avoid JSON parsing errors.

Respond naturally and conversationally. Keep responses concise and engaging.`;
}

export class ContextManager {
    private maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '32000', 10);
    private historySummary = "";

    /**
     * Phase 35: effective budget clamps the configured limit to the selected
     * model's real context window when the provider exposes one (e.g.
     * OpenRouter discovery). Token logic stays here — single source of truth.
     */
    private effectiveBudget(): number {
        try {
            const modelLimit = ModelRouter.getContextLimit();
            if (typeof modelLimit === 'number' && modelLimit > 0) {
                // Leave headroom for the response itself.
                return Math.min(this.maxTokens, Math.max(2048, modelLimit - (parseInt(process.env.MAX_OUTPUT_TOKENS || '4096', 10))));
            }
        } catch { /* router not initialized yet */ }
        return this.maxTokens;
    }

    // Very lightweight estimation fallback
    public estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    public async compactConversation(history: any[]): Promise<string> {
        if (history.length === 0) return "";
        const historyText = history.map(msg => `${msg.role}: ${msg.parts[0]?.text || ''}`).join('\n');
        
        const prompt = `You are a context compressor. Summarize the following conversation history.
Preserve current goals, important decisions, user requirements, project context, and unresolved issues.
Do not preserve irrelevant small talk.

HISTORY:
${historyText.substring(0, 50000)}

Respond with a concise markdown summary.`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['fast'], intent: 'compaction', maxTokens: 1500 },
                [{ role: 'user', content: prompt }]
            );
            
            let replyText = "";
            if (data.content && Array.isArray(data.content)) {
                for (const part of data.content) {
                    if (part.type === "text" && part.text) replyText += part.text;
                }
            } else if (data.choices && data.choices[0]?.message?.content) {
                replyText = data.choices[0].message.content;
            }

            return replyText.trim();
        } catch (err: any) {
            console.error(chalk.red(`[COMPACTION ERROR] ${err.message}`));
            return "Compaction error occurred.";
        }
    }

    public async buildContext(input: ContextBuildInput): Promise<{ finalPrompt: string, prunedHistory: any[], stats: any }> {
        // Priority layering
        // 1. System Context (CRITICAL)
        // 2. Task State (CRITICAL)
        // 3. Current User Request (CRITICAL)
        // 4. Memory / Active Skills (HIGH)
        // 5. Recent Conversation (MEDIUM)

        let tokensSys = this.estimateTokens(input.systemInstructions);
        let tokensTask = this.estimateTokens(input.taskState || "");
        let tokensInput = this.estimateTokens(input.currentInput);
        let tokensMemory = this.estimateTokens(input.memory);
        let tokensSkills = this.estimateTokens(input.activeSkills);
        let tokensSummary = this.estimateTokens(this.historySummary);
        
        let prunedHistory = [...input.chatHistory];
        let historyText = prunedHistory.map(m => m.parts[0]?.text || '').join('\n');
        let tokensHistory = this.estimateTokens(historyText);

        let total = tokensSys + tokensTask + tokensInput + tokensMemory + tokensSkills + tokensSummary + tokensHistory;

        const budget = this.effectiveBudget();
        let compacted = false;
        if (total > budget * 0.85) {
            console.log(chalk.yellow(`[CONTEXT] Usage exceeds 85% (${total} / ${budget}). Initiating emergency compaction...`));

            // Compact the oldest messages, keep the 5 most recent
            const oldHistory = prunedHistory.slice(0, Math.max(0, prunedHistory.length - 5));
            if (oldHistory.length > 0) {
                const newSummary = await this.compactConversation(oldHistory);
                this.historySummary = this.historySummary ? `${this.historySummary}\n\nUpdate:\n${newSummary}` : newSummary;

                // Prune
                prunedHistory = prunedHistory.slice(Math.max(0, prunedHistory.length - 5));
                historyText = prunedHistory.map(m => m.parts[0]?.text || '').join('\n');
                tokensHistory = this.estimateTokens(historyText);
                tokensSummary = this.estimateTokens(this.historySummary);
                compacted = true;
            }

            total = tokensSys + tokensTask + tokensInput + tokensMemory + tokensSkills + tokensSummary + tokensHistory;
            if (total > budget) {
                console.log(chalk.red(`[CONTEXT] Still exceeding bounds! Pruning Memory and Skills...`));
                input.memory = "";
                input.activeSkills = "";
                tokensMemory = 0;
                tokensSkills = 0;
            }
        }

        let assembledPrompt = `${input.systemInstructions}\n\n`;
        if (input.activeSkills) assembledPrompt += `${input.activeSkills}\n\n`;
        if (input.memory) assembledPrompt += `${input.memory}\n\n`;
        if (this.historySummary) assembledPrompt += `[PREVIOUS CONVERSATION SUMMARY]\n${this.historySummary}\n\n`;
        if (input.taskState) assembledPrompt += `[ACTIVE TASK STATE]\n${input.taskState}\n\n`;
        assembledPrompt += `[CURRENT USER REQUEST]\n${input.currentInput}`;

        return {
            finalPrompt: assembledPrompt,
            prunedHistory,
            stats: {
                budget,
                usage: total,
                percent: Math.round((total / budget) * 100),
                compacted
            }
        };
    }
}
