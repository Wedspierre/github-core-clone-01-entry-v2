// store.ts — in-memory state for the forge: repos, refs, git objects, issues, PRs.
// Everything deterministic: timestamps come from MAKEFUN_TRIAL_NOW (or a fixed epoch),
// never from the wall clock; ids come from counters, never from Math.random().

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen'; // scenario viewer, from wire.ts buildScenario() (fixed seed 6a09e667f3bcc909)
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

/** The trial's "now": MAKEFUN_TRIAL_NOW when the harness sets it, else the fixed epoch. */
export const TRIAL_NOW_MS: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : SCENARIO_EPOCH_SEC * 1000;
})();
export const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

/** The bearer token the suite presents; read from the process env like the env does. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let seqCounter = 0;
/** Next deterministic sequence number (1-based). */
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}
/** Deterministic ISO timestamp: trial now + seq seconds. */
export function stampIso(seq: number): string {
  return new Date(TRIAL_NOW_MS + seq * 1000).toISOString();
}
/** Deterministic commit epoch: trial now + seq seconds. */
export function stampEpoch(seq: number): number {
  return TRIAL_NOW_SEC + seq;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Content-addressed object store, shared across repos (objects are immutable). */
export const objects = new Map<string, GitObject>();

export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// Commit / tree parsing and building
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], authorLine: string, committerLine: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${authorLine}\ncommitter ${committerLine}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort order: entries sort by name, directories as if suffixed with '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** All objects reachable from `roots` (commits/tags/trees/blobs), following git reachability. */
export function reachableObjects(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1] as string);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following parent links. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Commits reachable from `tip`, newest-first by discovery order (parents after children). */
export function commitHistory(tip: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

/** Blob oid at `path` under tree `rootOid`, or null. */
export function treeGet(rootOid: string, path: string): { oid: string; mode: string } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let cur = rootOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    cur = entry.oid;
  }
  return null;
}

/** New tree oid with `path` set to `blobOid` (or deleted when null), creating parent trees. */
export function treeSet(rootOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  function rec(treeOid: string | null, depth: number): string {
    const entries: TreeEntry[] =
      treeOid === null ? [] : (() => {
        const obj = objects.get(treeOid);
        return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
      })();
    const name = parts[depth] as string;
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = idx >= 0 ? entries[idx]?.oid ?? null : null;
      const newChild = rec(childOid, depth + 1);
      if (idx >= 0) entries[idx] = { mode: '40000', name, oid: newChild };
      else entries.push({ mode: '40000', name, oid: newChild });
    }
    return storeObject('tree', buildTree(entries));
  }
  return rec(rootOid, 0);
}

export interface TreeDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
}

/** Recursive diff of two trees (null = empty tree). */
export function diffTrees(baseOid: string | null, headOid: string | null, prefix = ''): TreeDiff[] {
  const out: TreeDiff[] = [];
  const baseEntries: TreeEntry[] =
    baseOid === null ? [] : (() => {
      const o = objects.get(baseOid);
      return o !== undefined && o.type === 'tree' ? parseTree(o.data) : [];
    })();
  const headEntries: TreeEntry[] =
    headOid === null ? [] : (() => {
      const o = objects.get(headOid);
      return o !== undefined && o.type === 'tree' ? parseTree(o.data) : [];
    })();
  const baseByName = new Map(baseEntries.map((e) => [e.name, e]));
  const headByName = new Map(headEntries.map((e) => [e.name, e]));
  const names = new Set([...baseByName.keys(), ...headByName.keys()]);
  for (const name of [...names].sort()) {
    const b = baseByName.get(name);
    const h = headByName.get(name);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (b !== undefined && h === undefined) {
      if (b.mode === '40000') out.push(...diffTrees(b.oid, null, path));
      else out.push({ path, status: 'deleted', oldOid: b.oid, newOid: null });
    } else if (b === undefined && h !== undefined) {
      if (h.mode === '40000') out.push(...diffTrees(null, h.oid, path));
      else out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    } else if (b !== undefined && h !== undefined) {
      if (b.mode === '40000' && h.mode === '40000') {
        if (b.oid !== h.oid) out.push(...diffTrees(b.oid, h.oid, path));
      } else if (b.oid !== h.oid || b.mode !== h.mode) {
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forge state: repos, issues, pull requests
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: PullRequest[];
  /** Shared counter for issue + PR numbers (GitHub behaviour). */
  numberSeq: number;
  commentSeq: number;
}

export const repos = new Map<string, Repo>();
let nextRepoId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const seq = nextSeq();
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    createdSeq: seq,
    refs: new Map<string, string>(),
    labels: new Map<string, { name: string; color: string }>(),
    issues: [],
    pulls: [],
    numberSeq: 0,
    commentSeq: 0,
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

/** Head commit sha of a branch, or null when the branch has no commit. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a commit on `branch` that sets `path` to `content` (null deletes it). */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const seq = nextSeq();
  const parent = branchTip(repo, branch);
  let baseTree: string | null = null;
  if (parent !== null) {
    const obj = objects.get(parent);
    if (obj !== undefined && obj.type === 'commit') baseTree = parseCommit(obj.data).tree;
  }
  let blobSha: string | null = null;
  if (content !== null) blobSha = storeObject('blob', content);
  const newTree = treeSet(baseTree, path, blobSha);
  const epoch = stampEpoch(seq);
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  const parents = parent === null ? [] : [parent];
  const commitSha = storeObject('commit', buildCommit(newTree, parents, ident, ident, `${message}\n`));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** Opaque GraphQL global ids (never the plain numeric id). */
export function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}
export function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return `PR_${repo.id}_${pr.number}`;
}
export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return `C_${repo.id}_${issue.number}_${comment.id}`;
}

export function findRepoByGlobalId(id: string): Repo | undefined {
  const m = /^R_(\d+)$/.exec(id);
  if (m === null) return undefined;
  const num = Number(m[1]);
  for (const repo of repos.values()) if (repo.id === num) return repo;
  return undefined;
}

export function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
  const m = /^I_(\d+)_(\d+)$/.exec(id);
  if (m === null) return undefined;
  const repo = [...repos.values()].find((r) => r.id === Number(m[1]));
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((i) => i.number === Number(m[2]));
  return issue === undefined ? undefined : { repo, issue };
}

export function findPullByGlobalId(id: string): { repo: Repo; pr: PullRequest } | undefined {
  const m = /^PR_(\d+)_(\d+)$/.exec(id);
  if (m === null) return undefined;
  const repo = [...repos.values()].find((r) => r.id === Number(m[1]));
  if (repo === undefined) return undefined;
  const pr = repo.pulls.find((p) => p.number === Number(m[2]));
  return pr === undefined ? undefined : { repo, pr };
}
