import { describe, it, expect, beforeAll } from 'vitest';
import { PolicyEngine } from '../src/policy/engine.js';
import { PolicyStore } from '../src/policy/store.js';
import type { IdentityContext } from '../src/policy/models.js';

const coreIdentity: IdentityContext = {
  actor: 'user',
  executor: 'coding-agent',
  trustDomain: 'TRUSTED_CORE',
};

const researchIdentity: IdentityContext = {
  actor: 'agent:research-1',
  executor: 'research-agent',
  trustDomain: 'TRUSTED_CORE',
};

const mcpIdentity: IdentityContext = {
  actor: 'mcp:server-1',
  executor: 'mcp-tool',
  trustDomain: 'UNTRUSTED_MCP',
};

const federatedIdentity: IdentityContext = {
  actor: 'federated:remote-1',
  executor: 'remote-agent',
  trustDomain: 'FEDERATED_REMOTE',
};

describe('PolicyEngine', () => {
  beforeAll(() => {
    PolicyStore.init();
  });

  it('hard-denies execute_command for the research agent', async () => {
    const decision = await PolicyEngine.evaluate('execute_command', 'ls -la', researchIdentity);
    expect(decision.decision).toBe('DENY');
    expect(decision.policyId).toBe('hard-boundary');
  });

  it('denies execute_command originating from untrusted MCP', async () => {
    const decision = await PolicyEngine.evaluate('execute_command', 'echo hi', mcpIdentity);
    expect(decision.decision).toBe('DENY');
  });

  it('denies filesystem writes originating from untrusted MCP', async () => {
    const decision = await PolicyEngine.evaluate('filesystem.write', '/tmp/x', mcpIdentity);
    expect(decision.decision).toBe('DENY');
  });

  it('denies destructive commands from federated remote agents', async () => {
    const decision = await PolicyEngine.evaluate('execute_command', 'rm -rf build', federatedIdentity);
    expect(decision.decision).toBe('DENY');
  });

  it('allows read-only commands for trusted-core executors', async () => {
    const decision = await PolicyEngine.evaluate('execute_command', 'git status', coreIdentity);
    expect(decision.decision).toBe('ALLOW');
  });

  it('applies stored destructive-deny policies for matching subjects', async () => {
    PolicyStore.addPolicy({
      id: 'test-no-destructive',
      description: 'Test policy blocking destructive ops',
      subject: { type: 'agent', id: 'deny-scope-agent' },
      capabilities: [],
      scope: {},
      restrictions: { destructive: 'deny', untrusted: 'confirm' },
    });
    const decision = await PolicyEngine.evaluate(
      'execute_command',
      'rm -rf node_modules',
      { ...coreIdentity, executor: 'deny-scope-agent' }
    );
    expect(decision.decision).toBe('DENY');
  });

  it('upgrades destructive requests to CONFIRM when a subject-scoped policy says confirm', async () => {
    // Subject-scoped (agent id) keeps this policy isolated from the global
    // deny policy added by an earlier test.
    PolicyStore.addPolicy({
      id: 'test-confirm-destructive',
      description: 'Test policy confirming destructive ops',
      subject: { type: 'agent', id: 'confirm-scope-agent' },
      capabilities: [],
      scope: {},
      restrictions: { destructive: 'confirm', untrusted: 'confirm' },
    });
    const identity: IdentityContext = {
      actor: 'user',
      executor: 'confirm-scope-agent',
      trustDomain: 'TRUSTED_CORE',
    };
    // Must match the engine's isDestructive() regex: /(rm|del|format|...) /i
    const decision = await PolicyEngine.evaluate('execute_command', 'del secrets.txt', identity);
    expect(decision.decision).toBe('CONFIRM');
  });

  it('denies network access when policy scope.network is deny', async () => {
    PolicyStore.addPolicy({
      id: 'test-no-network',
      description: 'Test policy denying network',
      subject: { type: 'global' },
      capabilities: [],
      scope: { network: 'deny' },
      restrictions: { destructive: 'confirm', untrusted: 'confirm' },
    });
    const decision = await PolicyEngine.evaluate('service_github', 'list issues', coreIdentity);
    expect(decision.decision).toBe('DENY');
  });

  it('capability grants can override an otherwise confirmed action', async () => {
    PolicyStore.issueGrant({ id: 'grant-1', capability: 'execute_command', scope: 'workspace' });
    const decision = await PolicyEngine.evaluate(
      'execute_command',
      'npm test',
      { ...coreIdentity, executor: 'coding-agent' }
    );
    expect(['ALLOW', 'ALLOW-LIMITED']).toContain(decision.decision);
  });
});
