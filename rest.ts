// rest.ts — GitHub REST v3 surface under /api/v3.
// Every reply is JSON with X-GitHub-Request-Id (added by app.ts); errors carry {message}.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  branchTip,
  commitFile,
  commitHistory,
  createRepo,
  deleteRepo,
  diffTrees,
  getObject,
  getRepo,
  isAncestor,
  nextSeq,
  parseCommit,
  parseTree,
  repos,
  stampEpoch,
  stampIso,
  storeObject,
  buildCommit,
  treeGet,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestCtx {
  method: string;
  /** Path segments after /api/v3, already URI-decoded per segment. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** When true, no body is written at all (204). */
  noBody?: boolean;
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bodyStr(body: unknown, field: string, fallback = ''): string {
  if (!isRecord(body)) return fallback;
  const v = body[field];
  return typeof v === 'string' ? v : fallback;
}

function bodyBool(body: unknown, field: string, fallback = false): boolean {
  if (!isRecord(body)) return fallback;
  const v = body[field];
  return typeof v === 'boolean' ? v : fallback;
}

export function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: 'https://example.invalid/avatar.png',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const created = stampIso(repo.createdSeq);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: viewerJson(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: created,
    updated_at: created,
    pushed_at: created,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { id: 0, node_id: `L_${label.name}`, name: label.name, color: label.color, description: null, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const created = stampIso(issue.createdSeq);
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l !== undefined ? labelJson(l) : { name, color: 'ededed', description: null, default: false };
    }),
    user: viewerJson(),
    created_at: created,
    updated_at: created,
    closed_at: issue.state === 'closed' ? created : null,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number * 1000 + comment.id,
    node_id: `C_${repo.id}_${issue.number}_${comment.id}`,
    body: comment.body,
    user: viewerJson(),
    created_at: stampIso(comment.createdSeq),
    updated_at: stampIso(comment.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const created = stampIso(pr.createdSeq);
  return {
    id: repo.id * 100000 + pr.number,
    node_id: `PR_${repo.id}_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: viewerJson(),
    created_at: created,
    updated_at: created,
    closed_at: pr.state === 'closed' ? pr.mergedAt ?? created : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function parsePagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function pageOf<T>(items: readonly T[], perPage: number, page: number): { slice: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { slice, hasNext: start + perPage < items.length };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, perPage: number, page: number): string {
  const q = new URLSearchParams(query);
  q.set('per_page', String(perPage));
  q.set('page', String(page + 1));
  return `<${baseUrl}${path}?${q.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// /user/*
// ---------------------------------------------------------------------------

function handleUser(ctx: RestCtx): RestResult | null {
  const [seg, ...rest] = ctx.segments;
  if (seg !== 'user') return null;
  if (rest.length === 0) {
    if (ctx.method !== 'GET') return err(404, 'Not Found');
    return ok(200, viewerJson());
  }
  if (rest[0] === 'repos' && rest.length === 1) {
    if (ctx.method === 'GET') {
      const { perPage, page } = parsePagination(ctx.query);
      const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { slice, hasNext } = pageOf(all, perPage, page);
      const headers: Record<string, string> = {};
      if (hasNext) headers.link = linkHeader(ctx.baseUrl, '/api/v3/user/repos', ctx.query, perPage, page);
      return ok(200, slice.map(repoJson), headers);
    }
    if (ctx.method === 'POST') {
      const name = bodyStr(ctx.body, 'name');
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'invalid repository name');
      if (getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = createRepo(name, bodyBool(ctx.body, 'private', false), bodyStr(ctx.body, 'description'));
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }
  return null;
}

// ---------------------------------------------------------------------------
// /repos/{owner}/{repo}/*
// ---------------------------------------------------------------------------

function resolveRepo(ctx: RestCtx): { repo: Repo } | RestResult {
  const owner = ctx.segments[1] as string;
  const name = ctx.segments[2] as string;
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return { repo };
}

function repoTreeAt(repo: Repo, ref: string | null): { tree: string; tip: string } | null {
  const branch = ref ?? repo.defaultBranch;
  const tip = branchTip(repo, branch) ?? (getObject(branch) !== undefined && getObject(branch)?.type === 'commit' ? branch : null);
  if (tip === null) return null;
  const obj = getObject(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  return { tree: parseCommit(obj.data).tree, tip };
}

function contentsEntry(repo: Repo, path: string, entry: { mode: string; name: string; oid: string }, ref: string | null): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const base = {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}${ref !== null ? `?ref=${encodeURIComponent(ref)}` : ''}`,
  };
  if (isDir) return base;
  const obj = getObject(entry.oid);
  return { ...base, size: obj?.data.length ?? 0, encoding: 'base64', content: obj !== undefined ? obj.data.toString('base64') : '' };
}

function handleContents(ctx: RestCtx, repo: Repo, pathParts: string[]): RestResult {
  const path = pathParts.join('/');
  const ref = ctx.query.get('ref');
  if (ctx.method === 'GET') {
    const at = repoTreeAt(repo, ref);
    if (at === null) return err(404, 'Not Found');
    if (path === '') {
      const obj = getObject(at.tree);
      if (obj === undefined) return err(404, 'Not Found');
      return ok(200, parseTree(obj.data).map((e) => contentsEntry(repo, e.name, e, ref)));
    }
    // File or directory?
    const found = treeGet(at.tree, path);
    if (found !== null && found.mode !== '40000') {
      const obj = getObject(found.oid);
      if (obj === undefined) return err(404, 'Not Found');
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: obj.data.toString('base64'),
        sha: found.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    // Directory: walk to the subtree.
    const parts = path.split('/').filter((p) => p !== '');
    let cur = at.tree;
    for (const part of parts) {
      const obj = getObject(cur);
      if (obj === undefined || obj.type !== 'tree') return err(404, 'Not Found');
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (entry === undefined) return err(404, 'Not Found');
      cur = entry.oid;
    }
    const obj = getObject(cur);
    if (obj === undefined || obj.type !== 'tree') return err(404, 'Not Found');
    return ok(200, parseTree(obj.data).map((e) => contentsEntry(repo, `${path}/${e.name}`, e, ref)));
  }
  if (ctx.method === 'PUT') {
    if (!isRecord(ctx.body)) return err(400, 'Invalid JSON body');
    const message = bodyStr(ctx.body, 'message', 'Update file');
    const contentB64 = bodyStr(ctx.body, 'content');
    if (contentB64 === '') return err(422, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
      if (content.toString('base64').replace(/=+$/, '') !== contentB64.replace(/[\r\n\s]/g, '').replace(/=+$/, '')) {
        // Tolerate whitespace/newlines; only reject outright garbage.
        if (!/^[A-Za-z0-9+/=\r\n\s]*$/.test(contentB64)) return err(422, 'content is not valid base64');
      }
    } catch {
      return err(422, 'content is not valid base64');
    }
    const branch = bodyStr(ctx.body, 'branch', repo.defaultBranch);
    const tip = branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) return err(422, 'branch does not exist');
    const at = repoTreeAt(repo, branch);
    const existing = at === null ? null : treeGet(at.tree, path);
    const sha = bodyStr(ctx.body, 'sha');
    if (existing !== null) {
      if (sha === '') return err(422, 'sha is required to update a file');
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current blob');
      const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
      return ok(200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      });
    }
    const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
    return ok(201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
  }
  if (ctx.method === 'DELETE') {
    if (!isRecord(ctx.body)) return err(400, 'Invalid JSON body');
    const message = bodyStr(ctx.body, 'message', 'Delete file');
    const branch = bodyStr(ctx.body, 'branch', repo.defaultBranch);
    const at = repoTreeAt(repo, branch);
    if (at === null) return err(404, 'Not Found');
    const existing = treeGet(at.tree, path);
    if (existing === null) return err(404, 'Not Found');
    const sha = bodyStr(ctx.body, 'sha');
    if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current blob');
    const { commitSha } = commitFile(repo, branch, path, null, message);
    return ok(200, { commit: { sha: commitSha, message } });
  }
  return err(404, 'Not Found');
}

function prFiles(repo: Repo, pr: PullRequest): Array<Record<string, unknown>> {
  const headObj = getObject(pr.headSha);
  const baseObj = getObject(pr.baseSha);
  if (headObj === undefined || baseObj === undefined) return [];
  const headTree = headObj.type === 'commit' ? parseCommit(headObj.data).tree : null;
  const baseTree = baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : null;
  if (headTree === null || baseTree === null) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const d of diffTrees(baseTree, headTree)) {
    const countLines = (oid: string | null): number => {
      if (oid === null) return 0;
      const o = getObject(oid);
      if (o === undefined) return 0;
      const text = o.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const additions = d.status === 'deleted' ? 0 : countLines(d.newOid);
    const deletions = d.status === 'added' ? 0 : countLines(d.oldOid);
    out.push({
      filename: d.path,
      status: d.status === 'added' ? 'added' : d.status === 'deleted' ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: d.newOid ?? d.oldOid ?? '',
    });
  }
  return out;
}

/** Three-way conflict test: file changed in the PR vs its base AND changed on base since. */
export function prConflicts(repo: Repo, pr: PullRequest): boolean {
  const headObj = getObject(pr.headSha);
  const baseObj = getObject(pr.baseSha);
  const tipSha = branchTip(repo, pr.baseRef);
  if (headObj === undefined || baseObj === undefined || tipSha === null) return false;
  if (tipSha === pr.baseSha) return false;
  const tipObj = getObject(tipSha);
  if (tipObj === undefined || tipObj.type !== 'commit') return false;
  const headTree = parseCommit(headObj.data).tree;
  const baseTree = parseCommit(baseObj.data).tree;
  const tipTree = parseCommit(tipObj.data).tree;
  for (const d of diffTrees(baseTree, headTree)) {
    const baseBlob = treeGet(baseTree, d.path);
    const headBlob = treeGet(headTree, d.path);
    const tipBlob = treeGet(tipTree, d.path);
    const baseOid = baseBlob?.oid ?? null;
    const headOid = headBlob?.oid ?? null;
    const tipOid = tipBlob?.oid ?? null;
    if (tipOid !== baseOid && headOid !== baseOid && tipOid !== headOid) return true;
  }
  return false;
}

export function mergePullRequest(repo: Repo, pr: PullRequest): { ok: boolean; status: number; sha?: string; message?: string } {
  if (pr.state !== 'open' || pr.merged) return { ok: false, status: 405, message: 'Pull request is already merged or closed' };
  if (prConflicts(repo, pr)) return { ok: false, status: 405, message: 'Merge conflict' };
  const seq = nextSeq();
  const tipSha = branchTip(repo, pr.baseRef);
  if (tipSha === null) return { ok: false, status: 405, message: 'Base branch has no commits' };
  const headObj = getObject(pr.headSha);
  if (headObj === undefined || headObj.type !== 'commit') return { ok: false, status: 405, message: 'Head commit not found' };
  const headTree = parseCommit(headObj.data).tree;
  const epoch = stampEpoch(seq);
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}\n`;
  const mergeSha = storeObject('commit', buildCommit(headTree, [tipSha], ident, ident, message));
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = stampIso(seq);
  pr.mergeCommitSha = mergeSha;
  return { ok: true, status: 200, sha: mergeSha, message: 'Pull request successfully merged.' };
}

// ---------------------------------------------------------------------------
// /repos/{owner}/{repo} router
// ---------------------------------------------------------------------------

function handleRepo(ctx: RestCtx): RestResult | null {
  const [seg, owner, name, ...rest] = ctx.segments;
  if (seg !== 'repos' || owner === undefined || name === undefined) return null;
  const resolved = resolveRepo(ctx);
  if (!('repo' in resolved)) return resolved;
  const repo = resolved.repo;

  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (ctx.method === 'GET') return ok(200, repoJson(repo));
    if (ctx.method === 'PATCH') {
      if (isRecord(ctx.body)) {
        if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
        if (typeof ctx.body.private === 'boolean') repo.private = ctx.body.private;
      }
      return ok(200, repoJson(repo));
    }
    if (ctx.method === 'DELETE') {
      deleteRepo(owner, name);
      return { status: 204, body: null, noBody: true };
    }
    return err(404, 'Not Found');
  }

  const [sub, ...tail] = rest as [string, ...string[]];

  if (sub === 'branches') {
    if (ctx.method === 'GET' && tail.length === 0) {
      const list = [...repo.refs.entries()]
        .filter(([n]) => n.startsWith('refs/heads/'))
        .sort()
        .map(([n, oid]) => ({ name: n.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      return ok(200, list);
    }
    if (ctx.method === 'GET' && tail.length === 1) {
      const branch = tail[0] as string;
      const tip = branchTip(repo, branch);
      if (tip === null) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (sub === 'commits') {
    if (ctx.method === 'GET' && tail.length === 0) {
      const ref = ctx.query.get('sha');
      const at = repoTreeAt(repo, ref);
      if (at === null) return ok(200, []);
      const { perPage } = parsePagination(ctx.query);
      const history = commitHistory(at.tip).slice(0, Math.max(perPage, 100));
      return ok(200, history.map((sha) => {
        const obj = getObject(sha);
        const info = obj !== undefined ? parseCommit(obj.data) : null;
        return {
          sha,
          commit: {
            message: (info?.message ?? '').replace(/\n+$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: stampIso(repo.createdSeq) },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: stampIso(repo.createdSeq) },
          },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID },
          committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
          parents: (info?.parents ?? []).map((p) => ({ sha: p })),
        };
      }));
    }
    return err(404, 'Not Found');
  }

  if (sub === 'contents') {
    return handleContents(ctx, repo, tail);
  }

  if (sub === 'labels') {
    if (ctx.method === 'GET' && tail.length === 0) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    if (ctx.method === 'POST' && tail.length === 0) {
      const labelName = bodyStr(ctx.body, 'name');
      if (labelName === '') return err(422, 'name is required');
      if (repo.labels.has(labelName)) return err(422, 'Label already exists');
      const color = bodyStr(ctx.body, 'color', 'ededed').replace(/^#/, '');
      const label = { name: labelName, color };
      repo.labels.set(labelName, label);
      return ok(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  if (sub === 'git') {
    // POST /git/refs — create a branch or tag ref.
    if (tail[0] === 'refs' && tail.length === 1) {
      if (ctx.method === 'POST') {
        const ref = bodyStr(ctx.body, 'ref');
        const sha = bodyStr(ctx.body, 'sha');
        if (!/^refs\/(heads|tags)\/.+/.test(ref)) return err(422, 'ref must start with refs/heads/ or refs/tags/');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const obj = getObject(sha);
        if (obj === undefined) return err(422, 'sha does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: `R_${repo.id}_${ref}`, object: { sha, type: obj.type, url: '' } });
      }
      if (ctx.method === 'GET') {
        const list = [...repo.refs.entries()].sort().map(([n, oid]) => ({ ref: n, object: { sha: oid } }));
        return ok(200, list);
      }
      return err(404, 'Not Found');
    }
    // GET /git/refs/heads/{branch} | /git/refs/tags/{tag}
    if (tail[0] === 'refs' && tail.length >= 3 && ctx.method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      const obj = getObject(oid);
      return ok(200, { ref, node_id: `R_${repo.id}_${ref}`, object: { sha: oid, type: obj?.type ?? 'commit', url: '' } });
    }
    return err(404, 'Not Found');
  }

  if (sub === 'issues') {
    // GET /issues (list)
    if (tail.length === 0 && ctx.method === 'GET') {
      const { perPage, page } = parsePagination(ctx.query);
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { slice } = pageOf(list, perPage, page);
      return ok(200, slice.map((i) => issueJson(repo, i)));
    }
    // POST /issues (create)
    if (tail.length === 0 && ctx.method === 'POST') {
      const title = bodyStr(ctx.body, 'title');
      if (title === '') return err(422, 'title is required');
      const body = bodyStr(ctx.body, 'body');
      const rawLabels = isRecord(ctx.body) ? ctx.body.labels : undefined;
      const labels: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const l of rawLabels) {
          const labelName = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
          if (labelName === '') continue;
          if (!repo.labels.has(labelName)) return err(422, `label ${JSON.stringify(labelName)} does not exist`);
          labels.push(labelName);
        }
      }
      repo.numberSeq += 1;
      const seq = nextSeq();
      const issue: Issue = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body,
        state: 'open',
        labels,
        comments: [],
        createdSeq: seq,
      };
      repo.issues.push(issue);
      return ok(201, issueJson(repo, issue));
    }
    // /issues/{number}
    const num = Number(tail[0]);
    if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
    const issue = repo.issues.find((i) => i.number === num);
    if (issue === undefined) return err(404, 'Not Found');
    if (tail.length === 1) {
      if (ctx.method === 'GET') return ok(200, issueJson(repo, issue));
      if (ctx.method === 'PATCH') {
        if (isRecord(ctx.body)) {
          if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
          if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
          if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
        }
        return ok(200, issueJson(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (tail[0] !== undefined && tail[1] === 'comments') {
      if (ctx.method === 'GET' && tail.length === 2) {
        return ok(200, issue.comments.map((c) => commentJson(repo, issue, c)));
      }
      if (ctx.method === 'POST' && tail.length === 2) {
        const commentBody = bodyStr(ctx.body, 'body');
        if (commentBody === '') return err(422, 'body is required');
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: commentBody, createdSeq: nextSeq() };
        issue.comments.push(comment);
        return ok(201, commentJson(repo, issue, comment));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (sub === 'pulls') {
    // GET /pulls (list)
    if (tail.length === 0 && ctx.method === 'GET') {
      const { perPage, page } = parsePagination(ctx.query);
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { slice } = pageOf(list, perPage, page);
      return ok(200, slice.map((p) => pullJson(repo, p)));
    }
    // POST /pulls (create)
    if (tail.length === 0 && ctx.method === 'POST') {
      const title = bodyStr(ctx.body, 'title');
      const head = bodyStr(ctx.body, 'head');
      const base = bodyStr(ctx.body, 'base', repo.defaultBranch);
      if (title === '' || head === '') return err(422, 'title and head are required');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
      repo.numberSeq += 1;
      const pr: PullRequest = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body: bodyStr(ctx.body, 'body'),
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
      return ok(201, pullJson(repo, pr));
    }
    const num = Number(tail[0]);
    if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
    const pr = repo.pulls.find((p) => p.number === num);
    if (pr === undefined) return err(404, 'Not Found');
    if (tail.length === 1) {
      if (ctx.method === 'GET') return ok(200, pullJson(repo, pr));
      return err(404, 'Not Found');
    }
    if (tail[1] === 'files' && tail.length === 2 && ctx.method === 'GET') {
      return ok(200, prFiles(repo, pr));
    }
    if (tail[1] === 'merge' && tail.length === 2 && ctx.method === 'PUT') {
      const merged = mergePullRequest(repo, pr);
      if (!merged.ok) return err(merged.status, merged.message ?? 'Merge failed');
      return ok(200, { sha: merged.sha as string, merged: true, message: merged.message as string });
    }
    return err(404, 'Not Found');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Route a request under /api/v3. Returns null when the path is not a REST route. */
export function routeRest(ctx: RestCtx): RestResult | null {
  if (ctx.segments.length === 0) {
    if (ctx.method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  const [first] = ctx.segments;
  if (first === 'meta') {
    if (ctx.method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  const user = handleUser(ctx);
  if (user !== null) return user;
  const repo = handleRepo(ctx);
  if (repo !== null) return repo;
  return err(404, 'Not Found');
}
