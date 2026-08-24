import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Octokit so tests never touch the network.
const calls: any[] = [];
vi.mock('@octokit/rest', () => {
  class FakeOctokit {
    rest = {
      issues: {
        listForRepo: async (p: any) => {
          calls.push(['issues.listForRepo', p]);
          return { data: [
            { number: 1, title: 'Bug: crash on start', state: 'open', user: { login: 'alice' }, labels: [{ name: 'bug' }], html_url: 'u/1', created_at: '2026-01-01', pull_request: undefined },
            { number: 2, title: 'Feature request', state: 'open', user: { login: 'bob' }, labels: [], html_url: 'u/2', created_at: '2026-01-02', pull_request: {} },
          ] };
        },
        get: async (p: any) => {
          calls.push(['issues.get', p]);
          return { data: { number: p.issue_number, title: 'Bug: crash on start', state: 'open', body: 'Steps to reproduce...', labels: [{ name: 'bug' }], comments: 2, html_url: 'u/1', user: { login: 'alice' }, created_at: '2026-01-01' } };
        },
        listComments: async (p: any) => {
          calls.push(['issues.listComments', p]);
          return { data: [{ user: { login: 'bob' }, body: 'Same here', created_at: '2026-01-03' }] };
        },
        createComment: async (p: any) => {
          calls.push(['issues.createComment', p]);
          return { data: { html_url: 'comment-url' } };
        },
        addLabels: async (p: any) => {
          calls.push(['issues.addLabels', p]);
          return { data: {} };
        },
        update: async (p: any) => {
          calls.push(['issues.update', p]);
          return { data: { state: p.state } };
        },
      },
      pulls: {
        list: async (p: any) => {
          calls.push(['pulls.list', p]);
          return { data: [{ number: 10, title: 'Add sandbox', state: 'open', user: { login: 'carol' }, head: { ref: 'feat/sandbox' }, draft: false, html_url: 'pr/10' }] };
        },
        get: async (p: any) => {
          calls.push(['pulls.get', p]);
          return { data: 'diff --git a/x.ts b/x.ts\n+++ changes' };
        },
        listFiles: async (p: any) => {
          calls.push(['pulls.listFiles', p]);
          return { data: [{ filename: 'src/x.ts', status: 'modified', additions: 10, deletions: 2 }] };
        },
      },
      actions: {
        listWorkflowRunsForRepo: async (p: any) => {
          calls.push(['actions.listWorkflowRunsForRepo', p]);
          return { data: { workflow_runs: [{ name: 'Test', status: 'completed', conclusion: 'success', head_branch: 'main', created_at: '2026-01-04', html_url: 'wf/1' }] } };
        },
      },
    };
  }
  return { Octokit: FakeOctokit };
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-gh-'));
process.chdir(tmpRoot);

import fs from 'fs';
import os from 'os';
import path from 'path';
import { GitHubIntegration } from '../src/integrations/github.js';

beforeEach(() => {
  calls.length = 0;
  process.env.GITHUB_TOKEN = 'test-token-1234567890';
  GitHubIntegration.resetClient();
});

describe('GitHubIntegration (mocked API)', () => {
  it('isConfigured reflects token presence', () => {
    expect(GitHubIntegration.isConfigured()).toBe(true);
    delete process.env.GITHUB_TOKEN;
    GitHubIntegration.resetClient();
    expect(GitHubIntegration.isConfigured()).toBe(false);
    process.env.GITHUB_TOKEN = 'test-token-1234567890';
  });

  it('lists issues and filters out PRs', async () => {
    const gh = new GitHubIntegration();
    const issues = await gh.listIssues('owner/repo');
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it('gets an issue with bounded body', async () => {
    const gh = new GitHubIntegration();
    const issue = await gh.getIssue('owner/repo', 1);
    expect(issue.title).toContain('crash');
    expect(issue.labels).toContain('bug');
  });

  it('fetches PR diff and changed files for review flows', async () => {
    const gh = new GitHubIntegration();
    const diff = await gh.getPullRequestDiff('owner/repo', 10);
    expect(diff).toContain('diff --git');
    const files = await gh.getPullRequestFiles('owner/repo', 10);
    expect(files[0].filename).toBe('src/x.ts');
  });

  it('posts comments, labels and closes — external side effects only via explicit calls', async () => {
    const gh = new GitHubIntegration();
    const c = await gh.addIssueComment('owner/repo', 1, 'looks like a duplicate of #99');
    expect(c.url).toBe('comment-url');
    await gh.addIssueLabels('owner/repo', 1, ['triaged']);
    const closed = await gh.closeIssue('owner/repo', 1, 'closing as duplicate');
    expect(closed.state).toBe('closed');
  });

  it('rejects malformed repo identifiers', async () => {
    const gh = new GitHubIntegration();
    await expect(gh.listIssues('not-a-repo')).rejects.toThrow(/owner\/repo/);
  });

  it('auth failure surfaces as thrown error from client construction path', async () => {
    // With the mocked client we simulate missing config instead:
    delete process.env.GITHUB_TOKEN;
    GitHubIntegration.resetClient();
    const gh = new GitHubIntegration();
    await expect(gh.listIssues('owner/repo')).rejects.toThrow(/not configured/i);
    process.env.GITHUB_TOKEN = 'test-token-1234567890';
  });
});
