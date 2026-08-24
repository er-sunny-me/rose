import chalk from 'chalk';
import { ExternalServiceManager } from './services.js';
import { ModelRouter } from './router.js';

export type Capability = "web" | "browser" | "filesystem" | "terminal" | "system" | "github" | "calendar" | "email";

export class CapabilityRouter {
    public static getAvailableCapabilities(): { [key in Capability]: boolean } {
        // Here we statically define capabilities available in this environment.
        // Terminal, Filesystem, and System are handled by `execute_command`.
        // Web and Browser are handled by `web_search` and `fetch_page` natively.
        const services = ExternalServiceManager.getServices();
        
        return {
            web: true,
            browser: true,
            filesystem: true,
            terminal: true,
            system: true,
            github: services.find(s => s.id === 'github')?.status === 'available',
            calendar: services.find(s => s.id === 'calendar')?.status === 'available',
            email: services.find(s => s.id === 'email')?.status === 'available'
        };
    }

    public static getCapabilitiesContext(): string {
        const caps = this.getAvailableCapabilities();
        let context = "[AVAILABLE CAPABILITIES]\n";
        for (const [cap, available] of Object.entries(caps)) {
            context += `- ${cap}: ${available ? 'AVAILABLE' : 'UNAVAILABLE'}\n`;
        }
        context += "Use the appropriate tools for the capabilities needed. Do not attempt to use UNAVAILABLE capabilities.\n";
        return context;
    }

    public static async detectRequiredCapabilities(goal: string): Promise<Capability[]> {
        const prompt = `You are a capability router. The user has requested: "${goal}"
Which capabilities are strictly necessary to accomplish this task?
Available capabilities to choose from: web, browser, filesystem, terminal, system, github, calendar, email.
Respond ONLY with a JSON array of strings. No markdown. Example: ["web", "browser"]`;

        try {
            const data = await ModelRouter.route(
                { capabilities: ['fast'], intent: 'detect_capabilities', maxTokens: 100 },
                [{ role: 'user', content: prompt }]
            );
            
            let replyText = "";
            if (data.content && Array.isArray(data.content)) {
                for (const part of data.content) {
                    if (part.type === "text" && part.text) replyText += part.text;
                }
            } else if (data.choices && data.choices[0]?.message?.content) {
                replyText = data.choices[0].message.content;
            }

            replyText = replyText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(replyText);
            
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            return [];
        }
    }
}
