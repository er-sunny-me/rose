import crypto from 'crypto';
import { TaskExecutor } from './tasks.js';
import { ContextManager } from './context.js';
import { Message } from './context.js';
import { ModelRouter } from './router.js';

export interface Session {
    id: string;
    taskExecutor: TaskExecutor;
    contextManager: ContextManager;
    chatHistory: Message[];
    attachments: string[];
    createdAt: number;
    lastAccessedAt: number;
}

export class SessionManager {
    private static sessions = new Map<string, Session>();

    public static createSession(id?: string): Session {
        const sessionId = id || crypto.randomUUID();
        const session: Session = {
            id: sessionId,
            taskExecutor: new TaskExecutor(),
            contextManager: new ContextManager(),
            chatHistory: [],
            attachments: [],
            createdAt: Date.now(),
            lastAccessedAt: Date.now()
        };
        this.sessions.set(sessionId, session);
        return session;
    }

    public static getSession(id: string): Session | undefined {
        const session = this.sessions.get(id);
        if (session) {
            session.lastAccessedAt = Date.now();
        }
        return session;
    }

    public static listSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    public static deleteSession(id: string): boolean {
        return this.sessions.delete(id);
    }

    public static clearSessionContext(id: string): void {
        const session = this.getSession(id);
        if (session) {
            session.chatHistory = [];
            session.attachments = [];
        }
    }
}
