import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-extsign-'));
process.chdir(tmpRoot);

const S = await import('../src/extensions/signing.js');

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeExtension(dir: string, code: string): SignedManifestLite {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), code, 'utf-8');
  const manifest = {
    id: `plugin.test-${path.basename(dir)}`,
    name: `Test ${path.basename(dir)}`,
    version: '1.0.0',
    publisher: 'acme',
    entry: 'index.js',
    capabilities: [],
  };
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest), 'utf-8');
  return manifest as any;
}
type SignedManifestLite = Record<string, any> & { publisher: string };

describe('Phase 36 — extension signing', () => {
  let keypair: ReturnType<typeof S.generatePublisherKeyPair>;

  beforeAll(() => {
    keypair = S.generatePublisherKeyPair('acme-key-1');
    S.TrustedPublisherRegistry.trust('acme', 'acme-key-1', keypair.publicKeyPem);
  });

  it('valid signature passes verification', () => {
    const dir = path.join(tmpRoot, 'ext-valid');
    const manifest = makeExtension(dir, 'module.exports = { hello: "world" };');
    const { signature } = S.signExtension(dir, manifest as any, keypair.privateKeyPem, 'acme-key-1');
    (manifest as any).signature = signature;
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));

    const outcome = S.verifyInstalledExtension(dir);
    expect(outcome.ok).toBe(true);
    expect(outcome.keyId).toBe('acme-key-1');
  });

  it('modified JS after signing is rejected', () => {
    const dir = path.join(tmpRoot, 'ext-tampered-js');
    const manifest = makeExtension(dir, 'module.exports = {};');
    const { signature } = S.signExtension(dir, manifest as any, keypair.privateKeyPem, 'acme-key-1');
    (manifest as any).signature = signature;
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), 'require("child_process").exec("evil")', 'utf-8');

    expect(S.verifyInstalledExtension(dir).ok).toBe(false);
    expect(S.verifyInstalledExtension(dir).failure).toBe('modified-content');
  });

  it('modified manifest after signing is rejected', () => {
    const dir = path.join(tmpRoot, 'ext-tampered-manifest');
    const manifest = makeExtension(dir, 'module.exports = {};');
    const { signature } = S.signExtension(dir, manifest as any, keypair.privateKeyPem, 'acme-key-1');
    (manifest as any).signature = signature;
    (manifest as any).capabilities = ['terminal'];
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));

    expect(S.verifyInstalledExtension(dir).ok).toBe(false);
  });

  it('unknown publisher is rejected', () => {
    const dir = path.join(tmpRoot, 'ext-unknown');
    const manifest = makeExtension(dir, 'x');
    const other = S.generatePublisherKeyPair('other-key');
    const { signature } = S.signExtension(dir, manifest as any, other.privateKeyPem, 'other-key');
    (manifest as any).publisher = 'mallory';
    (manifest as any).signature = signature;
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));

    expect(S.verifyInstalledExtension(dir).failure).toBe('unknown-publisher');
  });

  it('revoked publisher is rejected even with a valid signature', () => {
    const dir = path.join(tmpRoot, 'ext-revoked');
    S.TrustedPublisherRegistry.trust('flashsale', 'fs-key-1', keypair.publicKeyPem);
    const manifest = makeExtension(dir, 'x');
    (manifest as any).publisher = 'flashsale'; // set BEFORE signing
    const { signature } = S.signExtension(dir, manifest as any, keypair.privateKeyPem, 'fs-key-1');
    (manifest as any).signature = signature;
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));

    expect(S.verifyInstalledExtension(dir).ok).toBe(true); // valid before revoke
    S.TrustedPublisherRegistry.revoke('flashsale', 'fs-key-1');
    const after = S.verifyInstalledExtension(dir);
    expect(after.ok).toBe(false);
    expect(after.failure).toBe('revoked-publisher');
  });

  it('signature from a different trusted key fails (wrong public key)', () => {
    const dir = path.join(tmpRoot, 'ext-wrongkey');
    const k2 = S.generatePublisherKeyPair('acme-key-2');
    S.TrustedPublisherRegistry.trust('acme', 'acme-key-2', k2.publicKeyPem);
    const manifest = makeExtension(dir, 'x');
    // Sign with key-1 but claim key-2
    const { signature } = S.signExtension(dir, manifest as any, keypair.privateKeyPem, 'acme-key-2');
    (manifest as any).signature = signature;
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));

    expect(S.verifyInstalledExtension(dir).ok).toBe(false);
  });

  it('unsigned extension reports unsigned', () => {
    const dir = path.join(tmpRoot, 'ext-unsigned');
    makeExtension(dir, 'module.exports = 42;');
    expect(S.verifyInstalledExtension(dir).failure).toBe('unsigned');
  });

  it('corrupt manifest reports corrupt-manifest', () => {
    const dir = path.join(tmpRoot, 'ext-corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.json'), '{oops', 'utf-8');
    expect(S.verifyInstalledExtension(dir).failure).toBe('corrupt-manifest');
  });

  it('canonical digest is deterministic and order-independent', () => {
    const d1 = path.join(tmpRoot, 'digest-a');
    const d2 = path.join(tmpRoot, 'digest-b');
    makeExtension(d1, 'same content');
    fs.writeFileSync(path.join(d1, 'extra.txt'), 'E', 'utf-8');
    makeExtension(d2, 'same content');
    fs.writeFileSync(path.join(d2, 'extra.txt'), 'E', 'utf-8');
    expect(S.canonicalDigest(d1).digest).toBe(S.canonicalDigest(d2).digest);
  });
});
