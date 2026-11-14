// gitproto.ts — git smart HTTP: pkt-line codec, packfile read/write, upload-pack v2/v0,
// ls-refs, fetch (incl. shallow/deepen/incremental), receive-pack v0 with report-status.
// Only node builtins (node:zlib, node:crypto). Deltas are resolved on read and never sent.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  commitHistory,
  getObject,
  isAncestor,
  objectId,
  parseCommit,
  parseTree,
  reachableObjects,
  storeObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

export const AGENT = 'makefun-forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse a whole buffer of pkt-lines. Throws on malformed input. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(i, i + 4).toString('utf8');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

export function pktLinesToText(packets: readonly Pkt[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (TYPE_CODE[type] << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, plain objects, no deltas) from oids, sorted for determinism. */
export function buildPack(oids: Iterable<string>): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'utf8');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const oid of sorted) {
    const obj = getObject(oid);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const sum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, sum]);
}

/** Inflate a zlib stream starting at `pos`; return its bytes and how many input bytes it used. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; used: number } {
  const slice = buf.subarray(pos);
  // Fast path (Node 22.5+): inflateSync with {info:true} reports the input bytes the
  // engine consumed in `engine.bytesWritten` — one call, exact length.
  try {
    const out = inflateSync(slice, { info: true }) as unknown as { buffer?: Buffer; engine?: { bytesWritten?: number } };
    if (out !== null && typeof out === 'object' && out.buffer !== undefined && out.engine !== undefined) {
      const used = out.engine.bytesWritten ?? 0;
      if (used > 0 && used <= slice.length) return { data: out.buffer, used };
    }
  } catch {
    // Fall through to the binary search.
  }
  return inflateAtSlow(buf, pos);
}

/** Binary-search fallback for runtimes without zlib's {info:true} support. */
function inflateAtSlow(buf: Buffer, pos: number): { data: Buffer; used: number } {
  const max = buf.length - pos;
  // inflateSync ignores trailing bytes, so "inflates cleanly" is monotone in the slice
  // length: it throws while the slice cuts the stream short and succeeds once the
  // slice covers it. Binary-search the smallest succeeding length.
  const tries = (len: number): boolean => {
    try {
      inflateSync(buf.subarray(pos, pos + len));
      return true;
    } catch {
      return false;
    }
  };
  // Exponential probe for an upper bound that succeeds; `lo` is known to fail.
  let lo = 0;
  let hi = 1;
  while (hi <= max && !tries(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi > max) {
    if (!tries(max)) {
      // Nothing inflates here: surface the real zlib error.
      inflateSync(buf.subarray(pos, pos + max));
    }
    hi = max;
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tries(mid)) hi = mid;
    else lo = mid;
  }
  const data = inflateSync(buf.subarray(pos, pos + hi));
  return { data, used: hi };
}

export interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

/** Apply a git delta stream to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i] as number;
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i] as number, i += 1;
      if (op & 0x02) offset |= (delta[i] as number) << 8, i += 1;
      if (op & 0x04) offset |= (delta[i] as number) << 16, i += 1;
      if (op & 0x08) offset |= (delta[i] as number) << 24, i += 1;
      if (op & 0x10) size = delta[i] as number, i += 1;
      if (op & 0x20) size |= (delta[i] as number) << 8, i += 1;
      if (op & 0x40) size |= (delta[i] as number) << 16, i += 1;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== dstSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Read a packfile (versions 2/3), resolving OFS_DELTA and REF_DELTA. Entries in pack order. */
