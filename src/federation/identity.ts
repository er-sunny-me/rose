import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface AgentCapability {
    id: string;
    version: string;
    mode: 'read' | 'write' | 'execute' | 'external';
    limits?: Record<string, unknown>;
    supportedFormats?: string[];
}

export interface AgentIdentity {
    agentId: string;
    name?: string;
    publicIdentity?: string; // Public key PEM
    protocolVersion: string;
    runtimeVersion: string;
    capabilities: string[];
    trustDomain: string;
}

export interface FederatedAgent {
    id: string;
    identity: AgentIdentity;
    endpoint: string;
    status: 'offline' | 'online' | 'degraded' | 'revoked';
    trust: 'unknown' | 'pending' | 'trusted' | 'restricted' | 'blocked' | 'revoked';
    capabilities: AgentCapability[];
    lastSeen?: number;
}

export class IdentityManager {
    private static keyPair: crypto.KeyPairSyncResult<string, string>;
    private static agentId: string;

    public static initialize() {
        const keyPath = path.join(process.cwd(), '.gemini', 'federation.key');
        const pubPath = path.join(process.cwd(), '.gemini', 'federation.pub');

        if (fs.existsSync(keyPath) && fs.existsSync(pubPath)) {
            const privateKey = fs.readFileSync(keyPath, 'utf8');
            const publicKey = fs.readFileSync(pubPath, 'utf8');
            this.keyPair = { privateKey, publicKey };
            
            // Hash public key to get AgentID
            const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
            this.agentId = `agent-${hash.substring(0, 12)}`;
        } else {
            console.log('Generating new cryptographic identity for federation...');
            this.keyPair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
            });
            fs.mkdirSync(path.join(process.cwd(), '.gemini'), { recursive: true });
            fs.writeFileSync(keyPath, this.keyPair.privateKey, { mode: 0o600 });
            fs.writeFileSync(pubPath, this.keyPair.publicKey);
            
            const hash = crypto.createHash('sha256').update(this.keyPair.publicKey).digest('hex');
            this.agentId = `agent-${hash.substring(0, 12)}`;
        }
    }

    public static getIdentity(): AgentIdentity {
        if (!this.keyPair) this.initialize();
        return {
            agentId: this.agentId,
            name: 'Rose-Local',
            publicIdentity: this.keyPair.publicKey,
            protocolVersion: 'v1',
            runtimeVersion: '1.0.0',
            capabilities: ['terminal', 'filesystem.read', 'filesystem.write', 'coding'],
            trustDomain: 'TRUSTED_CORE'
        };
    }

    public static getAgentId(): string {
        if (!this.keyPair) this.initialize();
        return this.agentId;
    }

    public static sign(payload: string): string {
        if (!this.keyPair) this.initialize();
        const sign = crypto.createSign('SHA256');
        sign.update(payload);
        sign.end();
        return sign.sign(this.keyPair.privateKey, 'base64');
    }

    public static verify(payload: string, signature: string, publicKeyPem: string): boolean {
        const verify = crypto.createVerify('SHA256');
        verify.update(payload);
        verify.end();
        return verify.verify(publicKeyPem, signature, 'base64');
    }
}
