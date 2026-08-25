import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Phase 36 Part A: extension provenance via Ed25519 signatures.
 *
 * Node's built-in crypto module (OpenSSL-backed) provides Ed25519 key
 * generation, signing and verification — no hand-rolled cryptography.
 *
 * Trust model:
 *   extension files → canonical digest → Ed25519 signature over the digest
 *   publisher keyId → TrustedPublisherRegistry lookup (revocation honored)
 *   ANY failure ⇒ the extension must not execute.
 */

export const SIGNATURE_ALGORITHM = 'Ed25519';

export interface ExtensionSignature {
    algorithm: 'Ed25519';
    keyId: string;
    signature: string; // base64
}

export interface SignedManifest {
    id: string;
    name: string;
    version: string;
    publisher: string;
    entry?: string;
    capabilities?: string[];
    signature?: ExtensionSignature;
    [k: string]: any;
}

export interface PublisherKeyPair {
    keyId: string;
    publicKeyPem: string;
    privateKeyPem: string;
}

// ─── Canonical digest ────────────────────────────────────────────────────

/**
 * Deterministic package digest:
 *  - files sorted by posix-style relative path
 *  - path + NUL + 8-byte big-endian size + content, concatenated
 *  - SHA-256 over the whole stream
 * No timestamps, no OS path separators, no ordering ambiguity.
 */
export function canonicalDigest(extensionDir: string): { digest: string; files: string[] } {
    const entries: Array<{ rel: string; abs: string }> = [];

    const walk = (dir: string): void => {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, dirent.name);
            if (dirent.isDirectory()) walk(abs);
            else {
                const rel = path.relative(dir, abs).split(path.sep).join('/');
                // The manifest is NOT part of the payload digest — it carries
                // the signature itself and is covered via its canonical
                // fields inside manifestBindingDigest().
                if (rel === 'extension.json') continue;
                entries.push({ rel, abs });
            }
        }
    };
    walk(extensionDir);
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

    const hash = crypto.createHash('sha256');
    for (const e of entries) {
        hash.update(e.rel);
        hash.update(Buffer.from([0]));
        const content = fs.readFileSync(e.abs);
        hash.update(content.length.toString(16));
        hash.update(Buffer.from([0]));
        hash.update(content);
    }
    return { digest: hash.digest('hex'), files: entries.map(e => e.rel) };
}

/** Digest covering both payload and the unsigned manifest fields. */
export function manifestBindingDigest(manifest: SignedManifest, packageDigest: string): string {
    const canonical = JSON.stringify({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.publisher,
        entry: manifest.entry ?? null,
        capabilities: [...(manifest.capabilities || [])].sort(),
        packageDigest,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ─── Keys & signing ──────────────────────────────────────────────────────

export function generatePublisherKeyPair(keyId = 'publisher-key-1'): PublisherKeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        keyId,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}

export interface SignResult {
    signature: ExtensionSignature;
    packageDigest: string;
}

export function signExtension(
    extensionDir: string,
    manifest: SignedManifest,
    privateKeyPem: string,
    keyId: string
): SignResult {
    const { digest } = canonicalDigest(extensionDir);
    const binding = manifestBindingDigest(manifest, digest);
    const sig = crypto.sign(null, Buffer.from(binding, 'hex'), privateKeyPem);
    return {
        signature: { algorithm: SIGNATURE_ALGORITHM, keyId, signature: sig.toString('base64') },
        packageDigest: digest,
    };
}

// ─── Verification ────────────────────────────────────────────────────────

export type VerificationFailure =
    | 'unsigned'
    | 'unknown-publisher'
    | 'revoked-publisher'
    | 'wrong-key'
    | 'modified-content'
    | 'bad-algorithm'
    | 'corrupt-manifest';

export interface VerificationOutcome {
    ok: boolean;
    failure?: VerificationFailure;
    detail?: string;
    packageDigest?: string;
    keyId?: string;
}

export class TrustedPublisherRegistry {
    private static file(): string {
        return path.join(process.cwd(), '.rose', 'trusted-publishers.json');
    }

    public static load(): Array<{ publisher: string; keyId: string; publicKeyPem: string; status: 'trusted' | 'revoked'; addedAt: number; revokedAt?: number }> {
        try {
            if (fs.existsSync(this.file())) {
                return JSON.parse(fs.readFileSync(this.file(), 'utf-8'));
            }
        } catch { /* corrupt registry behaves like empty */ }
        return [];
    }

    private static save(rows: ReturnType<typeof TrustedPublisherRegistry.load>): void {
        fs.mkdirSync(path.dirname(this.file()), { recursive: true });
        fs.writeFileSync(this.file(), JSON.stringify(rows, null, 2), 'utf-8');
    }

    public static trust(publisher: string, keyId: string, publicKeyPem: string): void {
        const rows = this.load().filter(r => !(r.publisher === publisher && r.keyId === keyId));
        rows.push({ publisher, keyId, publicKeyPem, status: 'trusted', addedAt: Date.now() });
        this.save(rows);
    }

    public static revoke(publisher: string, keyId?: string): void {
        const rows = this.load();
        for (const r of rows) {
            if (r.publisher === publisher && (!keyId || r.keyId === keyId)) {
                r.status = 'revoked';
                r.revokedAt = Date.now();
            }
        }
        this.save(rows);
    }

    public static get(publisher: string, keyId: string) {
        return this.load().find(r => r.publisher === publisher && r.keyId === keyId) || null;
    }
}

/**
 * Full verification pipeline for one installed extension directory whose
 * manifest lives at <dir>/extension.json.
 */
export function verifyInstalledExtension(extensionDir: string): VerificationOutcome & { manifest?: SignedManifest } {
    let manifest: SignedManifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'extension.json'), 'utf-8'));
    } catch {
        return { ok: false, failure: 'corrupt-manifest', detail: 'extension.json missing or unparseable' };
    }

    if (!manifest.publisher || !manifest.signature) {
        return { ok: false, failure: 'unsigned', detail: 'manifest lacks publisher/signature' };
    }

    const sig = manifest.signature;
    if (sig.algorithm !== SIGNATURE_ALGORITHM) {
        return { ok: false, failure: 'bad-algorithm', detail: `expected ${SIGNATURE_ALGORITHM}` };
    }

    const record = TrustedPublisherRegistry.get(manifest.publisher, sig.keyId);
    if (!record) {
        return { ok: false, failure: 'unknown-publisher', detail: `${manifest.publisher}/${sig.keyId} not trusted`, keyId: sig.keyId };
    }
    if (record.status !== 'trusted') {
        return { ok: false, failure: 'revoked-publisher', detail: `key ${sig.keyId} is revoked`, keyId: sig.keyId };
    }

    // Digest current content and rebuild the binding exactly as at sign time.
    let digest: string;
    try {
        digest = canonicalDigest(extensionDir).digest;
    } catch (e: any) {
        return { ok: false, failure: 'modified-content', detail: `unreadable payload: ${e.message}` };
    }
    const binding = manifestBindingDigest(manifest, digest);

    let valid = false;
    try {
        valid = crypto.verify(
            null,
            Buffer.from(binding, 'hex'),
            record.publicKeyPem,
            Buffer.from(sig.signature, 'base64')
        );
    } catch {
        valid = false;
    }

    if (!valid) {
        // Distinguish tampered payload vs wrong key for clearer audits.
        return {
            ok: false,
            failure: 'modified-content',
            detail: 'signature does not match current content/manifest',
            packageDigest: digest,
            keyId: sig.keyId,
        };
    }

    return { ok: true, packageDigest: digest, keyId: sig.keyId, manifest };
}
