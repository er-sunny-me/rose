import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ToolRegistry } from './tools.js';

export interface SkillDefinition {
  name: string;
  description: string;
  version?: string;
  category?: string;
  keywords?: string[];
  capabilities?: string[];
  tools?: string[];
  path: string;
  isValid: boolean;
  error?: string;
}

export class SkillRegistry {
  private static skills: Map<string, SkillDefinition> = new Map();
  private static skillsDir = path.join(process.cwd(), 'skills');

  public static async discover(): Promise<void> {
    this.skills.clear();
    
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }

    const dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const dir of dirs) {
      this.loadMetadata(dir);
    }
  }

  private static loadMetadata(dir: string): void {
    const skillPath = path.join(this.skillsDir, dir, 'SKILL.md');
    
    if (!fs.existsSync(skillPath)) {
      return; // Skip if no SKILL.md
    }

    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      
      // Simple regex parser for YAML frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      
      const skill: SkillDefinition = {
        name: dir, // Default to directory name
        description: 'No description provided.',
        path: skillPath,
        isValid: true
      };

      if (frontmatterMatch) {
        const yaml = frontmatterMatch[1];
        
        // Extract basic fields
        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        if (nameMatch) skill.name = nameMatch[1].trim();

        const descMatch = yaml.match(/^description:\s*(.+)$/m);
        if (descMatch) skill.description = descMatch[1].trim();

        const catMatch = yaml.match(/^category:\s*(.+)$/m);
        if (catMatch) skill.category = catMatch[1].trim();
        
        // Extract lists
        const extractList = (key: string) => {
           const match = yaml.match(new RegExp(`^${key}:\\s*\\n(?:\\s+-\\s+.+\\n?)+`, 'm'));
           if (match) {
               return match[0].split('\n')
                   .filter(l => l.trim().startsWith('-'))
                   .map(l => l.replace(/^\s*-\s*/, '').trim());
           }
           return [];
        };

        skill.keywords = extractList('keywords');
        skill.capabilities = extractList('capabilities');
        skill.tools = extractList('tools');
      }

      this.validateSkill(skill);
      this.skills.set(skill.name.toLowerCase(), skill);

    } catch (e: any) {
      this.skills.set(dir, {
        name: dir,
        description: 'Failed to load',
        path: skillPath,
        isValid: false,
        error: e.message
      });
    }
  }

  private static validateSkill(skill: SkillDefinition): void {
    if (!skill.name) {
      skill.isValid = false;
      skill.error = 'Missing required: name';
      return;
    }
    if (!skill.description) {
      skill.isValid = false;
      skill.error = 'Missing required: description';
      return;
    }
    
    // Validate tools against ToolRegistry
    if (skill.tools && skill.tools.length > 0) {
      const availableTools = ToolRegistry.getDeclarations().map(t => t.name);
      for (const t of skill.tools) {
        if (!availableTools.includes(t)) {
          skill.isValid = false;
          skill.error = `Missing required tool: ${t}`;
          return;
        }
      }
    }
  }

  public static list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  public static get(name: string): SkillDefinition | undefined {
    return this.skills.get(name.toLowerCase());
  }

  public static load(name: string): string | undefined {
    const skill = this.get(name);
    if (!skill || !skill.isValid) return undefined;
    
    try {
      return fs.readFileSync(skill.path, 'utf8');
    } catch {
      return undefined;
    }
  }

  public static async reload(): Promise<void> {
    await this.discover();
  }
}
