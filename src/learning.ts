import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import { Telemetry } from './telemetry.js';

// ──────────────────────────────────────────────────────────
// SECTION 1: INTERFACES & TYPES
// ──────────────────────────────────────────────────────────

export interface AgentFeedback {
    id: string;
    sessionId?: string;
    taskId?: string;
    type: 'positive' | 'negative' | 'correction' | 'preference' | 'instruction';
    target: 'response' | 'tool' | 'skill' | 'model' | 'workflow' | 'automation' | 'research';
    content: string;
    source: 'explicit' | 'inferred';
    createdAt: number;
}

export interface LearnedPreference {
    id: string;
    scope: 'global' | 'project' | 'skill' | 'task';
    projectName?: string; // only if scope === 'project'
    key: string;
    value: any;
    source: 'explicit' | 'inferred';
    confidence: number;
    createdAt: number;
    updatedAt: number;
    lastConfirmedAt?: number;
    lastUsedAt?: number;
    status: 'OBSERVED' | 'CANDIDATE' | 'VALIDATED' | 'PREFERRED' | 'STALE';
}

export interface LearnedStrategy {
    id: string;
    domain: string; // 'coding', 'research', 'testing', etc.
    situation: string;
    steps: string[];
    successCount: number;
    failureCount: number;
    confidence: number;
    sourceTasks: string[];
    createdAt: number;
    updatedAt: number;
    status: 'OBSERVED' | 'CANDIDATE' | 'VALIDATED' | 'PREFERRED' | 'STALE' | 'DEMOTED';
}

export interface FailurePattern {
    id: string;
    description: string;
    preventionHint: string;
    occurrences: number;
    lastSeenAt: number;
}

// ──────────────────────────────────────────────────────────
// SECTION 2: LEARNING STORE
// ──────────────────────────────────────────────────────────

export class LearningStore {
    private static BASE_DIR = path.join(process.cwd(), 'learning');
    private static DIRS = ['preferences', 'strategies', 'failures', 'feedback'];

    public static init() {
        if (!fs.existsSync(this.BASE_DIR)) {
            fs.mkdirSync(this.BASE_DIR, { recursive: true });
        }
        for (const dir of this.DIRS) {
            const p = path.join(this.BASE_DIR, dir);
            if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        }
    }

    private static writeJson(subDir: string, id: string, data: any) {
        const p = path.join(this.BASE_DIR, subDir, `${id}.json`);
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    }

