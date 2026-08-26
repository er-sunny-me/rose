import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Pairing + device registry for the standalone mesh server.
 *
 * - pairing codes: XXX-XXX, 5-minute TTL, single-use, human-approved on a
 *   trusted console (rose agents approve <code> / Web panel button)
 * - QR payload contains ONLY host + short-lived token — never secrets
 * - deviceSecret delivered exactly once over the encrypted connection;
 *   stored here as SHA-256 hash only
 */
export const PROTOCOL_VERSION = 1;
export const CLOCK_SKEW_MS = 30_000;
export const PAIRING_TTL_MS = 5 * 60_000;

export interface PairingRequest {
    code: string;
    pairToken: string;
    createdAt: number;
    expiresAt: number;
    approved: boolean;
    usedBy?: string;
    displayName?: string;
}

export interface MeshDevice {
    agentId: string;
    deviceId: string;
    displayName: string;
    platform: string;
    runtimeVersion: string;
    protocolVersion: number;
    trust: 'trusted' | 'restricted' | 'revoked' | 'blocked';
    capabilities: string[];
    resourceState?: Record<string, unknown>;
    deviceSecretHash: string;
    pairedAt: number;
    lastSeen: number;
}

export function dataDir(): string {
    const envHome = process.env.ROSE_HOME?.trim();
    const dir = envHome && envHome !== 'undefined' && envHome !== 'null'
        ? envHome
        : path.join(os.homedir(), '.rose-mesh');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function devicesFile(): string {
    return path.join(dataDir(), 'devices.json');
}

export class PairingManager {
    private static pending = new Map<string, PairingRequest>();

    static newCode(): string {
        const s = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        return `${s.slice(0, 3)}-${s.slice(3)}`;
    }

    static begin(): PairingRequest {
        const now = Date.now();
        for (const [code, p] of this.pending) if (p.expiresAt < now) this.pending.delete(code);
        let req: PairingRequest;
        do {
            req = {
                code: this.newCode(),
                pairToken: crypto.randomBytes(24).toString('base64url'),
                createdAt: now,
                expiresAt: now + PAIRING_TTL_MS,
                approved: false,
            };
        } while ([...this.pending.values()].some(p => p.pairToken === req!.pairToken));
        this.pending.set(req.code, req);
        return req;
    }

    static find(tokenOrCode: string): PairingRequest | undefined {
        for (const p of this.pending.values()) {
            if ((p.pairToken === tokenOrCode || p.code === tokenOrCode) && p.expiresAt > Date.now()) return p;
        }
        return undefined;
    }

    static approve(code: string, displayName?: string): PairingRequest | undefined {
        const p = this.pending.get(code);
        if (!p || p.expiresAt < Date.now()) return undefined;
        p.approved = true;
        if (displayName) p.displayName = displayName;
        return p;
    }

    static consume(pairToken: string): PairingRequest | undefined {
        const p = this.find(pairToken);
        if (!p || !p.approved || p.usedBy) return undefined;
        this.pending.delete(p.code);
        return p;
    }

    private usedBy?: string;
}

export class DeviceRegistry {
    private static devices: Map<string, MeshDevice> | null = null;

    private static load(): Map<string, MeshDevice> {
        if (this.devices) return this.devices;
        try {
            const f = devicesFile();
            if (fs.existsSync(f)) {
                this.devices = new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))));
                return this.devices;
            }
        } catch { /* corrupt → fresh */ }
        this.devices = new Map();
        return this.devices;
    }

    private static save(): void {
        try { fs.writeFileSync(devicesFile(), JSON.stringify(Object.fromEntries(this.load()), null, 2), { mode: 0o600 }); } catch { /* ignore */ }
    }

    static register(opts: {
        deviceId: string; displayName: string; platform: string;
        runtimeVersion: string; deviceSecret: string;
        protocolVersion?: number; capabilities?: string[];
    }): MeshDevice {
        const secretHash = crypto.createHash('sha256').update(opts.deviceSecret).digest('hex');
        const agentId = `agent-${crypto.createHash('sha256').update(opts.deviceId).digest('hex').slice(0, 12)}`;
        const cur = this.load().get(agentId);
        const dev: MeshDevice = {
            agentId,
            deviceId: opts.deviceId,
            displayName: opts.displayName,
            platform: opts.platform,
            runtimeVersion: opts.runtimeVersion,
            protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
            trust: 'trusted',
            capabilities: opts.capabilities ?? [],
            deviceSecretHash: secretHash,
            pairedAt: cur?.pairedAt ?? Date.now(),
            lastSeen: Date.now(),
        };
        this.load().set(agentId, dev);
        this.save();
        return dev;
    }

    static get(agentId: string): MeshDevice | undefined { return this.load().get(agentId); }

    static getByDeviceId(deviceId: string): MeshDevice | undefined {
        for (const d of this.load().values()) if (d.deviceId === deviceId) return d;
        return undefined;
    }

    /** sha256(challenge : sha256(secret)) — mirrored by clients (Kotlin included). */
    static verifyChallenge(agentId: string, presented: string, challenge: string): boolean {
        const dev = this.get(agentId);
        if (!dev || !(dev.trust === 'trusted' || dev.trust === 'restricted')) return false;
        const expected = crypto.createHash('sha256').update(`${challenge}:${dev.deviceSecretHash}`).digest('hex');
        const a = Buffer.from(expected), b = Buffer.from(presented ?? '');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    static setTrust(agentId: string, trust: MeshDevice['trust']): boolean {
        const d = this.get(agentId);
        if (!d) return false;
        d.trust = trust;
        this.save();
        return true;
    }

    static revoke(agentId: string): boolean { return this.setTrust(agentId, 'revoked'); }

    /** Permanently delete a device entry from the on-disk registry. */
    static remove(agentId: string): boolean {
        const ok = this.load().delete(agentId);
        if (ok) this.save();
        return ok;
    }

    /** Registry hygiene — drop devices unseen for longer than maxAgeMs. */
    static prune(maxAgeMs: number, keep: Set<string> = new Set()): number {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;
        for (const [id, d] of this.load()) {
            if (d.lastSeen < cutoff && !keep.has(id)) { this.load().delete(id); removed++; }
        }
        if (removed) this.save();
        return removed;
    }

    static touchPresence(agentId: string, patch?: Partial<MeshDevice>): void {
        const d = this.get(agentId);
        if (!d) return;
        Object.assign(d, patch ?? {}, { lastSeen: Date.now() });
        this.save();
    }

    static list(): MeshDevice[] { return [...this.load().values()]; }
}
