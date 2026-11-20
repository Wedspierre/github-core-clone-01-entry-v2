// Git smart HTTP: pkt-line framing, v0 and v2 advertisements, ls-refs, fetch
// (v2 and v0) and receive-pack. Packs are plain (no deltas) and, for the hot
// clone path, built once per (repo, tip, depth) and served as a final Buffer.

import { inflateSync } from 'node:zlib';
import {
  collectReachable,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObj,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode pkt-lines from the front of a buffer; `rest` is what follows the first flush. */
export function decodePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer; ok: boolean } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buffer.length) {
    const head = buffer.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { packets, rest: buffer.subarray(off), ok: false };
    const length = Number.parseInt(head, 16);
    if (length === 0) return { packets: [...packets, { kind: 'flush' }], rest: buffer.subarray(off + 4), ok: true };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (length < 4 || off + length > buffer.length) return { packets, rest: buffer.subarray(off), ok: false };
    packets.push({ kind: 'data', payload: buffer.subarray(off + 4, off + length) });
    off += length;
  }
  return { packets, rest: buffer.subarray(off), ok: off === buffer.length };
}

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const AGENT = 'github-core-clone-01-entry/3.0.0';
const V2_ADVERTISEMENT = pktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);

const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The v0 upload-pack advertisement (refs + capabilities on the HEAD line). */
export function v0UploadAdvertisement(repo: Repo): Buffer {
  if (repo.advUploadV0) return repo.advUploadV0;
  const refs = sortedRefs(repo);
  const head = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const lines: (string | Buffer | 'flush')[] = ['# service=git-upload-pack\n', 'flush'];
  const caps = `${UPLOAD_V0_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          lines.push(`${parseTag(object.data).object} ${ref.name}^{}\n`);
        }
      }
    }
  }
  lines.push('flush');
  repo.advUploadV0 = pktLines(lines);
  return repo.advUploadV0;
}

/** The v0 receive-pack advertisement. */
export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  if (repo.advReceiveV0) return repo.advReceiveV0;
  const refs = sortedRefs(repo);
  const head = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const lines: (string | Buffer | 'flush')[] = ['# service=git-receive-pack\n', 'flush'];
  const caps = `${RECEIVE_V0_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  repo.advReceiveV0 = pktLines(lines);
  return repo.advReceiveV0;
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function lsRefsResponse(repo: Repo, options: { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean }): Buffer {
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (headOid === undefined) {
    if (options.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    return pktLines([...lines, 'flush']);
  }
  if (options.symrefs && keep('HEAD')) lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------
// fetch: what to send
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to pack, in traversal order. */
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out a fetch's pack contents. `haves` the client holds are excluded;
 * a have named in `shallowIn` is a shallow boundary, so its parents are NOT
 * held. With `depth`, only that many commit generations are included and the
 * deepest included commits become the new shallow boundary.
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowIn);
  // What the client already holds.
  const held = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (!object) continue;
    if (object.type === 'commit' && shallowSet.has(have)) {
      // A shallow boundary: the commit, its tree and blobs — not its parents.
      held.add(have);
      const commit = parseCommit(object.data);
      for (const oid of collectReachable(repo.objects, [commit.tree])) held.add(oid);
    } else {
      for (const oid of collectReachable(repo.objects, [have])) held.add(oid);
    }
  }

  const send = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    for (const oid of collectReachable(repo.objects, wants)) {
      if (!held.has(oid)) send.add(oid);
    }
  } else {
    // BFS over commits by generation from the wants.
    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wants) {
      if (isOid(want) && want !== ZERO_OID && !level.has(want)) {
        level.set(want, 0);
        queue.push(want);
      }
    }
    const included = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head]!;
      const at = level.get(oid)!;
      if (at >= depth) continue;
      included.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const oid2 of collectReachable(repo.objects, [commit.tree])) {
        if (!held.has(oid2)) send.add(oid2);
      }
      if (!held.has(oid)) send.add(oid);
      for (const parent of commit.parents) {
        if (!level.has(parent)) {
          level.set(parent, at + 1);
          queue.push(parent);
        }
      }
    }
    for (const oid of included) {
      const at = level.get(oid)!;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const hasIncludedParent = parents.some((parent) => included.has(parent));
      if (!hasIncludedParent) shallow.push(oid);
      else if (shallowSet.has(oid)) unshallow.push(oid);
    }
  }
  // Deterministic pack order: sort by id so the cached buffer is stable.
  const objects: GitObj[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pkt(framed));
  }
  return Buffer.concat(parts);
}

