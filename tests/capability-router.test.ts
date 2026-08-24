import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityRouter } from '../src/capabilities.js';

describe('CapabilityRouter.getAvailableCapabilities', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GOOGLE_CALENDAR_TOKEN;
    delete process.env.GMAIL_TOKEN;
  });

  it('always exposes local capabilities', () => {
    const caps = CapabilityRouter.getAvailableCapabilities();
    expect(caps.web).toBe(true);
    expect(caps.browser).toBe(true);
    expect(caps.filesystem).toBe(true);
    expect(caps.terminal).toBe(true);
    expect(caps.system).toBe(true);
  });

  it('marks GitHub unavailable without GITHUB_TOKEN', () => {
    const caps = CapabilityRouter.getAvailableCapabilities();
    expect(caps.github).toBe(false);
  });

  it('marks GitHub available with GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const caps = CapabilityRouter.getAvailableCapabilities();
    expect(caps.github).toBe(true);
  });

  it('marks calendar/email unavailable without tokens', () => {
    const caps = CapabilityRouter.getAvailableCapabilities();
    expect(caps.calendar).toBe(false);
    expect(caps.email).toBe(false);
  });

  it('getCapabilitiesContext lists every capability with a status', () => {
    process.env.GITHUB_TOKEN = 'tok';
    const context = CapabilityRouter.getCapabilitiesContext();
    expect(context).toContain('[AVAILABLE CAPABILITIES]');
    expect(context).toContain('- web: AVAILABLE');
    expect(context).toContain('- github: AVAILABLE');
    expect(context).toContain('- email: UNAVAILABLE');
  });
});
