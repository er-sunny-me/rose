import chalk from 'chalk';
import { CapabilityRouter } from '../../capabilities.js';
import { ExternalServiceManager } from '../../services.js';
import { ExtensionRegistry } from '../../extensions.js';
import { McpClientManager } from '../../mcp.js';
import { ModelRouter } from '../../router.js';
import { TrustRegistry } from '../../federation/trust.js';
import { AgentRegistry } from '../../agents.js';
import type { CommandArgs } from '../context.js';

/** /agents /agent /capabilities /services /connections /extensions /mcp /models /providers */
export async function handleFederationCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts } = args;

  switch (cmd) {
    case '/capabilities': {
      const caps = CapabilityRouter.getAvailableCapabilities();
      console.log(chalk.cyan('\n🔧 Available Capabilities:'));
      for (const [cap, available] of Object.entries(caps)) {
        if (available) {
          console.log(chalk.green(`  ✓ ${cap}`));
        } else {
          console.log(chalk.red(`  ✗ ${cap}`));
        }
      }
      console.log();
      break;
    }

    case '/services':
    case '/connections': {
      const services = ExternalServiceManager.getServices();
      console.log(chalk.cyan('\n🔌 Connected Services:'));
      for (const s of services) {
        if (s.status === 'available') {
          console.log(chalk.green(`  ✓ ${s.name} (connected)`));
        } else {
          console.log(chalk.red(`  ✗ ${s.name} (disconnected)`));
        }
      }
      console.log(chalk.gray(`\nTo connect, add tokens to your .env file.\n`));
      break;
    }

    case '/extensions': {
      const extensions = ExtensionRegistry.getExtensions();
      console.log(chalk.cyan('\n🧩 Loaded Extensions:'));
      if (extensions.length === 0) console.log(chalk.gray(`  No extensions loaded.`));
      for (const ext of extensions) {
        console.log(chalk.green(`  ✓ ${ext.name} (${ext.type}) v${ext.version}`));
      }
      console.log();
      break;
    }

    case '/mcp': {
      const mcpServers = McpClientManager.getClientStatuses();
      console.log(chalk.cyan('\n🔌 MCP Servers:'));
      if (mcpServers.length === 0) console.log(chalk.gray(`  No MCP servers connected.`));
      for (const mcp of mcpServers) {
        console.log(chalk.green(`  ✓ ${mcp.id} (connected)`));
      }
      console.log();
      break;
    }

    case '/models':
    case '/providers':
      console.log(chalk.cyan('\n🌐 Model Providers'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      {
        const providers = ModelRouter.getProviders();
        for (const p of providers) {
          const status = p.health === 'HEALTHY' ? chalk.green('✓ HEALTHY') : (p.health === 'DEGRADED' ? chalk.yellow('⚠ DEGRADED') : chalk.red('✗ OPEN (BLOCKED)'));
          console.log(`${chalk.white(p.name)} [${chalk.gray(p.id)}] - ${status}`);
        }
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    case '/agent': {
      // The original switch had unreachable multi-token cases; this sub-router
      // makes `/agent inspect|trust|revoke` actually reachable.
      const sub = arg?.toLowerCase();
      if (sub === 'inspect') {
        const targetId = parts[2];
        if (!targetId) {
          console.log(chalk.red('Usage: /agent inspect <agentId>'));
          break;
        }
        const fAgent = TrustRegistry.getAgent(targetId);
        if (fAgent) {
          console.log(chalk.cyan(`\n🔍 Agent Inspector:`));
          console.log(chalk.white(`  ID: ${fAgent.id}`));
          console.log(chalk.white(`  Name: ${fAgent.identity.name || 'Unknown'}`));
          console.log(chalk.white(`  Endpoint: ${fAgent.endpoint}`));
          console.log(chalk.white(`  Trust: ${fAgent.trust}`));
          console.log(chalk.white(`  Status: ${fAgent.status}`));
          console.log(chalk.white(`  Capabilities: ${fAgent.identity.capabilities.join(', ')}`));
        } else {
          console.log(chalk.yellow(`No federated agent found with ID ${targetId}`));
        }
      } else if (sub === 'trust') {
        const trustId = parts[2];
        const level = parts[3];
        if (!trustId || !level) {
          console.log(chalk.red('Usage: /agent trust <agentId> <trusted|restricted|blocked>'));
          break;
        }
        if (['trusted', 'restricted', 'blocked'].includes(level)) {
          TrustRegistry.setTrust(trustId, level as any);
          console.log(chalk.green(`✓ Set trust level of ${trustId} to ${level}`));
        } else {
          console.log(chalk.red(`Invalid trust level: ${level}`));
        }
      } else if (sub === 'revoke') {
        const revokeId = parts[2];
        if (!revokeId) {
          console.log(chalk.red('Usage: /agent revoke <agentId>'));
          break;
        }
        TrustRegistry.setTrust(revokeId, 'revoked');
        console.log(chalk.green(`✓ Revoked trust for ${revokeId}. All future interactions will be blocked.`));
      } else {
        console.log(chalk.yellow('Usage: /agent <inspect|trust|revoke> <agentId> [...]'));
      }
      break;
    }

    case '/agents': {
      // Federated agents first…
      const federated = TrustRegistry.getAllAgents();
      if (federated.length > 0) {
        console.log(chalk.bold.cyan('\n🌐 Federated Agents:\n'));
        federated.forEach(a => {
          const color = a.status === 'online' ? chalk.green : chalk.gray;
          const trustColor = a.trust === 'trusted' ? chalk.green : (a.trust === 'revoked' || a.trust === 'blocked' ? chalk.red : chalk.yellow);
          console.log(`  ${color('●')} ${a.id.padEnd(20)} | Trust: ${trustColor(a.trust.padEnd(10))} | Caps: ${a.identity.capabilities.length}`);
        });
      } else {
        console.log(chalk.gray('\nNo federated agents connected.'));
      }

      // …then local specialist roster (was unreachable in the old duplicate case).
      AgentRegistry.discover();
      console.log(chalk.cyan('\n🤖 Specialist Agents'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      const agents = AgentRegistry.list();
      for (const agent of agents) {
        const healthIcon = agent.health === 'HEALTHY' ? chalk.green('✓') : (agent.health === 'DEGRADED' ? chalk.yellow('⚠') : chalk.red('✗'));
        const enabledStr = agent.enabled ? '' : chalk.red(' [DISABLED]');
        console.log(`${healthIcon} ${chalk.white(agent.name)} [${chalk.gray(agent.id)}]${enabledStr}`);
        console.log(`  ${agent.description}`);
        console.log(`  Access: ${chalk.cyan(agent.accessMode)} | Trust: ${chalk.cyan(agent.trustLevel)} | Failures: ${agent.consecutiveFailures}`);
        console.log(`  Skills: ${agent.skills.join(', ')} | Tools: ${agent.allowedTools.join(', ')}`);
        console.log(`  Limits: ${agent.limits.maxToolCalls} tools, ${agent.limits.maxModelCalls} model calls, ${(agent.limits.maxRuntimeMs / 1000)}s timeout\n`);
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    default:
      return false;
  }
  return false;
}
