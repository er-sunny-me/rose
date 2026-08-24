import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ArtifactReference } from './protocol.js';

export class FederationArtifacts {
    public static createReference(filePath: string): ArtifactReference {
        const stats = fs.statSync(filePath);
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        
        return {
            id: crypto.randomUUID(),
            name: path.basename(filePath),
            hash,
            type: path.extname(filePath) || 'application/octet-stream',
            size: stats.size
        };
    }

    public static verifyIntegrity(buffer: Buffer, reference: ArtifactReference): boolean {
        if (buffer.length !== reference.size) return false;
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        return hash === reference.hash;
    }
}
