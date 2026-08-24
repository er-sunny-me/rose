import fs from 'fs';
import { Config } from './config.js';

export type ServiceStatus = "available" | "disconnected" | "error";

export interface ExternalService {
    id: string;
    name: string;
    status: ServiceStatus;
}

/**
 * Phase 34: real configuration-aware service detection.
 * GitHub  → GITHUB_TOKEN env or keys.github
 * Google  → GOOGLE_CREDENTIALS token file (shared by Gmail + Calendar)
 */
export class ExternalServiceManager {

    private static hasGoogleCredentials(): boolean {
        if (process.env.GOOGLE_CREDENTIALS) {
            try { return fs.existsSync(process.env.GOOGLE_CREDENTIALS); } catch { return false; }
        }
        return false;
    }

    public static getServices(): ExternalService[] {
        const cfg = Config.get();
        const githubReady = !!(process.env.GITHUB_TOKEN || cfg.keys?.github);
        // Legacy single-token vars still count as partial readiness signals,
        // but the full integration requires the OAuth tokens file.
        const googleReady = this.hasGoogleCredentials()
            || !!process.env.GOOGLE_CALENDAR_TOKEN
            || !!process.env.GMAIL_TOKEN;

        return [
            {
                id: 'github',
                name: 'GitHub',
                status: githubReady ? 'available' : 'disconnected',
            },
            {
                id: 'calendar',
                name: 'Google Calendar',
                status: googleReady ? 'available' : 'disconnected',
            },
            {
                id: 'email',
                name: 'Gmail',
                status: googleReady ? 'available' : 'disconnected',
            }
        ];
    }

    public static getService(id: string): ExternalService | undefined {
        return this.getServices().find(s => s.id === id);
    }
}
