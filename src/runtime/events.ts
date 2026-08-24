import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { Telemetry } from '../telemetry.js';

export type AggregateType = 'session' | 'task' | 'transaction' | 'automation' | 'worker' | 'approval' | 'goal' | 'world' | 'incident' | 'maintenance' | 'federation';

export interface RuntimeEvent {
    id: string;
    sequence: number;
    aggregateType: AggregateType;
    aggregateId: string;
    type: string;
    timestamp: number;
    payload: any;
    metadata?: {
        traceId?: string;
        parentEventId?: string;
        clientId?: string;
        actorId?: string;
    };
}

export interface RuntimeSnapshot {
    aggregateId: string;
    aggregateType: AggregateType;
    sequence: number;
    state: any;
    createdAt: number;
}

export class EventStore {
    private static BASE_DIR = path.join(process.cwd(), '.gemini', 'events');
    private static LOG_FILE = path.join(process.cwd(), '.gemini', 'events', 'runtime.jsonl');
    private static currentSequence = 0;
    private static sequenceMap: Map<string, number> = new Map();

    public static init() {
        if (!fs.existsSync(this.BASE_DIR)) {
            fs.mkdirSync(this.BASE_DIR, { recursive: true });
        }
        
        // Load initial sequence counts
        if (fs.existsSync(this.LOG_FILE)) {
            const content = fs.readFileSync(this.LOG_FILE, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            
            for (const line of lines) {
                try {
                    const evt: RuntimeEvent = JSON.parse(line);
                    this.currentSequence = Math.max(this.currentSequence, evt.sequence);
                    const aggSeq = this.sequenceMap.get(evt.aggregateId) || 0;
                    this.sequenceMap.set(evt.aggregateId, Math.max(aggSeq, evt.sequence));
                } catch(e) {}
            }
        }
    }

    public static async append(aggregateType: AggregateType, aggregateId: string, type: string, payload: any, metadata?: any): Promise<RuntimeEvent> {
        this.currentSequence++;
        const event: RuntimeEvent = {
            id: crypto.randomBytes(8).toString('hex'),
            sequence: this.currentSequence,
            aggregateType,
            aggregateId,
            type,
            timestamp: Date.now(),
            payload,
            metadata
        };

        const line = JSON.stringify(event) + '\n';
        fs.appendFileSync(this.LOG_FILE, line);
        
        this.sequenceMap.set(aggregateId, this.currentSequence);

        // Forward to observability / EventBus conceptually
        if (type.startsWith('task.')) {
            Telemetry.recordEvent(type, 'agent', 'completed', undefined, { aggregateId });
        }
        
        return event;
    }

    public static async read(aggregateType?: AggregateType, aggregateId?: string, afterSequence: number = 0): Promise<RuntimeEvent[]> {
        if (!fs.existsSync(this.LOG_FILE)) return [];
        
        const content = fs.readFileSync(this.LOG_FILE, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        
        const events: RuntimeEvent[] = [];
        for (const line of lines) {
            try {
                const evt: RuntimeEvent = JSON.parse(line);
                if (evt.sequence > afterSequence) {
                    if (aggregateType && evt.aggregateType !== aggregateType) continue;
                    if (aggregateId && evt.aggregateId !== aggregateId) continue;
                    events.push(evt);
                }
            } catch(e) {}
        }
        return events;
    }

    public static async readAll(): Promise<RuntimeEvent[]> {
        return this.read();
    }
}