/** A whole v2 fetch response, cached per (repo version, wants, haves, shallow, depth). */
export function v2FetchResponse(store: Store, repo: Repo, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): Buffer {
  const key = `${repo.version}|${wants.join(',')}|${haves.join(',')}|${shallowIn.join(',')}|${depth ?? ''}`;
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(store, repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), DELIM];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (plan.objects.length > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(sideband(writePack(plan.objects)));
  }
  parts.push(FLUSH);
  const response = Buffer.concat(parts);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, response);
  return response;
}

/** A whole v0 fetch response. */
export function v0FetchResponse(store: Store, repo: Repo, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): Buffer {
  const plan = planFetch(store, repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sideband(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: { ref: string; ok: boolean; reason: string }[];
}

/** Parse a receive-pack body, store its pack, apply the commands, build the report. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const decoded = decodePackets(body);
  if (!decoded.ok) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed push command' }), 'utf8') };
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }
  const outcome: PushOutcome = { unpackOk: true, unpackDetail: 'ok', refs: [] };
  let unpacked = new Map<string, GitObj>();
  const packBytes = decoded.rest;
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
    } catch (err) {
      outcome.unpackOk = false;
      outcome.unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (outcome.unpackOk) {
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  let changed = false;
  for (const command of commands) {
    if (!outcome.unpackOk) {
      outcome.refs.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) {
        outcome.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
        changed = true;
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      outcome.refs.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        outcome.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
      changed = true;
      continue;
    }
    if (current !== command.oldOid) {
      outcome.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(repo, current, command.newOid)) {
      outcome.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
    changed = true;
  }
  if (changed) store.touch(repo);
  const lines = [`unpack ${outcome.unpackDetail}\n`];
  for (const ref of outcome.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const report = pktLines(lines);
  // report-status inside sideband band 1, chunked like a pack.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < report.length; off += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(off, Math.min(report.length, off + CHUNK))])));
  }
  parts.push(FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// request parsing helpers for upload-pack
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  command: 'ls-refs' | 'fetch' | null;
  lsPrefixes: string[];
  lsPeel: boolean;
  lsSymrefs: boolean;
  lsUnborn: boolean;
}

/** Parse a v2 upload-pack request body. */
export function parseV2Request(body: Buffer): FetchRequest | null {
  const decoded = decodePackets(body);
  if (!decoded.ok) return null;
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    command: null,
    lsPrefixes: [],
    lsPeel: false,
    lsSymrefs: false,
    lsUnborn: false,
  };
  let afterDelim = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      request.command = line.slice(8) === 'ls-refs' ? 'ls-refs' : line.slice(8) === 'fetch' ? 'fetch' : null;
      continue;
    }
    if (!afterDelim) continue;
    if (request.command === 'ls-refs') {
      if (line === 'peel') request.lsPeel = true;
      else if (line === 'symrefs') request.lsSymrefs = true;
      else if (line === 'unborn') request.lsUnborn = true;
      else if (line.startsWith('ref-prefix ')) request.lsPrefixes.push(line.slice(11));
      continue;
    }
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
  }
  return request;
}

/** Parse a v0 upload-pack request body (want section, flush, have section). */
export function parseV0Request(body: Buffer): FetchRequest | null {
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    command: 'fetch',
    lsPrefixes: [],
    lsPeel: false,
    lsSymrefs: false,
    lsUnborn: false,
  };
  let section = 0;
  let off = 0;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      section += 1;
      off += 4;
      continue;
    }
    if (length < 4 || off + length > body.length) return null;
    const line = body.subarray(off + 4, off + length).toString('utf8').replace(/\n$/, '');
    off += length;
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        request.wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
    }
  }
  return request;
}

/** Inflate one zlib stream starting at `offset` (used by nothing here yet — kept for pack reads). */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}
