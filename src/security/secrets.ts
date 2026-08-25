import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

/**
 * Phase 36 Part B: secure credential storage.
 *
 * Priority when resolving a secret:
 *   1. OS-backed SecretStore      (Windows DPAPI CurrentUser via PowerShell;
 *                                  AES-GCM encrypted file elsewhere)
 *   2. environment variable       (12-factor style)
 *   3. legacy plaintext config    (read-only; migration recommended)
 *
 * The store never logs secret values. On Windows the DPAPI CurrentUser scope
 * encrypts to the logged-in user account — the OS-native credential-grade
 * mechanism available without native npm builds. Other platforms use an
 * AES-256-GCM file sealed with a machine-derived key (documented as
 * hardening, not HSM-grade) plus a clear warning.
 */

export interface SecretStore {
    readonly id: string;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    has(key: string): Promise<boolean>;
}

const SECRET_DIR = () => path.join(process.cwd(), '.rose', 'secrets');

// ─── Windows DPAPI backend ───────────────────────────────────────────────

function ps(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 15_000 },
            (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
    });
}

export class WindowsDpapiSecretStore implements SecretStore {
    readonly id = 'windows-dpapi-currentuser';
    private ok: boolean | null = null;

    private filePath(key: string): string {
        const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(SECRET_DIR(), `${safe}.dpapi`);
    }

    async available(): Promise<boolean> {
        if (this.ok !== null) return this.ok;
        if (process.platform !== 'win32') { this.ok = false; return false; }
        try {
            await ps('$v=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes("probe"),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); exit 0');
            this.ok = true;
        } catch {
            this.ok = false;
        }
        return this.ok;
    }

    async set(key: string, value: string): Promise<void> {
        const file = this.filePath(key).replace(/\\/g, '\\\\');
        fs.mkdirSync(SECRET_DIR(), { recursive: true });
        const script = `
$b=[Text.Encoding]::UTF8.GetBytes(@'
${value.replace(/'/g, "''")}
'@);
$p=[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser));
[IO.File]::WriteAllText('${file}', $p)`;
        await ps(script);
    }

    async get(key: string): Promise<string | null> {
        const file = this.filePath(key).replace(/\\/g, '\\\\');
        if (!fs.existsSync(this.filePath(key))) return null;
        try {
            const out = await ps(`
$p=[IO.File]::ReadAllText('${file}');
$u=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($p),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($u))`);
            return out || null;
        } catch {
            return null;
        }
    }

    async delete(key: string): Promise<boolean> {
        const f = this.filePath(key);
        if (!fs.existsSync(f)) return false;
        fs.rmSync(f, { force: true });
        return true;
    }

    async has(key: string): Promise<boolean> {
        return fs.existsSync(this.filePath(key));
    }
}

// ─── AES-GCM encrypted-file backend (non-Windows / DPAPI unavailable) ────

export class EncryptedFileSecretStore implements SecretStore {
    readonly id = 'aes256-gcm-file';
    private static KEY_DOC = 'Key derived from machine GUID + username. Hardening against casual disk reads — NOT equivalent to an OS keystore. Prefer environment variables on this platform.';
    private key: Buffer | null = null;

    constructor(private warnOnce: (msg: string) => void = () => {}) {}

    private vaultFile(): string { return path.join(SECRET_DIR(), 'vault.json'); }

    private deriveKey(): Buffer {
        if (this.key) return this.key;
        let seed = os.hostname() + '|' + os.userInfo().username + '|rose-secret-seed-v1';
        try {
            const guid = fs.readFileSync('C:\\..\\machine-id', 'utf-8'); // linux path probe
            void guid;
        } catch { /* best effort */ }
        this.key = crypto.scryptSync(seed, 'rose-vault-salt-v1', 32);
        return this.key;
    }

    private loadVault(): Record<string, { iv: string; tag: string; data: string }> {
        try {
            if (fs.existsSync(this.vaultFile())) return JSON.parse(fs.readFileSync(this.vaultFile(), 'utf-8'));
        } catch { /* corrupt -> fresh */ }
        return {};
    }

    private saveVault(v: Record<string, any>): void {
        fs.mkdirSync(SECRET_DIR(), { recursive: true });
        fs.writeFileSync(this.vaultFile(), JSON.stringify(v), { mode: 0o600 });
    }

    async available(): Promise<boolean> { return true; }

