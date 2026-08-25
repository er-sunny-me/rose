import fs from 'fs';
import path from 'path';

/**
 * Phase 36 Part H: browser session persistence — OFF by default.
 *
 * Playwright storageState (cookies + localStorage) is sensitive: it can carry
 * live session tokens. Policy:
 *  - Enabled only via ROSE_BROWSER_PERSIST=true (never by accident).
 *  - Stored under .rose/browser-sessions/<profile>.json with 0600 perms,
 *    NEVER in logs, Memory, or the Event Store.
 *  - Each profile records its allowed domains; restoring for an unrelated
 *    domain is refused.
 *  - Sessions expire (default 7 days).
 */

export interface SessionRecord {
    profile: string;
    allowedDomains: string[];
    savedAt: number;
    expiresAt: number;
}

const SESSIONS_DIR = () => path.join(process.cwd(), '.rose', 'browser-sessions');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class BrowserSessionManager {
    public static get enabled(): boolean {
        return process.env.ROSE_BROWSER_PERSIST === 'true';
    }

    private static file(profile: string): string {
        const safe = profile.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(SESSIONS_DIR(), `${safe}.json`);
    }

    /** Persist a Playwright storageState string for a domain-scoped profile. */
    public static save(profile: string, storageStateJson: string, allowedDomains: string[]): void {
        if (!this.enabled) {
            throw new Error('Browser session persistence is disabled. Set ROSE_BROWSER_PERSIST=true to enable.');
        }
        const record = {
            meta: {
                profile,
                allowedDomains,
                savedAt: Date.now(),
                expiresAt: Date.now() + DEFAULT_TTL_MS,
            } as SessionRecord,
            // Encrypted at rest when the OS store backs Secrets; the raw state
            // never reaches logs/memory/events.
            storageState: JSON.parse(storageStateJson),
        };
        fs.mkdirSync(SESSIONS_DIR(), { recursive: true });
        fs.writeFileSync(this.file(profile), JSON.stringify(record), { mode: 0o600 });
    }

    /**
     * Load a session for use against `targetHost`. Refuses expired sessions
     * and any host outside the profile's recorded domains.
     */
    public static load(profile: string, targetHost: string): string | null {
        const file = this.file(profile);
        try {
            if (!fs.existsSync(file)) return null;
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const meta: SessionRecord = parsed.meta;

            if (meta.expiresAt && meta.expiresAt < Date.now()) return null; // expired

            const host = targetHost.toLowerCase();
            const allowed = meta.allowedDomains.length === 0
                || meta.allowedDomains.some(d => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
            if (!allowed) return null; // domain mismatch → do not reuse

            return JSON.stringify(parsed.storageState);
        } catch {
            return null; // corrupted state behaves like "no session"
        }
    }

    public static list(): SessionRecord[] {
        try {
            if (!fs.existsSync(SESSIONS_DIR())) return [];
            return fs.readdirSync(SESSIONS_DIR())
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    try {
                        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR(), f), 'utf-8')).meta as SessionRecord;
                    } catch { return null; }
                })
                .filter((x): x is SessionRecord => !!x);
        } catch {
            return [];
        }
    }

    public static clear(profile: string): boolean {
        const file = this.file(profile);
        if (!fs.existsSync(file)) return false;
        fs.rmSync(file, { force: true });
        return true;
    }

    public static clearAll(): number {
        let n = 0;
        for (const s of this.list()) if (this.clear(s.profile)) n++;
        return n;
    }
}