    private static readAllJson<T>(subDir: string): T[] {
        const dir = path.join(this.BASE_DIR, subDir);
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T;
            } catch (err) {
                return null as any;
            }
        }).filter(Boolean);
    }

    private static deleteJson(subDir: string, id: string): boolean {
        const p = path.join(this.BASE_DIR, subDir, `${id}.json`);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            return true;
        }
        return false;
    }

    // Preferences
    public static savePreference(pref: LearnedPreference) {
        this.writeJson('preferences', pref.id, pref);
    }
    public static getPreferences(): LearnedPreference[] {
        return this.readAllJson<LearnedPreference>('preferences');
    }
    public static deletePreference(id: string): boolean {
        return this.deleteJson('preferences', id);
    }

    // Strategies
    public static saveStrategy(strat: LearnedStrategy) {
        this.writeJson('strategies', strat.id, strat);
    }
    public static getStrategies(): LearnedStrategy[] {
        return this.readAllJson<LearnedStrategy>('strategies');
    }
    public static deleteStrategy(id: string): boolean {
        return this.deleteJson('strategies', id);
    }

    // Failures
    public static saveFailurePattern(fp: FailurePattern) {
        this.writeJson('failures', fp.id, fp);
    }
    public static getFailurePatterns(): FailurePattern[] {
        return this.readAllJson<FailurePattern>('failures');
    }

    // Feedback
    public static saveFeedback(fb: AgentFeedback) {
        this.writeJson('feedback', fb.id, fb);
    }

    public static resetAll() {
        for (const dir of this.DIRS) {
            const fullDir = path.join(this.BASE_DIR, dir);
            if (fs.existsSync(fullDir)) {
                fs.rmSync(fullDir, { recursive: true, force: true });
                fs.mkdirSync(fullDir);
            }
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 3: PREFERENCE MANAGER
// ──────────────────────────────────────────────────────────

export class PreferenceManager {
    /**
     * Resolves preferences by precedence:
     * Project Explicit > Global Explicit > Project Inferred > Global Inferred
     */
    public static getPreference(key: string, currentProject?: string): any | undefined {
        const prefs = LearningStore.getPreferences().filter(p => p.key === key && p.status !== 'STALE');
        
        // Decay check
        this.applyDecay(prefs);

        // Precedence sorting
        prefs.sort((a, b) => {
            // 1. Explicit vs Inferred
            if (a.source === 'explicit' && b.source === 'inferred') return -1;
            if (a.source === 'inferred' && b.source === 'explicit') return 1;

            // 2. Project scope matches vs global
            if (currentProject) {
                if (a.scope === 'project' && a.projectName === currentProject && b.scope === 'global') return -1;
                if (b.scope === 'project' && b.projectName === currentProject && a.scope === 'global') return 1;
            }

            // 3. Confidence fallback
            return b.confidence - a.confidence;
        });

        const selected = prefs[0];
        if (selected) {
            selected.lastUsedAt = Date.now();
            LearningStore.savePreference(selected);
            return selected.value;
        }

        return undefined;
    }

    public static getAllActiveContext(currentProject?: string): string {
        const prefs = LearningStore.getPreferences().filter(p => p.status === 'PREFERRED' || p.status === 'VALIDATED' || p.source === 'explicit');
        const relevant = prefs.filter(p => p.scope === 'global' || (p.scope === 'project' && p.projectName === currentProject));
        if (relevant.length === 0) return '';
        
        return `[Learned Preferences]\n` + relevant.map(p => `- ${p.key}: ${p.value}`).join('\n');
    }

    public static recordExplicitPreference(key: string, value: any, scope: 'global' | 'project' = 'global', projectName?: string) {
        const existing = LearningStore.getPreferences().find(p => p.key === key && p.scope === scope && p.projectName === projectName);
        const pref: LearnedPreference = existing || {
            id: crypto.randomBytes(4).toString('hex'),
            scope,
            projectName,
            key,
            value,
            source: 'explicit',
            confidence: 1.0,
            status: 'PREFERRED',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        pref.value = value;
        pref.updatedAt = Date.now();
        pref.lastConfirmedAt = Date.now();
        pref.status = 'PREFERRED';
        pref.confidence = 1.0;

        LearningStore.savePreference(pref);
        Telemetry.recordEvent('learning.preference.recorded', 'agent', 'completed', undefined, { key, scope, source: 'explicit' });
    }

    public static recordInferredPreference(key: string, value: any, scope: 'global' | 'project' = 'global', projectName?: string) {
        const existing = LearningStore.getPreferences().find(p => p.key === key && p.scope === scope && p.projectName === projectName);
        
        if (existing) {
            if (existing.source === 'explicit') return; // explicit wins
            existing.confidence = Math.min(0.95, existing.confidence + 0.1);
            existing.updatedAt = Date.now();
            if (existing.confidence > 0.7) existing.status = 'VALIDATED';
            if (existing.confidence > 0.9) existing.status = 'PREFERRED';
            LearningStore.savePreference(existing);
        } else {
            const pref: LearnedPreference = {
                id: crypto.randomBytes(4).toString('hex'),
                scope,
                projectName,
                key,
                value,
                source: 'inferred',
                confidence: 0.3, // starts low
                status: 'OBSERVED',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            LearningStore.savePreference(pref);
        }
    }

    private static applyDecay(prefs: LearnedPreference[]) {
        const NOW = Date.now();
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        
        for (const p of prefs) {
            if (p.source === 'explicit') continue; // explicit doesn't decay automatically
            
            const age = NOW - Math.max(p.lastUsedAt || 0, p.lastConfirmedAt || 0, p.updatedAt);
            if (age > THIRTY_DAYS) {
                p.confidence *= 0.5; // Halve confidence
                p.status = 'STALE';
                LearningStore.savePreference(p);
            }
        }
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 4: STRATEGY LEARNER
// ──────────────────────────────────────────────────────────

export class StrategyLearner {
    public static recordTaskOutcome(domain: string, situation: string, steps: string[], success: boolean, taskId: string) {
        const strats = LearningStore.getStrategies();
        // Simple matching logic based on domain and situation similarity
        let strat = strats.find(s => s.domain === domain && s.situation === situation);

        if (!strat) {
            strat = {
                id: crypto.randomBytes(4).toString('hex'),
                domain,
                situation,
                steps,
                successCount: 0,
                failureCount: 0,
                confidence: 0,
                sourceTasks: [],
                status: 'OBSERVED',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
        }

        if (success) {
            strat.successCount++;
        } else {
            strat.failureCount++;
        }
        
        strat.sourceTasks.push(taskId);
        if (strat.sourceTasks.length > 20) strat.sourceTasks.shift();
        
        const total = strat.successCount + strat.failureCount;
        const ratio = strat.successCount / total;
        
        strat.confidence = ratio * Math.min(1.0, total / 5); // Needs at least 5 runs to approach full confidence

        if (total >= 5) {
            if (ratio > 0.8) strat.status = 'PREFERRED';
            else if (ratio > 0.6) strat.status = 'VALIDATED';
            else if (ratio < 0.3) strat.status = 'DEMOTED';
        }

        strat.updatedAt = Date.now();
        LearningStore.saveStrategy(strat);
    }

    public static getRelevantStrategies(domain: string, situation: string): LearnedStrategy[] {
        // Find strategies that match the domain and have good standing
        const strats = LearningStore.getStrategies().filter(s => 
            s.domain === domain && 
            (s.status === 'PREFERRED' || s.status === 'VALIDATED')
        );

        // Substring match on situation as a naive heuristic
        return strats.filter(s => 
            s.situation.includes(situation) || situation.includes(s.situation)
        ).sort((a, b) => b.confidence - a.confidence);
    }

    public static recordFailurePattern(description: string, preventionHint: string) {
        const patterns = LearningStore.getFailurePatterns();
        let p = patterns.find(pat => pat.description === description);
        if (p) {
            p.occurrences++;
            p.lastSeenAt = Date.now();
        } else {
            p = {
                id: crypto.randomBytes(4).toString('hex'),
                description,
                preventionHint,
                occurrences: 1,
                lastSeenAt: Date.now()
            };
        }
        LearningStore.saveFailurePattern(p);
    }

    public static getActiveFailurePatterns(): FailurePattern[] {
        // Return highly occurring patterns
        return LearningStore.getFailurePatterns().filter(p => p.occurrences >= 2);
    }
}

// ──────────────────────────────────────────────────────────
// SECTION 5: FEEDBACK PROCESSOR
// ──────────────────────────────────────────────────────────

export class FeedbackProcessor {
    public static processFeedback(message: string) {
        const feedback: AgentFeedback = {
            id: crypto.randomBytes(4).toString('hex'),
            type: 'instruction',
            target: 'workflow',
            content: message,
            source: 'explicit',
            createdAt: Date.now()
        };
        LearningStore.saveFeedback(feedback);

        // VERY simple heuristic to capture explicit preferences from natural language
        const lower = message.toLowerCase();
        if (lower.includes("always use pnpm") || lower.includes("use pnpm")) {
            PreferenceManager.recordExplicitPreference('package_manager', 'pnpm');
        } else if (lower.includes("always use npm") || lower.includes("use npm")) {
            PreferenceManager.recordExplicitPreference('package_manager', 'npm');
        } else if (lower.includes("short") || lower.includes("concise")) {
            PreferenceManager.recordExplicitPreference('response_style', 'concise');
        } else if (lower.includes("detailed") || lower.includes("long")) {
            PreferenceManager.recordExplicitPreference('response_style', 'detailed');
        } else if (lower.includes("hinglish")) {
            PreferenceManager.recordExplicitPreference('language', 'Hinglish');
        } else {
            // General preference
            PreferenceManager.recordExplicitPreference(`custom_${Date.now()}`, message);
        }
    }
}
