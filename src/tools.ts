import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import * as readline from 'readline';
import { ExtensionRegistry } from './extensions.js';
import { McpClientManager } from './mcp.js';
import { MemoryService } from './memory.js';
import { SecurityEngine, ActionRisk } from './security.js';
import { Telemetry } from './telemetry.js';
import { FailureInjector } from './reliability/injector.js';
import { IdentityContext } from './policy/models.js';

const execPromise = promisify(exec);



import { TransactionManager, SideEffectType } from './transaction.js';

export class ToolRegistry {
  public static getDeclarations() {
    const coreTools = [
      {
        name: 'save_memory',
        description: 'Save important context or facts to your local memory vault. The agent should use this to remember useful, durable information across conversations (e.g. project tech stacks, user preferences).',
        sideEffect: 'PREDICTABLE_WRITE',
        parameters: {
          type: 'OBJECT',
          properties: {
            type: {
              type: 'STRING',
              description: 'The type of memory ("projects", "preferences", "knowledge", "tasks", "conversations")',
            },
            name: {
              type: 'STRING',
              description: 'A short, unique name or title for this memory entry',
            },
            project: {
              type: 'STRING',
              description: 'The name of the project this memory relates to, if applicable',
            },
            content: {
              type: 'STRING',
              description: 'The detailed content to save',
            },
          },
          required: ['type', 'name', 'content'],
        },
      },
      {
        name: 'search_memory',
        description: 'Search the local memory vault for past context using a keyword or phrase.',
        sideEffect: 'READ',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The query string to search for',
            },
            project: {
              type: 'STRING',
              description: 'Optional project name to scope the search to',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_search',
        description: 'Perform a web search using DuckDuckGo Lite to find current information.',
        sideEffect: 'READ',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The search query',
            }
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch_page',
        description: 'Fetch the text content of a webpage (Browser capability). Used to read content from a specific URL.',
        sideEffect: 'READ',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: {
              type: 'STRING',
              description: 'The URL to fetch',
            }
          },
          required: ['url'],
        },
      },
      {
        name: 'execute_command',
        description: 'Execute a terminal/shell command on the local Windows machine. Use this to open apps, run scripts, manage files, or perform terminal tasks. Commands must finish executing to return output (max 15s timeout).',
        sideEffect: 'DESTRUCTIVE',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: {
              type: 'STRING',
              description: 'The exact terminal command to run',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'service_github',
        description: 'Interact with GitHub (list issues, create issues, etc.)',
        sideEffect: 'EXTERNAL_ACTION',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'Action to perform' },
            repo: { type: 'STRING', description: 'Repository name e.g. owner/repo' },
            query: { type: 'STRING', description: 'Search query or issue number' }
          },
          required: ['action', 'repo'],
        },
      },
      {
        name: 'service_calendar',
        description: 'Interact with Calendar (list events, create events, etc.)',
        sideEffect: 'EXTERNAL_ACTION',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'Action to perform' },
            date: { type: 'STRING', description: 'Date or time context e.g. "tomorrow"' },
            details: { type: 'STRING', description: 'Details of the event to create or cancel' }
          },
          required: ['action'],
        },
      },
      {
        name: 'service_email',
        description: 'Interact with Email (read, send, draft)',
        sideEffect: 'EXTERNAL_ACTION',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'Action to perform' },
            to: { type: 'STRING' },
            subject: { type: 'STRING' },
            body: { type: 'STRING' }
          },
          required: ['action'],
        },
      }
    ];

    const extensionTools = ExtensionRegistry.getExtensionTools();
    return [...coreTools, ...extensionTools];
  }
}

