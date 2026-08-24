import { Octokit } from '@octokit/rest';
import { Config } from '../config.js';

/**
 * Real GitHub integration (Phase 34). Replaces the `gh` CLI shell-out stub.
 *
 * Auth: a personal access token from GITHUB_TOKEN (env) or Config keys.
 * Safety model:
 *   - Reads  (list/get/search) run freely once authenticated.
 *   - Writes (comments, labels, close, review submission) are marked as
 *     external side effects and must pass the Security/Policy gate in
 *     ToolExecutor before reaching this module.
 *   - Merging PRs is intentionally NOT exposed.
 */
export class GitHubIntegration {
    private static client: Octokit | null = null;

    public static isConfigured(): boolean {
        return !!this.getToken();
    }

    private static getToken(): string | undefined {
        return process.env.GITHUB_TOKEN || Config.get().keys?.github;
    }

    private static getClient(): Octokit {
        if (!this.client) {
            const token = this.getToken();
            if (!token) throw new Error('GitHub not configured: set GITHUB_TOKEN');
            this.client = new Octokit({ auth: token });
        }
        return this.client;
    }

    static resetClient(): void {
        this.client = null;
    }

    /** Parse 'owner/repo#123' or bare issue numbers. */
    private static splitRepo(repo: string): { owner: string; repo: string } {
        const [owner, name] = repo.split('/');
        if (!owner || !name) throw new Error(`Expected "owner/repo", received "${repo}"`);
        return { owner, repo: name };
    }

    // ── Reads ────────────────────────────────────────────────────────────

    async listIssues(repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 10) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.issues.listForRepo({
            owner, repo: name, state, per_page: Math.min(limit, 50),
        });
        return data.filter(i => !i.pull_request).map(i => ({
            number: i.number, title: i.title, state: i.state,
            author: i.user?.login, labels: i.labels.map((l: any) => l.name),
            url: i.html_url, created_at: i.created_at,
        }));
    }

    async getIssue(repo: string, issueNumber: number) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.issues.get({
            owner, repo: name, issue_number: issueNumber,
        });
        return {
            number: data.number, title: data.title, state: data.state,
            body: data.body?.slice(0, 4000), labels: (data.labels as any[]).map(l => l.name),
            comments: data.comments, url: data.html_url,
        };
    }

    async getIssueComments(repo: string, issueNumber: number, limit = 10) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.issues.listComments({
            owner, repo: name, issue_number: issueNumber, per_page: Math.min(limit, 50),
        });
        return data.map(c => ({ author: c.user?.login, body: c.body?.slice(0, 1000), created_at: c.created_at }));
    }

    async listPullRequests(repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 10) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.pulls.list({
            owner, repo: name, state, per_page: Math.min(limit, 50),
        });
        return data.map(p => ({
            number: p.number, title: p.title, state: p.state,
            author: p.user?.login, branch: p.head.ref,
            draft: p.draft, url: p.html_url,
        }));
    }

    /** Fetch unified diff for a PR — the raw material for agent review. */
    async getPullRequestDiff(repo: string, pullNumber: number) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const response = await GitHubIntegration.getClient().rest.pulls.get({
            owner, repo: name, pull_number: pullNumber, mediaType: { format: 'diff' },
        });
        const diff = String(response.data as unknown);
        return diff.slice(0, 20_000); // bound context injection
    }

    async getPullRequestFiles(repo: string, pullNumber: number) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.pulls.listFiles({
            owner, repo: name, pull_number: pullNumber, per_page: 30,
        });
        return data.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
    }

    async listWorkflowRuns(repo: string, limit = 5) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.actions.listWorkflowRunsForRepo({
            owner, repo: name, per_page: Math.min(limit, 20),
        });
        return data.workflow_runs.map(r => ({
            name: r.name, status: r.status, conclusion: r.conclusion,
            branch: r.head_branch, created_at: r.created_at, url: r.html_url,
        }));
    }

    // ── External side effects (policy-gated upstream) ───────────────────

    async addIssueComment(repo: string, issueNumber: number, body: string) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.issues.createComment({
            owner, repo: name, issue_number: issueNumber, body,
        });
        return { url: data.html_url };
    }

    async addIssueLabels(repo: string, issueNumber: number, labels: string[]) {
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        await GitHubIntegration.getClient().rest.issues.addLabels({
            owner, repo: name, issue_number: issueNumber, labels,
        });
        return { ok: true };
    }

    async closeIssue(repo: string, issueNumber: number, comment?: string) {
        if (comment) await this.addIssueComment(repo, issueNumber, comment);
        const { owner, repo: name } = GitHubIntegration.splitRepo(repo);
        const { data } = await GitHubIntegration.getClient().rest.issues.update({
            owner, repo: name, issue_number: issueNumber, state: 'closed',
        });
        return { state: data.state };
    }
}
