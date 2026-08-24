export type ServiceStatus = "available" | "disconnected" | "error";

export interface ExternalService {
    id: string;
    name: string;
    status: ServiceStatus;
}

export class ExternalServiceManager {
    public static getServices(): ExternalService[] {
        // Since we are not using heavy SDKs yet, we check the environment for tokens.
        // GitHub: Check GITHUB_TOKEN
        // Google Calendar: Check GOOGLE_CALENDAR_TOKEN
        // Gmail: Check GMAIL_TOKEN
        return [
            {
                id: 'github',
                name: 'GitHub',
                status: process.env.GITHUB_TOKEN ? 'available' : 'disconnected'
            },
            {
                id: 'calendar',
                name: 'Google Calendar',
                status: process.env.GOOGLE_CALENDAR_TOKEN ? 'available' : 'disconnected'
            },
            {
                id: 'email',
                name: 'Gmail',
                status: process.env.GMAIL_TOKEN ? 'available' : 'disconnected'
            }
        ];
    }

    public static getService(id: string): ExternalService | undefined {
        return this.getServices().find(s => s.id === id);
    }
}