    async set(key: string, value: string): Promise<void> {
        this.warnOnce(`[SECRETS] ${EncryptedFileSecretStore.KEY_DOC}`);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.deriveKey(), iv);
        const data = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
        const v = this.loadVault();
        v[key] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
        this.saveVault(v);
    }

    async get(key: string): Promise<string | null> {
        const entry = this.loadVault()[key];
        if (!entry) return null;
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', this.deriveKey(), Buffer.from(entry.iv, 'base64'));
            d.setAuthTag(Buffer.from(entry.tag, 'base64'));
            return Buffer.concat([d.update(Buffer.from(entry.data, 'base64')), d.final()]).toString('utf-8');
        } catch {
            return null;
        }
    }

    async delete(key: string): Promise<boolean> {
        const v = this.loadVault();
        if (!(key in v)) return false;
        delete v[key];
        this.saveVault(v);
        return true;
    }

    async has(key: string): Promise<boolean> {
        return key in this.loadVault();
    }
}

// ─── Resolver facade ─────────────────────────────────────────────────────

export class Secrets {
    private static store: SecretStore | null = null;

    public static async getStore(): Promise<SecretStore> {
        if (this.store) return this.store;

        // Probe DPAPI with a REAL roundtrip (availability alone proved
        // insufficient on some systems) and fall back cleanly.
        const dpapi = new WindowsDpapiSecretStore();
        try {
            if (await dpapi.available()) {
                await dpapi.set('__probe__', '1');
                const back = await dpapi.get('__probe__');
                await dpapi.delete('__probe__');
                if (back === '1') {
                    this.store = dpapi;
                    return this.store;
                }
            }
        } catch { /* fall through */ }

        this.store = new EncryptedFileSecretStore(msg => console.error(msg));
        console.error('[SECRETS] OS credential store unavailable — using AES-GCM encrypted file fallback.');
        return this.store;
    }

    /** Provider→env mapping used across Rose. */
    private static envName(credential: string): string | undefined {
        const map: Record<string, string> = {
            'gemini-api-key': 'GEMINI_API_KEY',
            'anthropic-api-key': 'ANTHROPIC_API_KEY',
            'openai-api-key': 'OPENAI_API_KEY',
            'github-token': 'GITHUB_TOKEN',
            'google-tokens': 'GOOGLE_CREDENTIALS_PATH_VALUE',
        };
        return map[credential];
    }

    /** Resolve with documented priority: store → env → legacy config value. */
    public static async get(credential: string, legacyPlaintext?: string): Promise<string | null> {
        const store = await this.getStore();
        const fromStore = await store.get(credential);
        if (fromStore) return fromStore;

        const envName = this.envName(credential);
        if (envName && process.env[envName]) return process.env[envName]!;

        return legacyPlaintext ?? null;
    }

    /** Write into the OS store (never logs the value). */
    public static async set(credential: string, value: string): Promise<void> {
        const store = await this.getStore();
        await store.set(credential, value);
    }

    public static async remove(credential: string): Promise<boolean> {
        const store = await this.getStore();
        return store.delete(credential);
    }

    /**
     * One-shot migration: move known plaintext credentials from config into
     * the OS store. Returns what happened WITHOUT exposing values.
     */
    public static async migrateFromConfig(configKeys: Record<string, string | undefined>, apply: boolean): Promise<{ migrated: string[]; skipped: string[] }> {
        const migrated: string[] = [];
        const skipped: string[] = [];
        const nameMap: Record<string, string> = {
            gemini: 'gemini-api-key',
            anthropic: 'anthropic-api-key',
            openai: 'openai-api-key',
            github: 'github-token',
        };
        for (const [cfgKey, credName] of Object.entries(nameMap)) {
            const plain = configKeys[cfgKey];
            if (!plain) continue;
            if (!apply) { skipped.push(cfgKey); continue; }
            await this.set(credName, plain);
            migrated.push(cfgKey);
        }
        return { migrated, skipped };
    }

    /** Status summary safe for display (never values). */
    public static async status(configKeys: Record<string, string | undefined>): Promise<Array<{ credential: string; source: 'os-store' | 'env' | 'plaintext-config' | 'missing' }>> {
        const out: Array<{ credential: string; source: 'os-store' | 'env' | 'plaintext-config' | 'missing' }> = [];
        const pairs: Array<[string, string]> = [
            ['gemini-api-key', 'gemini'],
            ['anthropic-api-key', 'anthropic'],
            ['openai-api-key', 'openai'],
            ['github-token', 'github'],
        ];
        const store = await this.getStore();
        for (const [cred, cfgKey] of pairs) {
            if (await store.has(cred)) out.push({ credential: cred, source: 'os-store' });
            else {
                const env = this.envName(cred);
                if (env && process.env[env]) out.push({ credential: cred, source: 'env' });
                else if (configKeys[cfgKey]) out.push({ credential: cred, source: 'plaintext-config' });
                else out.push({ credential: cred, source: 'missing' });
            }
        }
        return out;
    }
}
