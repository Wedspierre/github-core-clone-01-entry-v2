// The forge's whole state: git objects and refs plus the REST view (repos, issues,
// pull requests, labels, comments) built on top of the same objects. One process,
// no disk, no dependencies — only node:crypto and node:zlib.
//
// Ownership: the suite's bearer token belongs to the trial's seeded viewer. The
// token itself is an opaque `shpat_…` string that carries no login, so the login
// is the one the sealed scenario always generates for its viewer
// (buildScenario's first user, fixed by the scenario seed): `adaiversen`.
// A repository is addressed as <viewer>/<name>; any other owner is a 404.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: readonly string[], message: string, who: string, timestamp: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${timestamp} +0000`, `committer ${who} ${timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta stream to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      delta.copy(out, written, off, off + len);
      off += len;
      written += len;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile into objects. Throws on any structural problem (a bad unpack). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) {
    throw new Error('pack checksum mismatch');
  }
  interface Raw {
    offset: number;
    code: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const code = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, code, size: header.size, data: Buffer.alloc(0) };
    if (code === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (code === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[code]) {
      throw new Error(`unknown pack type code ${code}`);
    }
    const inflated = zlibInflate(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const byOid = new Map<string, number>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.code === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.code === 7) {
      const baseOffset = entry.baseOid !== undefined ? byOid.get(entry.baseOid) : undefined;
      if (baseOffset !== undefined) {
        const base = resolve(byOffset.get(baseOffset)!);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.code]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    resolved.set(entry.offset, result);
    byOid.set(oid, entry.offset);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), deflate level 1. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflate(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/** Every object reachable from `roots` (full history). */
export function collectReachable(objects: Map<string, GitObj>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  seq: number;
  cache: Buffer | null;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  parentsCache: Map<string, string[]>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  seq: number;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>;
  version: number;
  commitSeq: number;
  advUploadV0: Buffer | null;
  advReceiveV0: Buffer | null;
  packCache: Map<string, Buffer>;
  treeMapCache: Map<string, Map<string, { mode: string; oid: string }>>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  /** Monotonic creation order, shared by issues and pull requests. */
  private seqCounter = 1;
  /** ISO timestamp every created object carries (from MAKEFUN_TRIAL_NOW, else fixed). */
  readonly nowIso: string;
  readonly nowSec: number;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? NaN : Date.parse(raw);
    if (Number.isFinite(parsed)) {
      this.nowSec = Math.floor(parsed / 1000);
      this.nowIso = new Date(parsed).toISOString();
    } else {
      this.nowSec = 1735689600;
      this.nowIso = '2025-01-01T00:00:00.000Z';
    }
  }

  nextSeq(): number {
    return this.seqCounter++;
  }

  nextId(): number {
    return this.nextGlobalId++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      parentsCache: new Map(),
      issues: new Map(),
      prs: new Map(),
      seq: 0,
      labels: new Map(),
      comments: new Map(),
      version: 0,
      commitSeq: 0,
      advUploadV0: null,
      advReceiveV0: null,
      packCache: new Map(),
      treeMapCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /** Store one object, return its id. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  parentsOf(repo: Repo, commitOid: string): string[] {
    let cached = repo.parentsCache.get(commitOid);
    if (cached) return cached;
    const object = repo.objects.get(commitOid);
    cached = object && object.type === 'commit' ? parseCommit(object.data).parents : [];
    repo.parentsCache.set(commitOid, cached);
    return cached;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of this.parentsOf(repo, oid)) queue.push(parent);
    }
    return false;
  }

  /** A merge-base of two commits (first common ancestor found walking B). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      for (const parent of this.parentsOf(repo, oid)) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      for (const parent of this.parentsOf(repo, oid)) queueB.push(parent);
    }
    return null;
  }

  /** Flat path map of a tree (path -> {mode, oid}), cached per tree id. */
  treeMap(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const cached = repo.treeMapCache.get(treeOid);
    if (cached) return cached;
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    repo.treeMapCache.set(treeOid, out);
    return out;
  }

  /** Build (and store) a tree from a flat path map; returns the root tree id. */
  buildTreeFromMap(repo: Repo, map: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of map) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object and store it. Timestamp is the trial now plus a counter. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const timestamp = this.nowSec + repo.commitSeq++;
    const who = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
    return this.putObject(repo, 'commit', buildCommit(tree, parents, message, who, timestamp));
  }

  /** Commits reachable from a tip, newest first (tip, then parents depth-first). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = this.parentsOf(repo, oid);
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  /** Bump a repo's version: every cached advertisement / pack dies with it. */
  touch(repo: Repo): void {
    repo.version += 1;
    repo.advUploadV0 = null;
    repo.advReceiveV0 = null;
    repo.packCache.clear();
  }

  // -------------------------------------------------------------------------
  // issues / pull requests
  // -------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: { name: string; color: string }[]): Issue {
    const number = ++repo.seq;
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      labels,
      seq: this.nextSeq(),
      cache: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    for (const existing of repo.prs.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) return existing;
    }
    const number = ++repo.seq;
    const pr: PullRequest = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: this.nextSeq(),
    };
    repo.prs.set(number, pr);
    return pr;
  }

  /** Files changed between a PR's merge-base and its head, with line counts. */
  prFiles(repo: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const base = this.mergeBase(repo, pr.headSha, pr.baseSha) ?? pr.baseSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pr.headSha);
    if (!baseCommit || !headCommit) return [];
    const baseTree = this.treeMap(repo, parseCommit(baseCommit.data).tree);
    const headTree = this.treeMap(repo, parseCommit(headCommit.data).tree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseTree.get(path);
      const after = headTree.get(path);
      if (before && after && before.oid === after.oid) continue;
      let additions = 0;
      let deletions = 0;
      if (before && after) {
        const oldText = textOf(repo, before.oid);
        const newText = textOf(repo, after.oid);
        const counts = lineDiff(oldText, newText);
        additions = counts.added;
        deletions = counts.removed;
      } else if (after) {
        additions = textOf(repo, after.oid).split('\n').length;
      } else if (before) {
        deletions = textOf(repo, before.oid).split('\n').length;
      }
      out.push({
        filename: path,
        status: !before ? 'added' : !after ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  /** True when the head's changes collide with what the base branch has done since the merge-base. */
  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const base = this.mergeBase(repo, pr.headSha, pr.baseSha);
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pr.headSha);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const baseTipCommit = baseTip === undefined ? undefined : repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit) return false;
    const mergeBaseTree = this.treeMap(repo, parseCommit(baseCommit.data).tree);
    const headTree = this.treeMap(repo, parseCommit(headCommit.data).tree);
    const tipTree = this.treeMap(repo, parseCommit(baseTipCommit.data).tree);
    const paths = new Set([...mergeBaseTree.keys(), ...headTree.keys()]);
    for (const path of paths) {
      const atBase = mergeBaseTree.get(path);
      const atHead = headTree.get(path);
      if (atBase?.oid === atHead?.oid) continue;
      const atTip = tipTree.get(path);
      if (atTip?.oid !== atBase?.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit id, or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    if (pr.merged && pr.mergeSha !== null) return pr.mergeSha;
    if (this.prConflicts(repo, pr)) return null;
    const base = this.mergeBase(repo, pr.headSha, pr.baseSha) ?? pr.baseSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pr.headSha);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const baseTipCommit = baseTip === undefined ? undefined : repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit || baseTip === undefined) return null;
    const mergeBaseTree = this.treeMap(repo, parseCommit(baseCommit.data).tree);
    const headTree = this.treeMap(repo, parseCommit(headCommit.data).tree);
    const tipTree = new Map(this.treeMap(repo, parseCommit(baseTipCommit.data).tree));
    for (const path of new Set([...mergeBaseTree.keys(), ...headTree.keys()])) {
      const atBase = mergeBaseTree.get(path);
      const atHead = headTree.get(path);
      if (atBase?.oid === atHead?.oid) continue;
      if (atHead) tipTree.set(path, atHead);
      else tipTree.delete(path);
    }
    const tree = this.buildTreeFromMap(repo, tipTree);
    const sha = this.makeCommit(repo, tree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso;
    pr.mergeSha = sha;
    this.touch(repo);
    return sha;
  }
}

function textOf(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** Naive multiset line diff: lines gained and lines lost. */
export function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newLines) {
    const before = oldLines.get(line) ?? 0;
    if (count > before) added += count - before;
  }
  for (const [line, count] of oldLines) {
    const after = newLines.get(line) ?? 0;
    if (count > after) removed += count - after;
  }
  return { added, removed };
}