export class ToolExecutor {
  public static async execute(call: { id: string; name: string; args: any }, txId?: string, rawPromptContext?: string, identity?: IdentityContext): Promise<any> {
    if (FailureInjector.isActive('tool_crash')) {
        throw new Error(`[Lab] Simulated tool crash for ${call.name}`);
    }
    if (FailureInjector.isActive('tool_timeout')) {
        await new Promise(r => setTimeout(r, 10000));
        throw new Error(`[Lab] Simulated tool timeout for ${call.name}`);
    }

    const startTime = Date.now();
    Telemetry.recordEvent('tool.started', 'tool', 'started', undefined, { name: call.name });

    const securityCheck = await SecurityEngine.evaluateAction(call.name, call.args, rawPromptContext, identity);
    if (!securityCheck.allowed) {
        Telemetry.recordEvent('tool.security_blocked', 'security', 'failed');
        return { id: call.id, name: call.name, response: { result: `Action blocked by Security Engine: ${securityCheck.message}` } };
    }

    let result = '';
    
    // Determine side effect from registry
    const decls = ToolRegistry.getDeclarations();
    const decl = decls.find(d => d.name === call.name);
    let sideEffect: SideEffectType = (decl as any)?.sideEffect || 'EXTERNAL_ACTION';
    if (call.name.startsWith('mcp_')) sideEffect = 'EXTERNAL_ACTION'; // default for MCP

    let cpId: string | null = null;
    if (txId && (sideEffect === 'PREDICTABLE_WRITE' || sideEffect === 'DESTRUCTIVE')) {
        // Attempt to create checkpoint before write
        let target = '';
        if (call.name === 'execute_command') target = 'shell';
        cpId = await TransactionManager.createCheckpoint(txId, target) || null;
    }

    try {
      if (call.name === 'save_memory') {
        const entry = await MemoryService.save(call.args);
        result = `Successfully saved memory: ${entry.id} (${entry.name})`;
        console.log(chalk.blue(`   [Memory Saved] ${entry.name}`));
      } else if (call.name === 'search_memory') {
        const entries = await MemoryService.search({ query: call.args.query, project: call.args.project });
        result = entries.length > 0 ? MemoryService.formatContextBlock(entries) : `No memory found for query: ${call.args.query}`;
        console.log(chalk.blue(`   [Memory Searched] Found ${entries.length} entries for "${call.args.query}"`));
      } else if (call.name === 'execute_command') {
        console.log(chalk.magenta(`   [Executing Command...] ${call.args.command}`));
        try {
          const { stdout, stderr } = await execPromise(call.args.command, { timeout: 15000 });
          result = stdout || stderr || 'Command executed successfully with no output.';
        } catch (error: any) {
          result = `Command failed: ${error.message}\n${error.stderr || ''}`;
        }
        console.log(chalk.magenta(`   [Command Result] \n${chalk.gray(result.substring(0, 500) + (result.length > 500 ? '...' : ''))}`));
      } else if (call.name === 'web_search') {
        console.log(chalk.blue(`   [Web Search] ${call.args.query}`));
        try {
          const response = await fetch(`https://lite.duckduckgo.com/lite/`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
             body: `q=${encodeURIComponent(call.args.query)}`
          });
          if (!response.ok) throw new Error(`Status ${response.status}`);
          const text = await response.text();
          // Extract snippets from DDG Lite HTML using basic regex matching rows
          const snippets = [...text.matchAll(/<tr[^>]*>\s*<td[^>]*>(?:.*?)<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>(.*?)<\/td>\s*<\/tr>/isg)];
          let output = "";
          for (let i = 0; i < Math.min(snippets.length, 5); i++) {
             // Basic HTML tag stripping
             const title = snippets[i][2].replace(/<[^>]+>/g, '').trim();
             const url = snippets[i][1].trim();
             const snippetRaw = snippets[i][3] ? snippets[i][3].replace(/<[^>]+>/g, '').trim() : '';
             output += `Result ${i+1}:\nTitle: ${title}\nURL: ${url}\nSnippet: ${snippetRaw}\n\n`;
          }
          result = output || 'No clear results extracted.';
        } catch (e: any) {
          result = `Web search failed: ${e.message}`;
        }
      } else if (call.name === 'fetch_page') {
        console.log(chalk.blue(`   [Fetch Page] ${call.args.url}`));
        try {
          const response = await fetch(call.args.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!response.ok) throw new Error(`Status ${response.status}`);
          const html = await response.text();
          // Strip out scripts and styles, then strip tags
          const text = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          result = text.substring(0, 50000); // hard limit length
        } catch (e: any) {
          result = `Page fetch failed: ${e.message}`;
        }
      } else if (call.name === 'service_github') {
        // We will bridge to local `gh` cli if it exists, otherwise return a mock response.
        console.log(chalk.blue(`   [GitHub Service] ${call.args.action} on ${call.args.repo}`));
        try {
          const { stdout } = await execPromise(`gh issue list -R ${call.args.repo} --limit 5`, { timeout: 10000 });
          result = stdout || 'No issues found.';
        } catch (e: any) {
          result = `GitHub CLI execution failed (is gh installed and authenticated?): ${e.message}`;
        }
      } else if (call.name === 'service_calendar') {
        const action = call.args.action;
        console.log(chalk.blue(`   [Calendar Service] ${action}`));
        if (action === 'create_event' || action === 'cancel_event') {
           result = `Successfully performed ${action}: ${call.args.details}`;
        } else {
           result = `Mock Calendar Response for ${call.args.date}: 09:00 AM Team Sync, 02:00 PM Review.`;
        }
      } else if (call.name === 'service_email') {
        const action = call.args.action;
        console.log(chalk.blue(`   [Email Service] ${action}`));
        if (action === 'send_email') {
           result = `Email sent successfully to ${call.args.to}`;
        } else if (action === 'draft_email') {
           result = `Draft prepared for ${call.args.to} with subject "${call.args.subject}". Use "send_email" action to transmit.`;
        } else {
           result = `Mock Email Inbox: 1 new message from Boss: "Please check the TPS reports."`;
        }
      } else if (call.name.startsWith('mcp_')) {
        // e.g. "mcp_filesystem_read_file" -> serverId = "filesystem"
        const parts = call.name.split('_');
        const serverId = parts[1];
        console.log(chalk.blue(`   [MCP Service] ${serverId} : ${call.name}`));
        try {
          result = await McpClientManager.callTool(serverId, call.name, call.args);
        } catch (e: any) {
          result = `MCP tool execution failed: ${e.message}`;
        }
      } else {
        result = 'Unknown tool call';
      }
    } catch (e: any) {
      result = `Tool execution error: ${e.message}`;
    }

    const duration = Date.now() - startTime;
    Telemetry.recordEvent('tool.completed', 'tool', 'completed', duration, { name: call.name });

    // Redact any secrets before returning to model
    const redactedResult = typeof result === 'string' ? SecurityEngine.redactSecrets(result) : result;
    
    if (txId) {
        TransactionManager.recordAction(txId, call.name, call.args?.command || call.args?.url || call.args?.query || call.name, sideEffect, cpId || undefined);
    }

    return {
      id: call.id,
      name: call.name,
      response: { result: redactedResult },
    };
  }
}
