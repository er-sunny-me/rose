import { AgentCapability } from './identity.js';

export class CapabilityNegotiator {
    public static isCompatible(required: string[], offered: string[]): boolean {
        // Simple subset check for now. In a real system, we'd check versions and limits.
        for (const req of required) {
            if (!offered.includes(req)) return false;
        }
        return true;
    }
}
