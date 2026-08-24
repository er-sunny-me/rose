import crypto from 'crypto';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { Incident, IncidentSeverity, IncidentStatus, IncidentEvent } from './models.js';
import { EventStore } from '../runtime/events.js';
import { Telemetry } from '../telemetry.js';

export class IncidentManager {
    private static incidents: Map<string, Incident> = new Map();
    private static CACHE_FILE = path.join(process.cwd(), '.gemini', 'incidents.json');
    private static DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 mins

    public static init() {
        if (fs.existsSync(this.CACHE_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.CACHE_FILE, 'utf-8'));
                for (const inc of data) {
                    this.incidents.set(inc.id, inc);
                }
            } catch (e) {
                console.error("Failed to parse incidents.json");
            }
        }
    }

    private static save() {
        const dir = path.dirname(this.CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.CACHE_FILE, JSON.stringify(Array.from(this.incidents.values()), null, 2));
    }

    public static getIncidents(): Incident[] {
        return Array.from(this.incidents.values());
    }

    public static getIncident(id: string): Incident | undefined {
        return this.incidents.get(id);
    }

    public static async reportSymptom(symptom: string, severity: IncidentSeverity = 'medium'): Promise<Incident> {
        // Deduplication
        const now = Date.now();
        for (const inc of this.incidents.values()) {
            if (inc.status !== 'closed' && inc.status !== 'resolved') {
                if (now - inc.updatedAt < this.DEDUPE_WINDOW_MS) {
                    if (inc.symptoms.includes(symptom)) {
                        console.log(chalk.gray(`[IncidentManager] Deduplicated symptom: ${symptom}`));
                        inc.updatedAt = now;
                        this.save();
                        return inc;
                    }
                }
            }
        }

        const incident: Incident = {
            id: crypto.randomBytes(4).toString('hex'),
            title: `Incident: ${symptom}`,
            severity,
            status: 'open',
            symptoms: [symptom],
            hypotheses: [],
            timeline: [{ timestamp: now, description: `Symptom reported: ${symptom}` }],
            actions: [],
            createdAt: now,
            updatedAt: now
        };

        this.incidents.set(incident.id, incident);
        this.save();
        
        await EventStore.append('incident', incident.id, 'incident.created', { incident });
        Telemetry.recordEvent('incident.created', 'system', 'failed', undefined, { incidentId: incident.id, symptom });
        
        console.log(chalk.red(`[IncidentManager] Created new incident: ${incident.id} - ${symptom}`));
        return incident;
    }

    public static async updateStatus(id: string, status: IncidentStatus, message: string) {
        const inc = this.incidents.get(id);
        if (!inc) return;

        inc.status = status;
        inc.updatedAt = Date.now();
        inc.timeline.push({ timestamp: Date.now(), description: `Status changed to ${status}: ${message}` });
        this.save();
        
        await EventStore.append('incident', id, 'incident.status_changed', { status, message });
    }

    public static addTimelineEvent(id: string, event: string) {
        const inc = this.incidents.get(id);
        if (!inc) return;
        inc.timeline.push({ timestamp: Date.now(), description: event });
        inc.updatedAt = Date.now();
        this.save();
    }
}
