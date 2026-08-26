import * as cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { Telemetry } from './telemetry.js';
import { SecurityEngine, AutonomyMode } from './security.js';
import { roseDataPath } from './storage-paths.js';

export interface AutomationTrigger {
    type: 'cron' | 'condition';
    value: string;
}

export interface AutomationAction {
    type: 'task' | 'handler';
    goal: string;
}

/**
 * Phase 36: built-in service handlers automations can invoke directly
 * (reuses the SAME node-cron scheduler — no second cron implementation).
 */
export class AutomationHandlers {
    private static registry = new Map<string, () => Promise<any>>();

    public static register(name: string, fn: () => Promise<any>): void {
        this.registry.set(name, fn);
    }

    public static async run(name: string): Promise<any> {
        const fn = this.registry.get(name);
        if (!fn) throw new Error(`No automation handler registered for '${name}'`);
        return fn();
    }
}

export interface Automation {
    id: string;
    name: string;
    enabled: boolean;
    trigger: AutomationTrigger;
    action: AutomationAction;
    createdAt: number;
    updatedAt: number;
}

export class AutomationEngine {
    private static automations: Map<string, Automation> = new Map();
    private static activeTasks: Map<string, cron.ScheduledTask> = new Map();
    private static runningAutomations: Set<string> = new Set(); // For Reentrancy protection
    private static dataPath = roseDataPath('data', 'automations.json');
    public static executeTaskHook: ((goal: string) => Promise<any>) | null = null;

    public static initialize() {
        if (!fs.existsSync(path.dirname(this.dataPath))) {
            fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
        }
        
        if (fs.existsSync(this.dataPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
                for (const auto of data) {
                    this.automations.set(auto.id, auto);
                }
            } catch (e) {
                console.warn(chalk.yellow("âš ï¸ Failed to parse automations.json"));
            }
        }

        this.scheduleAll();
    }

    private static save() {
        const data = Array.from(this.automations.values());
        fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf-8');
    }

    private static scheduleAll() {
        for (const task of this.activeTasks.values()) {
            task.stop();
        }
        this.activeTasks.clear();

        for (const auto of this.automations.values()) {
            if (auto.enabled && auto.trigger.type === 'cron') {
                const task = cron.schedule(auto.trigger.value, async () => {
                    await this.runAutomation(auto.id);
                });
                this.activeTasks.set(auto.id, task);
            }
        }
    }

    public static async runAutomation(id: string) {
        const auto = this.automations.get(id);
        if (!auto) return;

        // Reentrancy Check
        if (this.runningAutomations.has(id)) {
            Telemetry.recordEvent('automation.skipped_reentrancy', 'system', 'cancelled', undefined, { automationId: id });
            return;
        }

        this.runningAutomations.add(id);
        Telemetry.recordEvent('automation.run_started', 'system', 'started', undefined, { automationId: id, name: auto.name });
        
        try {
            // Check Security: Does the automation have explicit consent to execute? 
            // In Phase 13, all automations require explicit creation approval, 
            // so we assume they operate in safe bounds during background execution, 
            // but the ToolExecutor will still trap any unauthorized actions.
            
            if (auto.action.type === 'handler') {
                await AutomationHandlers.run(auto.action.goal);
            } else if (auto.action.type === 'task' && this.executeTaskHook) {
                await this.executeTaskHook(auto.action.goal);
            }
            
            Telemetry.recordEvent('automation.run_completed', 'system', 'completed', undefined, { automationId: id });
        } catch (e: any) {
            Telemetry.recordEvent('automation.run_failed', 'system', 'failed', undefined, { automationId: id, error: e.message });
        } finally {
            this.runningAutomations.delete(id);
        }
    }

    public static create(name: string, cronExp: string, goal: string): string {
        const id = uuidv4();
        const auto: Automation = {
            id,
            name,
            enabled: true,
            trigger: { type: 'cron', value: cronExp },
            action: { type: 'task', goal },
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.automations.set(id, auto);
        this.save();
        this.scheduleAll();
        return id;
    }

    /** Phase 36: register a cron automation backed by a built-in handler. */
    public static registerHandlerAutomation(name: string, cronExp: string, handlerName: string): string {
        const id = uuidv4();
        const auto: Automation = {
            id,
            name,
            enabled: true,
            trigger: { type: 'cron', value: cronExp },
            action: { type: 'handler', goal: handlerName },
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.automations.set(id, auto);
        this.save();
        this.scheduleAll();
        return id;
    }

    public static pause(id: string): boolean {
        const auto = this.automations.get(id);
        if (auto) {
            auto.enabled = false;
            auto.updatedAt = Date.now();
            this.save();
            this.scheduleAll();
            return true;
        }
        return false;
    }

    public static resume(id: string): boolean {
        const auto = this.automations.get(id);
        if (auto) {
            auto.enabled = true;
            auto.updatedAt = Date.now();
            this.save();
            this.scheduleAll();
            return true;
        }
        return false;
    }

    public static cancel(id: string): boolean {
        const success = this.automations.delete(id);
        if (success) {
            this.save();
            this.scheduleAll();
        }
        return success;
    }

    public static list(): Automation[] {
        return Array.from(this.automations.values());
    }
}