export function readPack(buf: Buffer): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const sum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!sum.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  interface Raw {
    typeNum: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const raws: Raw[] = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let byte = buf[pos] as number;
    pos += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      byte = buf[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data, used } = inflateAt(buf, pos);
    if (data.length !== size) throw new Error('pack object size mismatch');
    pos += used;
    raws.push({ typeNum, data, baseOffset, baseOid, offset: start });
  }
  // Resolve entries in order; deltas reference earlier pack entries or existing objects.
  const byOffset = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];
  const resolve = (raw: Raw): PackEntry => {
    if (raw.typeNum === 6 || raw.typeNum === 7) {
      let base: PackEntry | undefined;
      if (raw.baseOffset !== undefined) base = byOffset.get(raw.baseOffset);
      else if (raw.baseOid !== undefined) {
        const obj = getObject(raw.baseOid);
        if (obj !== undefined) base = { oid: raw.baseOid, type: obj.type, data: obj.data };
        else base = entries.find((e) => e.oid === raw.baseOid);
      }
      if (base === undefined) throw new Error('delta base not found');
      const data = applyDelta(base.data, raw.data);
      const entry: PackEntry = { oid: objectId(base.type, data), type: base.type, data };
      return entry;
    }
    const type = CODE_TYPE[raw.typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${raw.typeNum}`);
    return { oid: objectId(type, raw.data), type, data: raw.data };
  };
  for (const raw of raws) {
    const entry = resolve(raw);
    byOffset.set(raw.offset, entry);
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo in advertisement order: HEAD, heads, tags. */
export function listRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    out.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  }
  const heads = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/tags/')).sort();
  for (const [name, oid] of heads) out.push({ oid, name });
  for (const [name, oid] of tags) {
    const entry: AdvertisedRef = { oid, name };
    const obj = getObject(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) entry.peeled = m[1] as string;
    }
    out.push(entry);
  }
  return out;
}

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main agent=${AGENT} object-format=sha1 side-band-64k thin-pack ofs-delta multi_ack_detailed multi_ack shallow`;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;

/** v0 advertisement body for a service, with the "# service=" preamble. */
export function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0 || (refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.unborn)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      let line = `${ref.oid} ${ref.name}`;
      if (i === 0) line += `\0${caps}`;
      line += '\n';
      parts.push(pktLine(line));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement for upload-pack (after the optional service preamble). */
export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsResponse(repo: Repo, opts: LsRefsOptions): Buffer {
  const parts: Buffer[] = [];
  for (const ref of listRefs(repo)) {
    if (opts.prefixes.length > 0 && !opts.prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn === true) {
      if (!opts.unborn) continue;
      let line = `unborn ${ref.name}`;
      if (opts.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      parts.push(pktLine(`${line}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (opts.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (opts.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  thinPack: boolean;
}

export interface FetchPlan {
  /** Objects to send, in pack order (sorted inside buildPack). */
  send: Set<string>;
  /** New shallow boundary commits to report. */
  shallowOut: string[];
  /** Formerly-shallow commits that are now fully sent. */
  unshallowOut: string[];
}

/**
 * Compute what a fetch sends. `haveSet` is the closure of the client's haves.
 * Depth limits the commit walk from the wants; shallow boundaries are commits whose
 * parents were cut off by the depth limit.
 */
export function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  // The client's haves are had in full — except a shallow have: the client has that
  // commit but NOT its parents. So the exclusion set is reachable(haves) minus the
  // closure of the strict ancestors of every shallow have.
  const haveClosure = reachableObjects(req.haves);
  for (const s of req.shallow) {
    const obj = getObject(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    const ancestors = commitHistory(s).filter((oid) => oid !== s);
    for (const a of reachableObjects(ancestors)) haveClosure.delete(a);
  }
  const send = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const haveShallow = new Set(req.shallow);
  // Walk commits from wants with a depth budget (null = unlimited). A commit the
  // client already has stops the descent — unless it is a shallow boundary, whose
  // parents the client does not have.
  const commitQueue: Array<{ oid: string; depth: number }> = req.wants
    .filter((w) => {
      const o = getObject(w);
      return o !== undefined && o.type === 'commit';
    })
    .map((oid) => ({ oid, depth: 0 }));
  const seenCommits = new Set<string>();
  const boundary = new Set<string>();
  while (commitQueue.length > 0) {
    const { oid, depth } = commitQueue.shift() as { oid: string; depth: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (haveClosure.has(oid)) {
      if (haveShallow.has(oid) && (req.deepen === null || depth + 1 < req.deepen)) {
        for (const p of commit.parents) commitQueue.push({ oid: p, depth: depth + 1 });
      }
      continue;
    }
    const atLimit = req.deepen !== null && depth + 1 >= req.deepen;
    if (atLimit && commit.parents.length > 0) boundary.add(oid);
    if (!atLimit) {
      for (const p of commit.parents) commitQueue.push({ oid: p, depth: depth + 1 });
    }
    // Include the commit itself and its full tree.
    send.add(oid);
    for (const t of reachableObjects([commit.tree])) send.add(t);
  }
  // Tag objects among the wants (and their targets).
  for (const w of req.wants) {
    const o = getObject(w);
    if (o === undefined) continue;
    if (o.type === 'tag') {
      if (!haveClosure.has(w)) {
        for (const t of reachableObjects([w])) send.add(t);
      }
    } else if (o.type === 'tree' || o.type === 'blob') {
      if (!haveClosure.has(w)) send.add(w);
    }
  }
  // Never resend what the client already has.
  for (const oid of [...send]) if (haveClosure.has(oid)) send.delete(oid);
  for (const b of boundary) shallowOut.push(b);
  for (const s of haveShallow) {
    // A formerly-shallow commit is unshallowed when its parents are now sent (or it has none).
    const obj = getObject(s);
    if (obj !== undefined && obj.type === 'commit') {
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.every((p) => send.has(p) || haveClosure.has(p))) {
        if (!boundary.has(s)) unshallowOut.push(s);
      }
    }
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { send, shallowOut, unshallowOut };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (each <= 65520 bytes total). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 (pkt header) - 1 (band byte)
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

/** v2 fetch response: acknowledgments + shallow-info + wanted-refs + packfile sections. */
export function v2FetchResponse(repo: Repo, req: FetchRequest, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  // Per protocol-v2, the acknowledgments section is only present when the client
  // sent at least one `have` line; real git dies if it appears otherwise.
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
  }
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // The wanted-refs section is optional in protocol v2, and real git rejects
  // duplicate (oid, ref) lines in it — a clone wants the same tip twice (HEAD and
  // refs/heads/main) — so we omit it entirely; the suite's client treats it as
  // optional too.
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(plan.send);
  for (const p of sidebandPack(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK/shallow lines then the sideband pack. */
export function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack(plan.send);
  for (const p of sidebandPack(pack)) parts.push(p);
  return Buffer.concat(parts);
}

/** Parse a v2 fetch/ls-refs request body into command + pre/post-delim argument lines. */
export function parseV2Command(body: Buffer): { command: string; preArgs: string[]; args: string[] } {
  const packets = parsePktLines(body);
  const lines: string[] = [];
  const preArgs: string[] = [];
  const args: string[] = [];
  let pastDelim = false;
  let command = '';
  for (const p of packets) {
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').trim();
    if (command === '') {
      command = text;
      continue;
    }
    if (pastDelim) args.push(text);
    else preArgs.push(text);
  }
  void lines;
  return { command, preArgs, args };
}

/** Parse a v0 upload-pack request body: wants/haves/shallow/deepen across two sections. */
export function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0] as string;
      req.wants.push(oid);
      if (rest.includes('thin-pack')) req.thinPack = true;
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      req.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) req.deepen = n;
    }
  }
  void section;
  return req;
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  lines: Array<{ ref: string; ok: boolean; reason?: string }>;
}

/**
 * Apply a receive-pack: parse the command list + pack, store the objects, then apply
 * each ref update per-ref (partial apply: one refused ref does not block the others).
 */
export function handleReceivePack(repo: Repo, body: Buffer): { report: Buffer; result: PushResult } {
  const result: PushResult = { unpackOk: false, unpackDetail: 'unpack failed', lines: [] };
  let commands: PushCommand[] = [];
  let packStart = 0;
  let sideband = false;
  try {
    // Parse the command list pkt-line by pkt-line, stopping at the flush: the
    // raw packfile follows the flush and is NOT pkt-line framed.
    let offset = 0;
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const head = body.subarray(offset, offset + 4).toString('utf8');
      if (head === '0000') {
        sawFlush = true;
        offset += 4;
        break;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
      if (offset + len > body.length) throw new Error('truncated pkt-line');
      const line = body.subarray(offset + 4, offset + len).toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0 && commands.length === 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) sideband = true;
      }
      const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
      const parts = clean.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
      offset += len;
    }
    if (!sawFlush) throw new Error('no flush after command list');
    packStart = offset;
  } catch (err) {
    result.unpackDetail = `unpack ${(err as Error).message}`;
    return { report: buildPushReport(result, sideband), result };
  }

  // Parse and store the pack (may be empty when the push is delete-only).
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes);
      for (const e of entries) storeObject(e.type, e.data);
    } catch (err) {
      result.unpackDetail = `unpack ${(err as Error).message}`;
      return { report: buildPushReport(result, sideband), result };
    }
  }
  result.unpackOk = true;
  result.unpackDetail = 'ok';

  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        result.lines.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    const newObj = getObject(cmd.newOid);
    if (newObj === undefined) {
      result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const isTagRef = cmd.ref.startsWith('refs/tags/');
    if (!isTagRef && newObj.type !== 'commit') {
      result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (isTagRef && newObj.type !== 'commit' && newObj.type !== 'tag') {
      result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        result.lines.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (cmd.oldOid !== current) {
      result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // Tags point at immutable objects: a tag update is not a fast-forward walk.
    if (isTagRef) {
      repo.refs.set(cmd.ref, cmd.newOid);
      result.lines.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (!isAncestor(cmd.oldOid, cmd.newOid)) {
      result.lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    result.lines.push({ ref: cmd.ref, ok: true });
  }
  return { report: buildPushReport(result, sideband), result };
}

function buildPushReport(result: PushResult, sideband: boolean): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail.replace(/^unpack /, '')}\n`));
  for (const l of result.lines) {
    lines.push(pktLine(l.ok ? `ok ${l.ref}\n` : `ng ${l.ref} ${l.reason ?? 'failed'}\n`));
  }
  if (!sideband) {
    return Buffer.concat([...lines, PKT_FLUSH]);
  }
  // Each report pkt-line rides inside a band-1 sideband packet, and the report is
  // closed by a flush pkt-line inside band 1 as well: the reader parses the
  // demultiplexed stream and needs that inner flush to end cleanly (an outer
  // flush alone reads as a hangup to real git).
  const out: Buffer[] = [];
  for (const l of lines) out.push(pktLine(Buffer.concat([Buffer.from([1]), l])));
  out.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}
