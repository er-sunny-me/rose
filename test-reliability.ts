import { ReliabilityLab } from './src/reliability/lab.js';
import { ModelRouter } from './src/router.js';

async function test() {
    console.log("--- Initializing Reliability Lab Tests ---");
    ModelRouter.initialize();

    const results = await ReliabilityLab.runProfile('quick');

    console.log("\n--- Final Results ---");
    for (const r of results) {
        console.log(`[${r.id}] ${r.status} (Detect: ${r.detection}, Recover: ${r.recovery}, Verify: ${r.verification})`);
    }
}

test().catch(console.error);
