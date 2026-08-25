import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Phase 36 Part C: layered rate limiting + authentication lockout.
 *
 * Endpoint classes get distinct budgets (spec §28). Failed authentications
 * feed a lockout tracker with progressive backoff keyed by a robust
 * identity (IP + presented-token hash) so attackers cannot trivially lock
 * out legitimate users (§32). No user-enumeration signals are returned (§33).
 */

export interface LockoutEntry {
    failures: number;
    firstFailure: number;
    lastFailure: number;
    lockoutUntil: number;
}

export class AuthLockout {
    private entries = new Map<string, LockoutEntry>();
    private maxFailures: number;
    private baseLockoutMs: number;

    constructor(maxFailures = 5, baseLockoutMs = 60_000) {
        this.maxFailures = maxFailures;
        this.baseLockoutMs = baseLockoutMs;
    }

    /** Robust key: client IP + SHA-256 of the presented credential. */
    static keyFor(ip: string, presented?: string | null): string {
        const tokenHash = presented
            ? crypto.createHash('sha256').update(presented).digest('hex').slice(0, 16)
            : 'anon';
        return `${ip}|${tokenHash}`;
    }

    isLocked(key: string): { locked: boolean; retryAfterSec: number } {
        const e = this.entries.get(key);
        if (!e) return { locked: false, retryAfterSec: 0 };
        const now = Date.now();
        if (e.lockoutUntil > now) {
            return { locked: true, retryAfterSec: Math.ceil((e.lockoutUntil - now) / 1000) };
        }
        // Window reset after quiet period of 2x base lockout since last failure
        if (now - e.lastFailure > this.baseLockoutMs * 2) {
            this.entries.delete(key);
        }
        return { locked: false, retryAfterSec: 0 };
    }

    /** Record a failed attempt; applies progressive backoff (§31). */
    recordFailure(key: string): void {
        const now = Date.now();
        const e = this.entries.get(key) || { failures: 0, firstFailure: now, lastFailure: now, lockoutUntil: 0 };

        e.failures += 1;
        e.lastFailure = now;

        if (e.failures >= this.maxFailures) {
            // Progressive: base * 2^(excess failures), capped at 30 minutes.
            const excess = Math.min(e.failures - this.maxFailures, 4);
            const duration = this.baseLockoutMs * Math.pow(2, excess);
            e.lockoutUntil = now + duration;
        }
        this.entries.set(key, e);
    }

    recordSuccess(key: string): void {
        this.entries.delete(key);
    }

    reset(): void {
        this.entries.clear();
    }

    stats(): { trackedIdentities: number } {
        return { trackedIdentities: this.entries.size };
    }
}

export const globalLockout = new AuthLockout(
    parseInt(process.env.ROSE_AUTH_MAX_FAILURES || '5', 10),
    parseInt(process.env.ROSE_AUTH_LOCKOUT_MS || '60000', 10)
);

function clientIp(req: Request): string {
    // Only trust proxy headers when explicitly configured (§32).
    if (process.env.ROSE_TRUST_PROXY === 'true') {
        const fwd = req.headers['x-forwarded-for'];
        if (typeof fwd === 'string') return fwd.split(',')[0].trim();
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Lockout gate for authentication-bearing requests. Runs BEFORE auth so
 * locked identities are rejected without touching the token comparison.
 */
export function lockoutGuard(req: Request, res: Response, next: NextFunction): void {
    const presented = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] ?? null;
    const key = AuthLockout.keyFor(clientIp(req), presented);

    const status = globalLockout.isLocked(key);
    if (status.locked) {
        res.set('Retry-After', String(status.retryAfterSec));
        res.status(429).json({ error: 'Too many failed attempts', retryAfterSeconds: status.retryAfterSec });
        return;
    }

    (req as any).lockoutKey = key;
    next();
}

/** Call on successful authentication to clear the failure counter. */
export function clearLockout(req: Request): void {
    const key = (req as any).lockoutKey as string | undefined;
    if (key) globalLockout.recordSuccess(key);
}

/** Call on failed authentication. */
export function noteAuthFailure(req: Request): void {
    const key = (req as any).lockoutKey;
    if (key) globalLockout.recordFailure(key);
}

// ─── Per-class rate limits ───────────────────────────────────────────────

const mk = (windowMs: number, max: number) => rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${clientIp(req)}:${(req as any).identity?.executor || 'anon'}`,
    message: { error: 'Too many requests' },
});

/** Health/readiness probes — generous. */
export const healthLimiter = mk(60_000, 120);
/** Normal authenticated API traffic. */
export const apiLimiter = mk(60_000, 300);
/** Chat/generation endpoints are expensive. */
export const chatLimiter = mk(60_000, 60);
/** Admin/policy/maintenance mutations. */
export const adminLimiter = mk(60_000, 60);
/** WebSocket upgrade attempts. */
export const wsUpgradeLimiter = mk(60_000, 60);

/** Apply per-endpoint-class limiters; returns middleware list for routes. */
export function limiterFor(path: string): ReturnType<typeof mk> {
    if (path === '/health' || path === '/ready') return healthLimiter;
    if (path.includes('/messages') || path.includes('/chat')) return chatLimiter;
    if (path.includes('/policies') || path.includes('/maintenance') || path.includes('/reliability/runs')) return adminLimiter;
    return apiLimiter;
}
