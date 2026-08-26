import crypto from 'crypto';
import { Config } from '../config.js';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import type { IdentityContext } from '../policy/models.js';

/** Endpoints that never require authentication (liveness probes only). */
export const PUBLIC_PATHS = new Set<string>(['/health', '/ready']);

export interface AuthenticatedRequest extends Request {
    identity?: IdentityContext;
}

/**
 * Token-based authentication for the Agent Server.
 *
 * - Token source precedence: ROSE_API_TOKEN env > persisted token file.
 * - A cryptographically random token is generated on first start and stored
 *   under <cwd>/.rose/auth-token (never committed; never logged).
 * - Comparison is timing-safe. No custom cryptography is used.
 */
export class AuthService {
    private static token: string | null = null;

    /** Generate a secure random URL-safe token (256 bits of entropy). */
    public static generateToken(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private static tokenFile(): string {
        // Prefer the global Rose home so containers/volumes keep the token
        // persistent (ROSE_HOME=/data/.rose in cloud images).
        try {
            return path.join(Config.getGlobalDir(), '.rose', 'auth-token');
        } catch {
            return path.join(process.cwd(), '.rose', 'auth-token');
        }
    }

    /** Resolve (or create) the API token. */
    public static getToken(): string {
        if (this.token) return this.token;

        const envToken = process.env.ROSE_API_TOKEN;
        if (envToken && envToken.length >= 32) {
            this.token = envToken;
            return this.token;
        }

        const file = this.tokenFile();
        try {
            if (fs.existsSync(file)) {
                const stored = fs.readFileSync(file, 'utf-8').trim();
                if (stored.length >= 32) {
                    this.token = stored;
                    return this.token;
                }
            }
        } catch {
            /* fall through to generation */
        }

        this.token = this.generateToken();
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, this.token, { encoding: 'utf-8', mode: 0o600 });
        } catch {
            /* read-only FS: token stays in memory for this run */
        }
        return this.token;
    }

    /** Timing-safe equality check for presented vs expected token. */
    public static verifyToken(presented: string | undefined | null): boolean {
        if (!presented) return false;
        const expected = this.getToken();
        const a = Buffer.from(presented);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }

    /** Extract bearer token from an Authorization header. */
    public static extractBearer(header: string | undefined): string | null {
        if (!header) return null;
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        return match ? match[1].trim() : null;
    }

    /**
     * Resolve the identity + scope attached to a request after successful
     * authentication. Authenticated local/API clients act as TRUSTED_CORE;
     * every tool they trigger still passes through Security/Policy engines.
     */
    public static resolveIdentity(req: AuthenticatedRequest): IdentityContext {
        return {
            actor: 'api-client',
            executor: 'api-client',
            trustDomain: 'TRUSTED_CORE',
            environment: req.ip,
        };
    }
}

/** True when the request targets a public (unauthenticated) endpoint. */
export function isPublicPath(reqPath: string): boolean {
    const clean = reqPath.split('?')[0];
    return PUBLIC_PATHS.has(clean);
}

/** Express middleware: 401 unless a valid bearer token accompanies the request. */
export function authenticateRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (isPublicPath(req.path)) {
        next();
        return;
    }

    const token = AuthService.extractBearer(req.headers.authorization);
    if (!token || !AuthService.verifyToken(token)) {
        // Feed the Phase 36 lockout tracker, then answer vaguely — do not
        // leak whether the token was malformed or unknown.
        import('./ratelimit.js').then(({ noteAuthFailure }) => noteAuthFailure(req as any));
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    req.identity = AuthService.resolveIdentity(req);
    next();
}

/**
 * Authorization gate: runs AFTER authentication. Every protected request
 * carries a resolved identity which downstream tools re-check against the
 * Policy Engine. Route-level scopes may be enforced here as the platform
 * grows (e.g. role: readonly vs admin).
 */
const ALLOWED_EXECUTORS = new Set(['api-client']);

export function authorizeRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (isPublicPath(req.path)) {
        next();
        return;
    }
    if (!req.identity || !ALLOWED_EXECUTORS.has(req.identity.executor)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    next();
}
