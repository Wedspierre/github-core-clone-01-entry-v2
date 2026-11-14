// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) at /mcp.
// Modern era first: server/discover answers supportedVersions incl. 2026-07-28;
// the legacy initialize handshake is also answered for older clients.
// Tools act on the same store as REST, so ids read back identically.

import {
  VIEWER_LOGIN,
  branchTip,
  createRepo,
  getRepo,
  nextSeq,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { mergePullRequest as restMerge } from './rest.ts';

export const MCP_VERSION = '2026-07-28';
export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repo name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function resolveRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repoName === '') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(owner, repoName) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = (canonical: string): boolean => norm === canonical || norm.endsWith(canonical);
  if (match('createrepo')) {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return toolError('name is required');
    if (getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError('Repository already exists');
    const repo = createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolResult(repoJson(repo));
  }
  if (match('getrepo')) {
    const repo = resolveRepo(args);
    if (repo === null) return toolError('Repository not found');
    return toolResult(repoJson(repo));
  }
  if (match('createissue')) {
    const repo = resolveRepo(args);
    if (repo === null) return toolError('Repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') return toolError('title is required');
    repo.numberSeq += 1;
    const issue: Issue = {
      id: repo.id * 100000 + repo.numberSeq,
      number: repo.numberSeq,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdSeq: nextSeq(),
    };
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue));
  }
  if (match('listissues')) {
    const repo = resolveRepo(args);
    if (repo === null) return toolError('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    const items = list.map((i) => issueJson(repo, i));
    return toolResult({ issues: items });
  }
  if (match('createpullrequest')) {
    const repo = resolveRepo(args);
    if (repo === null) return toolError('Repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    if (title === '' || head === '') return toolError('title and head are required');
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === null || baseSha === null) return toolError('head or base branch does not exist');
    repo.numberSeq += 1;
    const pr: PullRequest = {
      id: repo.id * 100000 + repo.numberSeq,
      number: repo.numberSeq,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: nextSeq(),
    };
    repo.pulls.push(pr);
    const out = pullJson(repo, pr) as Record<string, unknown>;
    out.pull_number = pr.number;
    return toolResult(out);
  }
  if (match('mergepullrequest')) {
    const repo = resolveRepo(args);
    if (repo === null) return toolError('Repository not found');
    const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    if (!Number.isInteger(num) || num < 1) return toolError('pull_number is required');
    const pr = repo.pulls.find((p) => p.number === num);
    if (pr === undefined) return toolError('Pull request not found');
    const merged = restMerge(repo, pr);
    if (!merged.ok) return toolError(merged.message ?? 'merge failed');
    return toolResult({ sha: merged.sha, merged: true, message: merged.message, number: pr.number, pull_number: pr.number });
  }
  return toolError(`unknown tool ${name}`);
}

export interface McpOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Best-effort extraction of a numeric/string id from a malformed JSON-RPC body. */
function extractId(raw: string): unknown {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (m === null) return null;
  const token = m[1] as string;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as unknown;
    } catch {
      return null;
    }
  }
  return Number(token);
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request bytes (needed for the
 * parse-error check, which must echo a -32700 with HTTP 400).
 */
export function handleMcp(rawBody: Buffer): McpOutcome {
  const raw = rawBody.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { status: 400, body: rpcError(extractId(raw), -32700, 'Parse error') };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = body as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC reply.
  if (id === null && method !== '') {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [MCP_VERSION, '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
      const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const negotiated = known.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => {
        const norm = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const canon = t.name.replace(/[^a-z0-9]/g, '');
        return norm === canon || norm.endsWith(canon);
      });
      if (!known) {
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${toolName}`) };
      }
      const result = callTool(toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
