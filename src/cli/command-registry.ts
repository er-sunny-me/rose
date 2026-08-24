import type { CommandEntry } from './context.js';
import { handleChatCommands } from './commands/chat.js';
import { handleVoiceCommands } from './commands/voice.js';
import { handleSkillsCommands } from './commands/skills.js';
import { handleMemoryCommands } from './commands/memory.js';
import { handleTaskCommands } from './commands/tasks.js';
import { handleGoalCommands } from './commands/goals.js';
import { handleAutomationCommands } from './commands/automation.js';
import { handleSecurityCommands } from './commands/security.js';
import { handleFederationCommands } from './commands/federation.js';
import { handleObservabilityCommands } from './commands/observability.js';

/** All slash commands known to the CLI (drives completion + prefix matching). */
export const CLI_COMMANDS = [
  '/voice', '/text', '/record', '/stop', '/mic', '/devices', '/voices', '/config',
  '/clear', '/history', '/save', '/help', '/exit', '/quit', '/skills', '/skill',
  '/memory', '/task', '/tasks', '/context', '/capabilities', '/services',
  '/connections', '/extensions', '/mcp', '/security', '/diagnostics', '/trace',
  '/last-run', '/models', '/providers', '/automations', '/automation', '/debug',
  '/verbose', '/compact', '/normal', '/sessions', '/session', '/attach', '/detach',
  '/attachments', '/agents', '/agent', '/learning', '/preferences', '/strategies', '/feedback',
  '/simulate', '/transaction', '/transactions', '/runtime', '/events', '/queue',
  '/goals', '/goal', '/world', '/simulations', '/simulation', '/incidents',
  '/incident', '/dependencies', '/impact', '/root-cause', '/reliability',
  '/policies', '/policy', '/maintenance',
];

/**
 * Ordered command registry. The first entry whose `commands` include the
 * invoked token wins — keep more specific handlers above generic ones.
 */
export const COMMAND_REGISTRY: CommandEntry[] = [
  { commands: ['/exit', '/quit'], description: 'Leave Rose', run: handleChatCommands },
  { commands: ['/voice', '/text', '/record', '/stop', '/mic', '/devices', '/voices'], description: 'Voice & audio', run: handleVoiceCommands },
  { commands: ['/skills', '/skill'], description: 'Skill packs', run: handleSkillsCommands },
  { commands: ['/memory', '/learning', '/preferences', '/strategies', '/feedback'], description: 'Memory & learning', run: handleMemoryCommands },
  { commands: ['/task', '/tasks', '/queue'], description: 'Task queue', run: handleTaskCommands },
  { commands: ['/goals', '/goal', '/simulations', '/simulation', '/world'], description: 'Goals, simulations, world model', run: handleGoalCommands },
  { commands: ['/automations', '/automation', '/maintenance'], description: 'Automations & maintenance', run: handleAutomationCommands },
  { commands: ['/security', '/policies', '/policy', '/transactions', '/transaction', '/runtime', '/events'], description: 'Security, policy, runtime', run: handleSecurityCommands },
  { commands: ['/agents', '/agent', '/capabilities', '/services', '/connections', '/extensions', '/mcp', '/models', '/providers'], description: 'Federation, capabilities, providers', run: handleFederationCommands },
  { commands: ['/diagnostics', '/trace', '/last-run', '/observability', '/health', '/incidents', '/incident', '/dependencies', '/impact', '/root-cause', '/reliability'], description: 'Observability & RCA', run: handleObservabilityCommands },
  { commands: ['/clear', '/history', '/save', '/config', '/help', '/debug', '/verbose', '/compact', '/normal', '/sessions', '/session', '/attach', '/detach', '/attachments', '/context'], description: 'Conversation & UI', run: handleChatCommands },
];

/** Find the handler registered for a command token. */
export function findCommandHandler(cmd: string): CommandEntry | undefined {
  return COMMAND_REGISTRY.find(entry => entry.commands.includes(cmd));
}
