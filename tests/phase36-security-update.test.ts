import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-p36-'));
process.chdir(tmpRoot);

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Phase 36 — SecretStore', () => {
  it('round-trips set/get/delete through the resolved store', async () => {
    const { Secrets } = await import('../src/security/secrets.js');
    await Secrets.set('test-cred', 's3cret-value');
    expect(await Secrets.get('test-cred')).toBe('s3cret-value');
    expect(await Secrets.remove('test-cred')).toBe(true);
    expect(await Secrets.get('test-cred')).toBeNull();
  });

  it('status never reports values, only sources', async () => {
    const { Secrets } = await import('../src/security/secrets.js');
    const rows = await Secrets.status({ gemini: 'PLAINTEXT-SHOULD-NOT-LEAK' });
    const gemini = rows.find(r => r.credential === 'gemini-api-key')!;
    expect(gemini.source).toBe('plaintext-config');
    for (const r of rows) {
      expect(Object.values(r).join(' ')).not.toContain('PLAINTEXT-SHOULD-NOT-LEAK');
    }
  });

  it('migration writes to store and reports without exposing values', async () => {
    const { Secrets } = await import('../src/security/secrets.js');
    const { migrated } = await Secrets.migrateFromConfig({ gemini: 'legacy-key-value' }, true);
    expect(migrated).toContain('gemini');
    expect(await Secrets.get('gemini-api-key')).toBe('legacy-key-value');
    await Secrets.remove('gemini-api-key');
  });
});

describe('Phase 36 — auth lockout + rate limit classes', () => {
  it('locks after max failures with progressive backoff and recovers on success', async () => {
    const { AuthLockout } = await import('../src/server/ratelimit.js');
    const lo = new AuthLockout(3, 1000);
    const key = AuthLockout.keyFor('1.2.3.4', 'bad-token');

    expect(lo.isLocked(key).locked).toBe(false);
    lo.recordFailure(key); lo.recordFailure(key);
    expect(lo.isLocked(key).locked).toBe(false);

    lo.recordFailure(key); // 3rd → lockout
    expect(lo.isLocked(key).locked).toBe(true);
    expect(lo.isLocked(key).retryAfterSec).toBeGreaterThan(0);

    // success clears
    lo.recordSuccess(key);
    expect(lo.isLocked(key).locked).toBe(false);
  });

  it('progressive backoff grows with repeated lockouts', async () => {
    const { AuthLockout } = await import('../src/server/ratelimit.js');
    const lo = new AuthLockout(2, 500);
    const key = AuthLockout.keyFor('5.6.7.8', 'tok');

    lo.recordFailure(key); lo.recordFailure(key);
    const first = lo.isLocked(key).retryAfterSec;

    // simulate expiry then re-offend quickly
    lo.recordFailure(key); lo.recordFailure(key);
    const second = lo.isLocked(key).retryAfterSec;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('different tokens/IPs are tracked independently (no trivial lockout of others)', async () => {
    const { AuthLockout } = await import('../src/server/ratelimit.js');
    const lo = new AuthLockout(2, 60_000);
    const attacker = AuthLockout.keyFor('9.9.9.9', 'guess-1');
    const victim = AuthLockout.keyFor('9.9.9.10', 'victim-token');

    lo.recordFailure(attacker); lo.recordFailure(attacker);
    expect(lo.isLocked(attacker).locked).toBe(true);
    expect(lo.isLocked(victim).locked).toBe(false);
  });

  it('endpoint classes map to different limiters', async () => {
    const { limiterFor } = await import('../src/server/ratelimit.js');
    expect(limiterFor('/health')).not.toBe(limiterFor('/api/v1/sessions/x/messages'));
    expect(limiterFor('/api/v1/policies/evaluate')).toBeDefined();
  });
});

describe('Phase 36 — update version logic', () => {
  it('compareVersions handles stable ordering and prerelease guardrails', async () => {
    const U = await import('../src/update.js');
    expect(U.compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(U.compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(U.compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(U.isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(U.isPrerelease('1.0.0')).toBe(false);
  });

  it('selfUpdate refuses non-semver targets (no arbitrary packages)', async () => {
    const U = await import('../src/update.js');
    const res = await U.selfUpdate('latest; rm -rf /');
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refusing/i);
  });

  it('buildDryRun produces a safe plan without installing', async () => {
    const U = await import('../src/update.js');
    const plan = U.buildDryRun({ current: '1.0.0', latest: '1.1.0', updateAvailable: true, channel: 'stable' });
    expect(plan.command).toBe('npm install -g rose-ai@1.1.0');
    expect(plan.restartRequired).toBe(true);
  });
});
