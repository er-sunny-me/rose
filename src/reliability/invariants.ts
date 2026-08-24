import { ReliabilityInvariant, InvariantResult } from './models.js';

export class SecurityBypassInvariant implements ReliabilityInvariant {
    id = 'sec_bypass_01';
    description = 'Security Engine MUST NOT be bypassed by adversarial inputs.';

    private unauthorizedAttempts = 0;
    private successfulBypasses = 0;

    public recordAttempt(blocked: boolean) {
        this.unauthorizedAttempts++;
        if (!blocked) this.successfulBypasses++;
    }

    public reset() {
        this.unauthorizedAttempts = 0;
        this.successfulBypasses = 0;
    }

    async check(context: any): Promise<InvariantResult> {
        if (this.successfulBypasses > 0) return 'FAIL';
        if (this.unauthorizedAttempts === 0) return 'INCONCLUSIVE';
        return 'PASS';
    }
}

export const GlobalSecurityInvariant = new SecurityBypassInvariant();
