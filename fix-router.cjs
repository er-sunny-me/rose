const fs = require('fs');

let content = fs.readFileSync('src/router.ts', 'utf8');

// 1. ModelRequirements
content = content.replace(
`export interface ModelRequirements {
    capabilities?: string[];`,
`export interface ModelRequirements {
    tools?: any[];
    capabilities?: string[];`
);

// 2. ModelProvider execute signature and toJsSchema
content = content.replace(
`    execute(messages: any[], system?: string, maxTokens?: number): Promise<any>;
}`,
`    execute(messages: any[], system?: string, maxTokens?: number, roseTools?: any[]): Promise<any>;
}

function toJsSchema(params: any): any {
    if (!params) return { type: 'object', properties: {} };
    const walk = (node: any): any => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            const out: any = {};
            for (const [k, v] of Object.entries(node)) {
                out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : walk(v);
            }
            return out;
        }
        return node;
    };
    const copy = walk(params);
    if (!copy.properties) copy.properties = {};
    return copy;
}`
);

// 3. GeminiProvider
content = content.replace(
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {`,
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {`
);

content = content.replace(
`            if (system) {
                body.systemInstruction = { parts: [{ text: system }] };
            }`,
`            if (system) {
                body.systemInstruction = { parts: [{ text: system }] };
            }
            if (roseTools && roseTools.length > 0) {
                body.tools = [{ functionDeclarations: roseTools.map((t: any) => ({ name: t.name, description: t.description, parameters: toJsSchema(t.parameters) })) }];
            }`
);

// 4. AnthropicProvider
content = content.replace(
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {`,
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {`
);

content = content.replace(
`            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;`,
`            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;
            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ name: t.name, description: t.description, input_schema: toJsSchema(t.parameters) }));
            }`
);

// 5. OpenAIProvider
content = content.replace(
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {`,
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {`
);

content = content.replace(
`            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": \`Bearer \${apiKey}\`
                },
                body: JSON.stringify({
                    model: this.providerId,
                    max_tokens: maxTokens,
                    messages: msgs
                })
            });`,
`            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: msgs
            };
            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsSchema(t.parameters) } }));
            }
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": \`Bearer \${apiKey}\`
                },
                body: JSON.stringify(body)
            });`
);

// 6. ProxyProvider
content = content.replace(
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192): Promise<any> {`,
`    public async execute(messages: any[], system?: string, maxTokens: number = 8192, roseTools?: any[]): Promise<any> {`
);

content = content.replace(
`            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;`,
`            const body: any = {
                model: this.providerId,
                max_tokens: maxTokens,
                messages: messages
            };
            if (system) body.system = system;
            if (roseTools && roseTools.length > 0) {
                body.tools = roseTools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsSchema(t.parameters) } }));
            }`
);

fs.writeFileSync('src/router.ts', content, 'utf8');
console.log("Successfully patched src/router.ts");
