import fs from 'fs';
import path from 'path';
import { roseDataPath } from '../storage-paths.js';

export type EntityState = 'healthy' | 'degraded' | 'broken' | 'unknown';
export type ObservationSource = 'OBSERVED' | 'REMEMBERED' | 'INFERRED' | 'PREDICTED';

export interface WorldEntity {
    id: string;
    type: string;
    name?: string;
    state: EntityState;
    source: ObservationSource;
    attributes?: Record<string, any>;
    lastObservedAt: number;
}

export interface DependencyEdge {
    from: string;
    to: string;
    type: string; // e.g., 'depends_on', 'calls', 'uses'
    confidence: number; // 0.0 to 1.0
    source: string; // static, runtime, manual
}

export class WorldModel {
    private static entities: Map<string, WorldEntity> = new Map();
    private static edges: DependencyEdge[] = [];
    private static CACHE_FILE = roseDataPath('world_model.json');

    public static init() {
        if (fs.existsSync(this.CACHE_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.CACHE_FILE, 'utf-8'));
                if (Array.isArray(data)) {
                    // Backwards compatibility
                    for (const entity of data) {
                        this.entities.set(entity.id, entity);
                    }
                } else if (data.entities && data.edges) {
                    for (const entity of data.entities) {
                        this.entities.set(entity.id, entity);
                    }
                    this.edges = data.edges;
                }
            } catch (e) {
                console.error("Failed to parse world_model.json");
            }
        }
    }

    private static save() {
        const dir = path.dirname(this.CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const data = {
            entities: Array.from(this.entities.values()),
            edges: this.edges
        };
        fs.writeFileSync(this.CACHE_FILE, JSON.stringify(data, null, 2));
    }

    public static updateEntity(entity: WorldEntity) {
        // Priority logic: OBSERVED > REMEMBERED > INFERRED > PREDICTED
        const priority = { 'OBSERVED': 4, 'REMEMBERED': 3, 'INFERRED': 2, 'PREDICTED': 1 };
        
        const existing = this.entities.get(entity.id);
        if (existing) {
            const newPri = priority[entity.source];
            const oldPri = priority[existing.source];
            // If new observation is strictly weaker (e.g. INFERRED) and older is OBSERVED recently (e.g. last 1 hr), we might ignore.
            // For simplicity, if it's OBSERVED we always take it. Otherwise if new > old or time diff is huge, we take it.
            if (newPri >= oldPri || (Date.now() - existing.lastObservedAt > 3600000)) {
                this.entities.set(entity.id, entity);
                this.save();
            }
        } else {
            this.entities.set(entity.id, entity);
            this.save();
        }
    }

    public static addEdge(edge: DependencyEdge) {
        const existing = this.edges.findIndex(e => e.from === edge.from && e.to === edge.to && e.type === edge.type);
        if (existing !== -1) {
            // Update confidence if it's from a more reliable source, for simplicity just overwrite here
            this.edges[existing] = edge;
        } else {
            this.edges.push(edge);
        }
        this.save();
    }

    public static getEntity(id: string): WorldEntity | undefined {
        return this.entities.get(id);
    }

    public static getEntitiesByType(type: string): WorldEntity[] {
        return Array.from(this.entities.values()).filter(e => e.type === type);
    }

    public static getAll(): WorldEntity[] {
        return Array.from(this.entities.values());
    }

    public static getEdges(): DependencyEdge[] {
        return this.edges;
    }

    public static getForwardDependencies(id: string): DependencyEdge[] {
        return this.edges.filter(e => e.from === id);
    }

    public static getReverseDependencies(id: string): DependencyEdge[] {
        return this.edges.filter(e => e.to === id);
    }
}
