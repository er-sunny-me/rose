import { WebSocket } from 'ws';
import crypto from 'crypto';
import { loadIdentity, PROTOCOL_VERSION } from '../mesh-client.js';

export class AndroidController {
    public static async executeAction(action: string, params: Record<string, any>): Promise<string> {
        const id = loadIdentity();
        if (!id || !id.serverUrl || !id.deviceId || !id.agentId) {
            return 'Error: PC Agent is not connected to a Mesh server. Run rose agents connect with ROSE_API_TOKEN set.';
        }

        const token = process.env.ROSE_API_TOKEN || '';
        let targetAgentId = '';
        try {
            const res = await fetch(id.serverUrl + '/api/agents', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (res.ok) {
                const agents = (await res.json()) as any[];
                const androidAgent = agents.find((a: any) => a.platform === 'android' && a.status === 'online');
                if (androidAgent) {
                    targetAgentId = androidAgent.agentId;
                }
            }
        } catch (e: any) {
            return 'Error fetching agents: ' + e.message;
        }

        if (!targetAgentId) {
            return 'Error: No online Android agent found in the Mesh. Ensure the mobile app is open and connected.';
        }

        return new Promise((resolve, reject) => {
            const wsUrl = id.serverUrl.replace(/^http/, 'ws') + '/mesh/ws';
            const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
            
            const taskId = 'android-' + crypto.randomBytes(4).toString('hex');
            
            const timeout = setTimeout(() => {
                ws.close();
                resolve('Error: Timed out waiting for Android device to respond to action ' + action);
            }, 30000);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'hello', v: PROTOCOL_VERSION,
                    nonce: crypto.randomBytes(8).toString('hex'), ts: Date.now(),
                    deviceId: id.deviceId,
                    displayName: 'PC Tool Executor',
                    platform: process.platform === 'win32' ? 'windows' : 'other',
                    runtimeVersion: '1.0.0',
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: ['android_controller'],
                }));
            });

            ws.on('message', (data) => {
                let msg: any;
                try { msg = JSON.parse(data.toString()); } catch { return; }

                if (msg.type === 'welcome') {
                    const payload = {
                        action,
                        ...params
                    };
                    ws.send(JSON.stringify({
                        type: 'agent.task.delegate',
                        v: PROTOCOL_VERSION,
                        nonce: crypto.randomBytes(8).toString('hex'),
                        ts: Date.now(),
                        from: id.agentId,
                        to: targetAgentId,
                        taskId: taskId,
                        goal: JSON.stringify(payload),
                        originAgent: id.agentId,
                        ownerAgent: id.agentId,
                        requiredCapabilities: ['android_control'],
                        policy: { scope: 'delegated' }
                    }));
                } else if (msg.type === 'agent.task.result' && msg.taskId === taskId) {
                    clearTimeout(timeout);
                    ws.close();
                    if (msg.state === 'completed') {
                        resolve(msg.summary || 'Success');
                    } else {
                        resolve('Android Error: ' + (msg.summary || 'Failed'));
                    }
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                resolve('WebSocket Error: ' + err.message);
            });
        });
    }
}

