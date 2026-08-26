import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// TransactionManager + EventStore resolve storage paths from process.cwd()
// at module load — isolate into a temp dir BEFORE importing.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-tx-'));
process.chdir(tmpRoot);

let EventStore: typeof import('../src/runtime/events.js').EventStore;
let TransactionManager: typeof import('../src/transaction.js').TransactionManager;

beforeAll(async () => {
  ({ EventStore } = await import('../src/runtime/events.js'));
  ({ TransactionManager } = await import('../src/transaction.js'));
  EventStore.init();
  await TransactionManager.init();

  // Prepare a workspace file for checkpoint tests
  fs.writeFileSync(path.join(tmpRoot, 'workspace.txt'), 'original content', 'utf-8');
});

afterAll(() => {
  process.chdir('/');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('TransactionManager', () => {
  it('begin() creates a transaction in PREPARING state', async () => {
    const tx = await TransactionManager.begin('task-1');
    expect(tx.status).toBe('PREPARING');
    expect(TransactionManager.getTransaction(tx.id)).toBeDefined();
  });

  it('begin(simulate=true) creates a SIMULATING transaction that skips checkpoints', async () => {
    const tx = await TransactionManager.begin('task-sim', true);
    expect(tx.status).toBe('SIMULATING');
    const cp = await TransactionManager.createCheckpoint(tx.id, 'workspace.txt');
    expect(cp).toBeNull();
  });

  it('createCheckpoint backs up the target file', async () => {
    const tx = await TransactionManager.begin('task-2');
    const cpId = await TransactionManager.createCheckpoint(tx.id, 'workspace.txt');
    expect(cpId).toBeTruthy();
    const stored = TransactionManager.getTransaction(tx.id)!;
    expect(stored.checkpoints).toHaveLength(1);
    expect(stored.checkpoints[0].type).toBe('file_backup');
    // cleanup backup so commit test is deterministic
    await TransactionManager.commit(tx.id);
  });

  it('recordAction appends actions with side-effect types', async () => {
    const tx = await TransactionManager.begin('task-3');
    TransactionManager.recordAction(tx.id, 'save_memory', 'memory/vault/x.md', 'PREDICTABLE_WRITE');
    const stored = TransactionManager.getTransaction(tx.id)!;
    expect(stored.actions).toHaveLength(1);
    expect(stored.actions[0].tool).toBe('save_memory');
    await TransactionManager.commit(tx.id);
  });

  it('commit() moves status to COMMITTED and removes backups', async () => {
    const tx = await TransactionManager.begin('task-4');
    const cpId = await TransactionManager.createCheckpoint(tx.id, 'workspace.txt') as string;
    await TransactionManager.commit(tx.id);
    const stored = TransactionManager.getTransaction(tx.id)!;
    expect(stored.status).toBe('COMMITTED');
    const backupPath = path.join(tmpRoot, '.gemini', 'transactions', `${cpId}.backup`);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it('rollback() restores file content from checkpoint (undo write)', async () => {
    const target = path.join(tmpRoot, 'workspace.txt');

    const tx = await TransactionManager.begin('task-5');
    await TransactionManager.createCheckpoint(tx.id, 'workspace.txt');

    // Simulate a destructive write
    fs.writeFileSync(target, 'mutated content', 'utf-8');
    TransactionManager.recordAction(tx.id, 'execute_command', 'workspace.txt', 'PREDICTABLE_WRITE');

    const ok = await TransactionManager.rollback(tx.id);
    expect(ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('original content');
    expect(TransactionManager.getTransaction(tx.id)!.status).toBe('ROLLED_BACK');
  });

  it('rollback() deletes files created after the checkpoint when backup is gone', async () => {
    const target = path.join(tmpRoot, 'created-after-checkpoint.txt');

    const tx = await TransactionManager.begin('task-6');
    await TransactionManager.createCheckpoint(tx.id, 'workspace.txt');
    const stored = TransactionManager.getTransaction(tx.id)!;
    const cp = stored.checkpoints[0];

    // Model a file that did NOT exist at checkpoint time: repoint the
    // checkpoint and remove its backup so rollback takes the delete branch.
    (cp as any).target = target;
    fs.rmSync(path.join(tmpRoot, '.gemini', 'transactions', `${cp.id}.backup`), { force: true });
    fs.writeFileSync(target, 'new file', 'utf-8');

    const ok = await TransactionManager.rollback(tx.id);
    expect(ok).toBe(true);
    let gone = !fs.existsSync(target);
    for (let i = 0; i < 10 && !gone; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      gone = !fs.existsSync(target);
    }
    expect(gone).toBe(true);
  });

  it('partial rollback failure marks the transaction FAILED', async () => {
    const tx = await TransactionManager.begin('task-partial');
    await TransactionManager.createCheckpoint(tx.id, 'workspace.txt');
    const stored = TransactionManager.getTransaction(tx.id)!;
    const cp = stored.checkpoints[0];
    // Backup exists but the restore target's directory does not:
    // copyFileSync throws ENOENT -> failCount=1 -> FAILED.
    (cp as any).target = path.join(tmpRoot, 'no-such-dir', 'x.txt');

    const ok = await TransactionManager.rollback(tx.id);
    expect(ok).toBe(false);
    expect(TransactionManager.getTransaction(tx.id)!.status).toBe('FAILED');

    // restore workspace.txt content in case later tests need it
    fs.writeFileSync(path.join(tmpRoot, 'workspace.txt'), 'original content', 'utf-8');
  });

  it('rollback() on an unknown id returns false without throwing', async () => {
    const ok = await TransactionManager.rollback('does-not-exist');
    expect(ok).toBe(false);
  });

  it('duplicate rollback returns false (idempotent)', async () => {
    const target = path.join(tmpRoot, 'dup-rollback.txt');
    fs.writeFileSync(target, 'v1', 'utf-8');
    const tx = await TransactionManager.begin('task-7');
    await TransactionManager.createCheckpoint(tx.id, 'dup-rollback.txt');
    fs.writeFileSync(target, 'v2', 'utf-8');
    expect(await TransactionManager.rollback(tx.id)).toBe(true);
    expect(await TransactionManager.rollback(tx.id)).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('v1');
  });
});
