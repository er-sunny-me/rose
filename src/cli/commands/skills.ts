import chalk from 'chalk';
import { SkillRegistry } from '../../skills.js';
import type { CommandArgs } from '../context.js';

/** /skills /skill */
export async function handleSkillsCommands(_ctx: unknown, args: CommandArgs): Promise<boolean | void> {
  const { arg, parts } = args;

  switch (parts[0].toLowerCase()) {
    case '/skills':
    case '/skill':
      if (arg === 'reload') {
        console.log(chalk.cyan('\nReloading skills...'));
        await SkillRegistry.reload();
        const loadedSkills = SkillRegistry.list();
        for (const s of loadedSkills) {
          console.log(s.isValid ? chalk.green(`✓ ${s.name}`) : chalk.red(`✗ ${s.name} (${s.error})`));
        }
        console.log(chalk.cyan(`\n${loadedSkills.length} skills loaded.\n`));
      } else if (arg && arg !== 'info') {
        // handles /skills <name> or /skills info <name>
        const targetName = arg === 'info' && parts[2] ? parts[2] : arg;
        const skill = SkillRegistry.get(targetName);
        if (skill) {
          console.log(chalk.cyan(`\n${skill.name.toUpperCase()}`));
          console.log(chalk.white(`Description:\n${skill.description}`));
          if (skill.capabilities && skill.capabilities.length > 0) {
            console.log(chalk.white(`\nCapabilities:\n- ${skill.capabilities.join('\n- ')}`));
          }
          if (skill.tools && skill.tools.length > 0) {
            console.log(chalk.white(`\nTools:\n- ${skill.tools.join('\n- ')}`));
          }
          if (!skill.isValid) {
            console.log(chalk.red(`\nStatus: Error - ${skill.error}`));
          }
          console.log();
        } else {
          console.log(chalk.red(`❌ Unknown skill: ${targetName}\n`));
        }
      } else {
        // List all
        console.log(chalk.cyan('\nAvailable Skills:\n'));
        const loadedSkills = SkillRegistry.list();
        for (const s of loadedSkills) {
          console.log(chalk.white(s.name));
        }
        console.log();
      }
      break;
    default:
      return false;
  }
  return false;
}
