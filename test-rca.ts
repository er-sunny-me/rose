import { WorldModel } from './src/world/model.js';
import { IncidentManager } from './src/rca/manager.js';
import { RCAEngine } from './src/rca/engine.js';
import { ModelRouter } from './src/router.js';

async function test() {
    console.log("--- Initializing ---");
    WorldModel.init();
    IncidentManager.init();
    ModelRouter.initialize();

    // Mock router for test
    ModelRouter.route = async (requirements: any, messages: any[]) => {
        return JSON.stringify([
            { cause: "MCP timeout on Auth Server", confidence: 0.9, supportingEdges: ["AuthService"] },
            { cause: "High load on DB", confidence: 0.3 }
        ]);
    };

    console.log("--- Populating Dependency Graph ---");
    // Add mock edges
    WorldModel.addEdge({ from: "AgentCore", to: "ToolCall", type: "depends_on", confidence: 1.0, source: "static" });
    WorldModel.addEdge({ from: "ToolCall", to: "MCPClient", type: "depends_on", confidence: 0.9, source: "runtime" });
    WorldModel.addEdge({ from: "MCPClient", to: "AuthService", type: "depends_on", confidence: 1.0, source: "static" });
    WorldModel.addEdge({ from: "AuthService", to: "PostgresDB", type: "depends_on", confidence: 0.8, source: "inferred" });

    console.log("Dependencies added.");
    
    // Test forward dependencies
    const fwd = WorldModel.getForwardDependencies("ToolCall");
    console.log(`Forward from ToolCall:`, fwd);

    // Test reverse dependencies
    const rev = WorldModel.getReverseDependencies("AuthService");
    console.log(`Reverse from AuthService:`, rev);

    console.log("--- Testing Blast Radius ---");
    const blast = RCAEngine.analyzeImpact("AgentCore");
    console.log(`Blast radius of AgentCore:`, blast);
    
    console.log("--- Triggering Symptom ---");
    const incident = await IncidentManager.reportSymptom("Auth server latency increased by 500%");
    console.log(`Created Incident: ${incident.id}`);
    
    console.log("--- Running RCA Engine ---");
    const hypotheses = await RCAEngine.generateHypotheses(incident.id);
    console.log(`Generated Hypotheses:`);
    for (const h of hypotheses) {
        console.log(`  - ${h.cause} (Conf: ${h.confidence})`);
    }

    const updatedInc = IncidentManager.getIncident(incident.id);
    console.log(`Incident status after RCA: ${updatedInc?.status}`);
    console.log(`Incident timeline:`, updatedInc?.timeline);
}

test().catch(console.error);
