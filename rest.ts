// GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests. Everything reads the same store the git protocol
// writes, so a push over smart HTTP is visible to REST at once and vice versa.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  isOid,
  parseCommit,
  parseTree,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  /** Exact bytes to send (already JSON unless `raw` is set). */
  body: Buffer | null;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, value: unknown, extra?: Record<string, string>): RestReply {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8'), headers: extra };
}

export function messageReply(status: number, message: string): RestReply {
  return jsonReply(status, { message });
}

/** An opaque Relay-style global id: base64 of `<kind>:<key>`. Never the bare number. */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.nowIso,
    updated_at: store.nowIso,
    pushed_at: store.nowIso,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('I', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: '' })),
    user: userJson(),
    created_at: store.nowIso,
    updated_at: store.nowIso,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: repo.comments.get(issue.number)?.length ?? 0,
  };
}

/** The cached response bytes for one issue (rebuilt when the issue changes). */
export function issueBytes(store: Store, repo: Repo, issue: Issue): Buffer {
  if (issue.cache) return issue.cache;
  issue.cache = Buffer.from(JSON.stringify(issueJson(store, repo, issue)), 'utf8');
  return issue.cache;
}

export function prJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: gid('P', `${repo.owner}/${repo.name}/${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    mergeable: !store.prConflicts(repo, pr),
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: `${repo.owner}:${pr.headRef}`,
      user: userJson(),
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: `${repo.owner}:${pr.baseRef}`,
      user: userJson(),
    },
    user: userJson(),
    created_at: store.nowIso,
    updated_at: store.nowIso,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const stamp = store.nowIso;
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: stamp },
      committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: stamp },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    author: userJson(),
    committer: userJson(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/** Slice a list into one page and build GitHub's Link header (absolute URLs). */
function paginate<T>(items: readonly T[], query: URLSearchParams, base: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageOf(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1 && items.length <= perPage) return { page: slice, link: null };
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${base}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return { page: slice, link: links.join(', ') };
}

/** Resolve a ref name (branch) or raw commit id to a commit id. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    return object && object.type === 'commit' ? ref : null;
  }
  return null;
}

/** The tree id of a commit, or null. */
function treeOf(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Look a path up in a tree: a blob entry, a subtree, or nothing. */
function lookupPath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: current };
}

/** Commit one file change on a branch: returns the new commit id. */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  // Copy: treeMap returns a cached map shared with other readers; mutating
  // it would rewrite the old tree's view for every later diff.
  const map = tip === undefined ? new Map() : new Map(store.treeMap(repo, treeOf(repo, tip) ?? ''));
  if (content === null) map.delete(path);
  else {
    const blob = store.putObject(repo, 'blob', content);
    map.set(path, { mode: '100644', oid: blob });
  }
  const tree = store.buildTreeFromMap(repo, map);
  const sha = store.makeCommit(repo, tree, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  store.touch(repo);
  return sha;
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the path parts after `/api/v3`
 * (already split, still percent-encoded pieces decoded by the caller).
 * `host` is the request's Host header, for absolute pagination URLs.
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  bodyText: string,
  host: string,
): RestReply {
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    try {
      body = parseBody(bodyText);
    } catch {
      return messageReply(400, 'Problems parsing JSON');
    }
  }
  const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const input = record(body);

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  const [first] = segments;

  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, { installed_version: '3.0.0', verifiable_password_authentication: true });
  }

  if (first === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return messageReply(404, 'Not Found');
      return jsonReply(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const base = `http://${host}/api/v3/user/repos`;
        const { page, link } = paginate(store.listRepos(), query, base);
        return jsonReply(200, page.map((repo) => repoJson(store, repo)), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '' || name.includes('/')) return messageReply(422, 'Validation Failed: name is required');
        const repo = store.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
        if (repo === null) return messageReply(422, 'Repository already exists');
        return jsonReply(201, repoJson(store, repo));
      }
    }
    return messageReply(404, 'Not Found');
  }

  if (first !== 'repos' || segments.length < 3) return messageReply(404, 'Not Found');
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = store.getRepo(owner, repoName);
  const rest = segments.slice(3);

  // GET / PATCH / DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (repo === undefined) return messageReply(404, 'Not Found');
    if (method === 'GET') return jsonReply(200, repoJson(store, repo));
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      return jsonReply(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return messageReply(404, 'Not Found');
  }

  if (repo === undefined) return messageReply(404, 'Not Found');
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? ZERO_OID, url: `${repoPath}/commits/${repo.refs.get(`refs/heads/${name}`) ?? ZERO_OID}` },
          protected: false,
        }));
      return jsonReply(200, branches);
    }
    if (rest.length > 1 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return messageReply(404, 'Not Found');
      return jsonReply(200, { name: branch, commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false });
    }
    return messageReply(404, 'Not Found');
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha') ?? undefined);
    if (tip === null) return jsonReply(200, []);
    const commits = store
      .commitsFrom(repo, tip)
      .map((oid) => commitJson(store, repo, oid))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return jsonReply(200, commits);
  }

  // Git refs (create a branch; read one branch).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) return messageReply(422, 'Validation Failed');
      const object = repo.objects.get(sha);
      if (!object) return messageReply(422, 'Validation Failed: unknown object');
      repo.refs.set(ref, sha);
      store.touch(repo);
      return jsonReply(201, { ref, object: { sha, type: object.type, url: `${repoPath}/git/${object.type}s/${sha}` } });
    }
    if (method === 'GET' && rest.length > 3 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return messageReply(404, 'Not Found');
      return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `${repoPath}/git/commits/${sha}` } });
    }
    return messageReply(404, 'Not Found');
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, query.get('ref') ?? undefined);
      if (tip === null || path === '') return messageReply(404, 'Not Found');
      const tree = treeOf(repo, tip);
      if (tree === null) return messageReply(404, 'Not Found');
      const found = lookupPath(repo, tree, path);
      if (found === null) return messageReply(404, 'Not Found');
      if (found.kind === 'dir') {
        const object = repo.objects.get(found.oid);
        if (!object) return messageReply(404, 'Not Found');
        const entries = parseTree(object.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
          url: `${repoPath}/contents/${path}/${entry.name}`,
        }));
        return jsonReply(200, entries);
      }
      const blob = repo.objects.get(found.oid);
      if (!blob) return messageReply(404, 'Not Found');
      return jsonReply(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: found.oid,
        url: `${repoPath}/contents/${path}`,
        html_url: `/${owner}/${repoName}/blob/${repo.defaultBranch}/${path}`,
        download_url: null,
      });
    }
    if (method === 'PUT') {
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      if (!repo.refs.has(`refs/heads/${branch}`)) {
        const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (base !== undefined) repo.refs.set(`refs/heads/${branch}`, base);
      }
      const content = typeof input.content === 'string' ? Buffer.from(input.content.replace(/[\r\n\t ]+/g, ''), 'base64') : Buffer.alloc(0);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const isUpdate = tip !== undefined && lookupPath(repo, treeOf(repo, tip) ?? '', path)?.kind === 'file';
      if (isUpdate) {
        const current = lookupPath(repo, treeOf(repo, tip!) ?? '', path);
        if (typeof input.sha === 'string' && current !== null && current.kind === 'file' && input.sha.toLowerCase() !== current.oid.toLowerCase()) {
          return messageReply(409, 'Conflict: sha does not match');
        }
      }
      const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
      const sha = commitFile(store, repo, branch, path, content, message);
      const blobOid = store.putObject(repo, 'blob', content);
      const created = !isUpdate;
      return jsonReply(created ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64', url: `${repoPath}/contents/${path}` },
        commit: { sha, message, author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: store.nowIso }, committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: store.nowIso }, url: `${repoPath}/commits/${sha}` },
      });
    }
    if (method === 'DELETE') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return messageReply(404, 'Not Found');
      const found = lookupPath(repo, treeOf(repo, tip) ?? '', path);
      if (found === null || found.kind !== 'file') return messageReply(404, 'Not Found');
      const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
      const sha = commitFile(store, repo, repo.defaultBranch, path, null, message);
      return jsonReply(200, { commit: { sha, message } });
    }
    return messageReply(404, 'Not Found');
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method !== 'POST') return messageReply(404, 'Not Found');
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') return messageReply(422, 'Validation Failed: name is required');
    const color = typeof input.color === 'string' ? input.color : 'ededed';
    repo.labels.set(name, { name, color });
    return jsonReply(201, { name, color, description: '' });
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const base = `http://${host}${repoPath}/issues`;
        const { page, link } = paginate(list, query, base);
        return jsonReply(200, page.map((issue) => issueJson(store, repo, issue)), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        const bodyText = typeof input.body === 'string' ? input.body : '';
        const wanted = Array.isArray(input.labels) ? (input.labels as unknown[]).map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>).name)).filter((label): label is string => typeof label === 'string') : [];
        const labels: { name: string; color: string }[] = [];
        for (const name of wanted) {
          const found = repo.labels.get(name);
          if (!found) return messageReply(422, `Validation Failed: label "${name}" does not exist`);
          labels.push(found);
        }
        const issue = store.createIssue(repo, title, bodyText, labels);
        return jsonReply(201, issueJson(store, repo, issue));
      }
      return messageReply(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return messageReply(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issueBytes(store, repo, issue) };
      if (method === 'PATCH') {
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        issue.cache = null;
        return jsonReply(200, issueJson(store, repo, issue));
      }
      return messageReply(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return messageReply(404, 'Not Found');
      if (method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        return jsonReply(200, comments.map((comment) => ({ id: comment.id, body: comment.body, user: userJson(), created_at: store.nowIso, updated_at: store.nowIso, url: `${repoPath}/issues/${number}/comments/${comment.id}` })));
      }
      if (method === 'POST') {
        const commentBody = typeof input.body === 'string' ? input.body : '';
        const comment = { id: store.nextId(), body: commentBody, seq: store.nextSeq() };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return jsonReply(201, { id: comment.id, body: comment.body, user: userJson(), created_at: store.nowIso, updated_at: store.nowIso, url: `${repoPath}/issues/${number}/comments/${comment.id}` });
      }
    }
    return messageReply(404, 'Not Found');
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.prs.values()];
        if (state !== 'all') list = list.filter((pr) => pr.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const base = `http://${host}${repoPath}/pulls`;
        const { page, link } = paginate(list, query, base);
        return jsonReply(200, page.map((pr) => prJson(store, repo, pr)), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        const bodyText = typeof input.body === 'string' ? input.body : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
        if (head === '' || repo.refs.get(`refs/heads/${head}`) === undefined) return messageReply(422, 'Validation Failed: head branch not found');
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return messageReply(422, 'Validation Failed: base branch not found');
        const pr = store.createPull(repo, title, bodyText, head, base);
        if (pr === null) return messageReply(422, 'Validation Failed');
        return jsonReply(201, prJson(store, repo, pr));
      }
      return messageReply(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    const pr = repo.prs.get(number);
    if (rest.length === 2) {
      if (pr === undefined) return messageReply(404, 'Not Found');
      if (method === 'GET') return jsonReply(200, prJson(store, repo, pr));
      return messageReply(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pr === undefined) return messageReply(404, 'Not Found');
      return jsonReply(200, store.prFiles(repo, pr));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pr === undefined) return messageReply(404, 'Not Found');
      if (pr.merged && pr.mergeSha !== null) {
        return jsonReply(200, { sha: pr.mergeSha, merged: true, message: 'Pull request successfully merged' });
      }
      const sha = store.mergePull(repo, pr);
      if (sha === null) return messageReply(405, 'Merge conflict');
      return jsonReply(200, { sha, merged: true, message: 'Pull request successfully merged' });
    }
    return messageReply(404, 'Not Found');
  }

  return messageReply(404, 'Not Found');
}
