import fs from 'fs';
import path from 'path';
import { WorldModel } from './model.js';
import { AgentRegistry } from '../agents.js';

export class ObservationEngine {
    public static observeProject() {
        // Look at package.json, tsconfig.json, etc.
        const pkgPath = path.join(process.cwd(), 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                WorldModel.updateEntity({
                    id: 'project:package',
                    type: 'project',
                    name: pkg.name || 'unknown',
                    state: 'healthy',
                    source: 'OBSERVED',
                    attributes: {
                        version: pkg.version,
                        dependenciesCount: Object.keys(pkg.dependencies || {}).length
                    },
                    lastObservedAt: Date.now()
                });
            } catch (e) {
                WorldModel.updateEntity({
                    id: 'project:package',
                    type: 'project',
                    state: 'broken',
                    source: 'OBSERVED',
                    lastObservedAt: Date.now()
                });
            }
        }
    }

    public static observeWorkers() {
        const agents = AgentRegistry.list();
        for (const agent of agents) {
            WorldModel.updateEntity({
                id: `worker:${agent.id}`,
                type: 'worker',
                name: agent.name,
                state: agent.health === 'HEALTHY' ? 'healthy' : (agent.health === 'DEGRADED' ? 'degraded' : 'broken'),
                source: 'OBSERVED',
                attributes: {
                    capabilities: agent.capabilities
                },
                lastObservedAt: Date.now()
            });
        }
    }

    public static fullRefresh() {
        this.observeProject();
        this.observeWorkers();
    }
}
