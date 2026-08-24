import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

/**
 * Real Google integration (Phase 34): one authenticated client shared by the
 * Gmail and Calendar services. OAuth credentials come from:
 *   - GOOGLE_CREDENTIALS env var (path to a tokens JSON), or
 *   - keys.google in config.
 *
 * The JSON must contain { access_token, refresh_token?, expiry_date? } as
 * produced by the standard google-auth-library OAuth2 flow. Refresh tokens
 * are NEVER logged and never written into Memory.
 *
 * Safety: reads run freely once authenticated; sends/creates/deletes are
 * external side effects gated by the Security/Policy engine upstream, and
 * send_email additionally requires an explicit confirmed flag from the model.
 */
export class GoogleIntegration {
    private static oauth: any | null = null;

    public static isConfigured(): boolean {
        return !!(process.env.GOOGLE_CREDENTIALS || process.env.GMAIL_TOKEN || process.env.GOOGLE_CALENDAR_TOKEN);
    }

    /** Build (once) and return the authorized OAuth2 client. */
    public static getOAuth(): any {
        if (this.oauth) return this.oauth;

        const credPath = process.env.GOOGLE_CREDENTIALS;
        let tokens: any = null;
        if (credPath && fs.existsSync(credPath)) {
            tokens = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        }

        const clientId = process.env.GOOGLE_CLIENT_ID || tokens?.client_id;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET || tokens?.client_secret;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

        if (!clientId || !clientSecret) {
            throw new Error('Google OAuth not configured: need GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and a tokens file.');
        }

        const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        if (tokens?.refresh_token || tokens?.access_token) {
            oauth2.setCredentials({
                refresh_token: tokens?.refresh_token,
                access_token: tokens?.access_token,
                expiry_date: tokens?.expiry_date,
            });
        }
        this.oauth = oauth2;
        return oauth2;
    }

    calendar(): CalendarService {
        return new CalendarService();
    }

    gmail(): GmailService {
        return new GmailService();
    }
}

export class CalendarService {
    private api() {
        return google.calendar({ version: 'v3', auth: GoogleIntegration.getOAuth() });
    }

    async listCalendars(limit = 10) {
        const { data } = await this.api().calendarList.list({ maxResults: limit });
        return data.items?.map(c => ({ id: c.id, summary: c.summary, primary: c.primary })) ?? [];
    }

    async listEvents(calendarId = 'primary', maxResults = 10) {
        const { data } = await this.api().events.list({
            calendarId,
            maxResults: Math.min(maxResults, 25),
            singleEvents: true,
            orderBy: 'startTime',
            timeMin: new Date().toISOString(),
        });
        return (data.items ?? []).map(e => ({
            id: e.id, summary: e.summary, start: e.start, end: e.end, link: e.htmlLink,
        }));
    }

    async searchEvents(calendarId = 'primary', query: string, maxResults = 10) {
        if (!query) throw new Error('search_events requires a query');
        const { data } = await this.api().events.list({
            calendarId, q: query, maxResults: Math.min(maxResults, 25), singleEvents: true,
        });
        return (data.items ?? []).map(e => ({
            id: e.id, summary: e.summary, start: e.start, end: e.end, link: e.htmlLink,
        }));
    }

    async createEvent(calendarId: string, params: {
        summary: string; start: string; end: string; description?: string; attendees?: string[];
    }) {
        // Scheduling changes are external side effects â€” the tool layer has
        // already passed policy; validate inputs before hitting the API.
        if (!params.start) throw new Error('create_event requires start (ISO 8601)');
        const event: any = {
            summary: params.summary,
            description: params.description,
            start: params.start.includes('T')
                ? { dateTime: params.start }
                : { date: params.start },
            end: params.end
                ? (params.end.includes('T') ? { dateTime: params.end } : { date: params.end })
                : undefined,
        };
        if (params.attendees?.length) {
            event.attendees = params.attendees.map(a => ({ email: a }));
        }
        const { data } = await this.api().events.insert({ calendarId, requestBody: event });
        return { id: data.id, htmlLink: data.htmlLink };
    }

    async deleteEvent(calendarId: string, eventId: string) {
        if (!eventId) throw new Error('delete_event requires event_id');
        await this.api().events.delete({ calendarId, eventId });
        return { ok: true };
    }
}

export class GmailService {
    private api() {
        return google.gmail({ version: 'v1', auth: GoogleIntegration.getOAuth() });
    }

    async search(query: string, limit = 5) {
        const { data } = await this.api().users.messages.list({
            userId: 'me', q: query, maxResults: Math.min(limit, 20),
        });
        const messages = data.messages ?? [];
        const out: any[] = [];
        for (const m of messages.slice(0, limit)) {
            out.push(await this.read(m.id!));
        }
        return out;
    }

    async read(messageId: string) {
        if (!messageId) throw new Error('read requires message_id');
        const { data } = await this.api().users.messages.get({
            userId: 'me', id: messageId, format: 'full',
        });
        const headers: Record<string, string> = {};
        for (const h of data.payload?.headers ?? []) {
            if (h.name) headers[String(h.name).toLowerCase()] = String(h.value ?? '');
        }

        let bodyText = '';
        const part = data.payload?.body?.data
            ? data.payload
            : data.payload?.parts?.find(p => p.mimeType === 'text/plain');
        if (part?.body?.data) {
            bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8').slice(0, 4000);
        }
        return {
            id: data.id,
            from: headers['from'],
            to: headers['to'],
            subject: headers['subject'],
            date: headers['date'],
            snippet: data.snippet,
            body: bodyText,
        };
    }

    private static mimeMessage(to: string, subject: string, body: string): string {
        const lines = [
            `To: ${to}`,
            'Content-Type: text/plain; charset="UTF-8"',
            'MIME-Version: 1.0',
            `Subject: ${subject}`,
            '',
            body,
        ];
        return Buffer.from(lines.join('\r\n')).toString('base64url');
    }

    async createDraft(to: string, subject: string, body: string) {
        if (!to) throw new Error('draft requires "to"');
        const { data } = await this.api().users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw: GmailService.mimeMessage(to, subject, body) } },
        });
        return { id: data.id };
    }

    async send(to: string, subject: string, body: string) {
        if (!to) throw new Error('send requires "to"');
        const { data } = await this.api().users.messages.send({
            userId: 'me',
            requestBody: { raw: GmailService.mimeMessage(to, subject, body) },
        });
        return { id: data.id };
    }
}

