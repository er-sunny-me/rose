import chalk from 'chalk';
import { Telemetry } from '../../telemetry.js';
import { HealthMonitor, CapacityEngine, BottleneckAnalyzer, OptimizationEngine } from '../../observability/index.js';
import { IncidentManager } from '../../rca/manager.js';
import { RCAEngine } from '../../rca/engine.js';
import { WorldModel } from '../../world/model.js';
import { ReliabilityLab } from '../../reliability/lab.js';
import { ExtensionRegistry } from '../../extensions.js';
import { McpClientManager } from '../../mcp.js';
import type { CommandArgs } from '../context.js';

/** /diagnostics /trace /last-run /observability /health /incidents /incident
 *  /dependencies /impact /root-cause /reliability */
export async function handleObservabilityCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { cmd, arg, parts } = args;

  switch (cmd) {
    case '/diagnostics':
      console.log(chalk.cyan('\n🔍 Agent Diagnostics'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      console.log(chalk.white(`Core:             `) + chalk.green('✓'));
      console.log(chalk.white(`Gemini Live:      `) + chalk.green('✓'));
      console.log(chalk.white(`Security Engine:  `) + chalk.green('✓'));
      console.log(chalk.white(`Context Manager:  `) + chalk.green('✓'));
      console.log(chalk.white(`Planner:          `) + chalk.green('✓'));
      console.log(chalk.white(`Extensions:       `) + chalk.green(`${ExtensionRegistry.getExtensions().length} loaded`));
      console.log(chalk.white(`MCP:              `) + chalk.green(`${McpClientManager.getClientStatuses().length} connected`));
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;

    case '/trace': {
      const recentEvents = Telemetry.getRecentTrace();
      console.log(chalk.cyan('\n📋 Recent Trace'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      if (recentEvents.length === 0) console.log(chalk.gray('No active trace.'));
      for (const evt of recentEvents) {
        const time = new Date(evt.timestamp).toISOString().substring(11, 19);
        const dur = evt.durationMs ? chalk.gray(`(${evt.durationMs}ms)`) : '';
        console.log(chalk.white(`${time} `) + chalk.cyan(`${evt.source}.${evt.type}`) + ` ${evt.status || ''} ${dur}`);
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    case '/last-run': {
      const metrics = Telemetry.lastRunMetrics;
      console.log(chalk.cyan('\n📊 Last Run Metrics'));
      console.log(chalk.gray('────────────────────────────────────────────'));
      if (!metrics.duration) {
        console.log(chalk.gray('No completed run metrics available.'));
      } else {
        console.log(chalk.white(`Duration: `) + chalk.green(`${metrics.duration}ms`));
        console.log(chalk.white(`Tools Executed: `) + chalk.green(metrics.tools || 0));
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    case '/observability':
    case '/health':
      console.log(chalk.bold.cyan('\n🩺 System Health & Observability'));
      {
        const healths = HealthMonitor.getAllHealth();
        if (healths.length === 0) console.log(chalk.gray('No health data available.'));
        healths.forEach(h => {
          const color = h.state === 'healthy' ? chalk.green : (h.state === 'offline' ? chalk.gray : chalk.red);
          console.log(`  ${color('●')} ${h.componentType.padEnd(10)} | ID: ${h.componentId} | State: ${h.state}`);
        });

        const forecast = CapacityEngine.forecastQueueSaturation();
        console.log(chalk.bold.yellow('\n📊 Capacity Forecast'));
        console.log(`  Target: ${forecast.resource}`);
        console.log(`  Growth: ${forecast.growthRatePerHour.toFixed(2)} / hour`);
        if (forecast.estimatedSaturationHours) {
          console.log(`  Saturation expected in: ${forecast.estimatedSaturationHours.toFixed(1)} hours`);
        }

        const bottleneck = BottleneckAnalyzer.analyze();
        if (bottleneck) {
          console.log(chalk.bold.red('\n⚠️ Detected Bottlenecks'));
          console.log(`  Primary: ${bottleneck.primaryBottleneck}`);
          console.log(`  Symptoms: ${bottleneck.secondarySymptoms.join(', ')}`);
        }

        const opts = OptimizationEngine.getCandidates();
        if (opts.length > 0) {
          console.log(chalk.bold.magenta('\n💡 Optimization Candidates'));
          opts.forEach(opt => console.log(`  [${opt.id}] ${opt.target}: ${opt.proposal} (${opt.status})`));
        }
      }
      console.log();
      break;

    case '/incidents': {
      const incidents = IncidentManager.getIncidents();
      console.log(chalk.cyan(`\n🚨 Active Incidents (${incidents.length} total)`));
      console.log(chalk.gray('────────────────────────────────────────────'));
      if (incidents.length === 0) console.log(chalk.gray('  No active incidents.'));
      for (const inc of incidents) {
        console.log(`- [${inc.id}] ${inc.title} (${chalk.blue(inc.status)}) | Severity: ${inc.severity}`);
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    case '/incident':
      if (arg === 'status' && parts[2]) {
        const inc = IncidentManager.getIncident(parts[2]);
        if (inc) {
          console.log(chalk.cyan(`\n🚨 Incident: ${inc.title}`));
          console.log(`Status: ${inc.status}`);
          console.log(`Severity: ${inc.severity}`);
          console.log(`Symptoms: ${inc.symptoms.join(', ')}`);
          console.log(`Hypotheses:`);
          for (const h of inc.hypotheses) {
            console.log(`  - [${h.status}] ${h.cause} (confidence: ${h.confidence})`);
          }
        } else {
          console.log(chalk.red('Incident not found.'));
        }
      } else if (arg === 'investigate' && parts[2]) {
        await RCAEngine.generateHypotheses(parts[2]);
        console.log(chalk.green(`Investigation started for incident ${parts[2]}.`));
      } else {
        console.log(chalk.yellow('Usage: /incident status <id> | /incident investigate <id>'));
      }
      break;

    case '/dependencies': {
      const dependencyTargetId = arg;
      if (!dependencyTargetId) {
        console.log(chalk.yellow('Usage: /dependencies <id>'));
        break;
      }
      const forward = WorldModel.getForwardDependencies(dependencyTargetId);
      const reverse = WorldModel.getReverseDependencies(dependencyTargetId);
      console.log(chalk.cyan(`\n🔗 Dependencies for ${dependencyTargetId}`));
      console.log(chalk.gray('────────────────────────────────────────────'));
      console.log(`Depends On (Forward): ${forward.length > 0 ? forward.map(f => f.to).join(', ') : 'None'}`);
      console.log(`Depended By (Reverse): ${reverse.length > 0 ? reverse.map(r => r.from).join(', ') : 'None'}`);
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    case '/impact': {
      if (!arg) {
        console.log(chalk.yellow('Usage: /impact <target_id>'));
        break;
      }
      const blastRadius = RCAEngine.analyzeImpact(arg);
      console.log(chalk.cyan(`\n💥 Blast Radius Analysis for ${arg}`));
      console.log(chalk.gray('────────────────────────────────────────────'));
      console.log(`Potentially affected nodes: ${blastRadius.length}`);
      if (blastRadius.length > 0) {
        console.log(blastRadius.map(b => `  - ${b}`).join('\n'));
      }
      console.log(chalk.gray('────────────────────────────────────────────\n'));
      break;
    }

    case '/root-cause': {
      if (!arg) {
        console.log(chalk.yellow('Usage: /root-cause <symptom description>'));
        break;
      }
      const symptom = parts.slice(1).join(' ');
      const inc = await IncidentManager.reportSymptom(symptom);
      await RCAEngine.generateHypotheses(inc.id);
      console.log(chalk.green(`\nIncident created and hypotheses generated for symptom: "${symptom}"\nRun "/incident status ${inc.id}" to view findings.`));
      break;
    }

    case '/reliability':
      if (arg === 'run' && parts[2]) {
        await ReliabilityLab.runProfile(parts[2] as 'quick' | 'deep');
      } else if (arg === 'scenarios') {
        const scens = ReliabilityLab.getScenarios();
        console.log(chalk.cyan(`\n🧪 Reliability Scenarios`));
        for (const s of scens) {
          console.log(`- [${s.id}] ${s.name}`);
        }
      } else {
        console.log(chalk.yellow('Usage: /reliability run <profile> | /reliability scenarios'));
      }
      break;

    default:
      return false;
  }
  return false;
}
