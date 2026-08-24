import crypto from 'crypto';
import chalk from 'chalk';
import { ModelRouter } from '../router.js';
import { WorldModel } from '../world/model.js';
import { IncidentManager } from './manager.js';
import { Incident, RootCauseHypothesis } from './models.js';

export class RCAEngine {
    public static async generateHypotheses(incidentId: string): Promise<RootCauseHypothesis[]> {
        const incident = IncidentManager.getIncident(incidentId);
        if (!incident) throw new Error("Incident not found");

        console.log(chalk.cyan(`[RCAEngine] Generating root cause hypotheses for incident ${incidentId}...`));
        IncidentManager.updateStatus(incidentId, 'investigating', 'Generating causal hypotheses');

        const dependencies = WorldModel.getEdges();
        const entities = WorldModel.getAll();

        const prompt = `You are the Root Cause Analysis Engine.
Symptom: ${incident.symptoms.join(', ')}
Dependency Graph Edges: ${JSON.stringify(dependencies)}
Recent World State: ${JSON.stringify(entities.slice(0, 5))} // Snippet

Based on the symptom and dependencies, generate 2-3 likely root-cause hypotheses.
Return a JSON array of objects matching this format:
[
  { "cause": "description of the root cause", "confidence": 0.5, "supportingEdges": ["edgeId_if_applicable"] }
]
Do not include markdown or extra text. Return only valid JSON.`;

        try {
            const result = await ModelRouter.route({ intent: 'planning', capabilities: ['reasoning'] }, [{ role: 'user', content: prompt }]);
            const hypothesesData = JSON.parse(result.trim());
            
            const hypotheses: RootCauseHypothesis[] = hypothesesData.map((h: any) => ({
                id: crypto.randomBytes(4).toString('hex'),
                symptom: incident.symptoms[0],
                cause: h.cause,
                evidenceIds: [],
                supportingEdges: h.supportingEdges || [],
                confidence: h.confidence || 0.5,
                status: 'candidate'
            }));

            incident.hypotheses = hypotheses;
            IncidentManager.addTimelineEvent(incidentId, `Generated ${hypotheses.length} hypotheses`);
            return hypotheses;
        } catch (e: any) {
            console.error(chalk.red(`[RCAEngine] Failed to generate hypotheses: ${e.message}`));
            return [];
        }
    }

    public static analyzeImpact(targetId: string): string[] {
        // Forward dependency traversal to find blast radius
        const visited = new Set<string>();
        const queue = [targetId];
        
        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            
            const edges = WorldModel.getForwardDependencies(current);
            for (const edge of edges) {
                if (!visited.has(edge.to)) {
                    queue.push(edge.to);
                }
            }
        }
        
        // Remove the target itself from blast radius
        visited.delete(targetId);
        return Array.from(visited);
    }
}
