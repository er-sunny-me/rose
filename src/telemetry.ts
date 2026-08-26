import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SecurityEngine } from './security.js';
import { roseDataPath } from './storage-paths.js';

export interface TraceContext {
    traceId: string;
    sessionId: string;
    taskId?: string;
    parentTraceId?: string;
}

export interface AgentEventRecord {
    id: string;
    traceId: string;
    timestamp: number;
    type: string;
    source: "agent" | "model" | "tool" | "skill" | "memory" | "security" | "context" | "extension" | "mcp" | "system";
    status?: "started" | "completed" | "failed" | "cancelled";
    durationMs?: number;
    metadata?: Record<string, unknown>;
}

export class Telemetry {
    private static logStream: fs.WriteStream | null = null;
    public static currentTrace: TraceContext | null = null;
    
    // In-memory buffer for diagnostics
    private static recentEvents: AgentEventRecord[] = [];
    public static lastRunMetrics: Record<string, any> = {};

    public static initialize() {
        const logDir = roseDataPath('logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logPath = path.join(logDir, 'agent.jsonl');
        this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    }

    public static startTrace(sessionId: string, taskId?: string): string {
        const traceId = crypto.randomUUID();
        this.currentTrace = { traceId, sessionId, taskId };
        this.recentEvents = []; // Reset trace memory
        this.lastRunMetrics = {
            startTime: Date.now(),
            tools: 0,
            retries: 0
        };
        this.recordEvent('request.received', 'system', 'started');
        return traceId;
    }

    public static recordEvent(
        type: string, 
        source: AgentEventRecord["source"], 
        status?: AgentEventRecord["status"], 
        durationMs?: number, 
        metadata?: Record<string, unknown>
    ) {
        if (!this.currentTrace) return;

        // Redact any string values in metadata
        let safeMetadata = undefined;
        if (metadata) {
            safeMetadata = {} as Record<string, unknown>;
            for (const [k, v] of Object.entries(metadata)) {
                if (typeof v === 'string') safeMetadata[k] = SecurityEngine.redactSecrets(v);
                else safeMetadata[k] = v;
            }
        }

        const event: AgentEventRecord = {
            id: crypto.randomUUID(),
            traceId: this.currentTrace.traceId,
            timestamp: Date.now(),
            type,
            source,
            status,
            durationMs,
            metadata: safeMetadata
        };

        this.recentEvents.push(event);

        if (this.logStream) {
            this.logStream.write(JSON.stringify(event) + '\n');
        }

        // Update Last Run stats
        if (source === 'tool' && status === 'completed') this.lastRunMetrics.tools++;
    }

    public static getRecentTrace(): AgentEventRecord[] {
        return this.recentEvents;
    }

    public static endTrace() {
        if (this.currentTrace) {
            this.recordEvent('task.completed', 'system', 'completed');
            this.lastRunMetrics.duration = Date.now() - this.lastRunMetrics.startTime;
            this.currentTrace = null;
        }
    }
}
