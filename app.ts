// app.ts — the HTTP server: routing, auth, JSON plumbing, git smart HTTP dispatch.
// One process, node:http only. Auth: every /api/v3, /api/graphql and /mcp call must
// carry Authorization: Bearer $MAKEFUN_SHOP_TOKEN; /healthz takes none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SHOP_TOKEN, VIEWER_LOGIN, getRepo } from './store.ts';
import { routeRest, type RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleReceivePack,
  lsRefsResponse,
  parsePktLines,
  parseV0Fetch,
  parseV2Command,
  planFetch,
  pktLine,
  v0Advertisement,
  v0FetchResponse,
  v2Advertisement,
  v2FetchResponse,
  type FetchRequest,
  type LsRefsOptions,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendNoBody(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  return m === null ? null : (m[1] as string);
}

/** True when the request carries the suite's token (or any non-empty bearer when no token is configured). */
function authed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null) return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function gitRepo(owner: string, name: string): ReturnType<typeof getRepo> {
  if (owner !== VIEWER_LOGIN) return undefined;
  return getRepo(owner, name);
}

function handleGit(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer): boolean {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (m === null) return false;
  const owner = decodeSegment(m[1] as string);
  const repoName = decodeSegment(m[2] as string);
  const rest = m[3] as string;
  const repo = gitRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const query = queryOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, v0Advertisement('git-upload-pack', repo), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    try {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        const { command, args } = parseV2Command(body);
        if (command === 'command=ls-refs') {
          const opts: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
          for (const a of args) {
            if (a === 'peel') opts.peel = true;
            else if (a === 'symrefs') opts.symrefs = true;
            else if (a === 'unborn') opts.unborn = true;
            else if (a.startsWith('ref-prefix ')) opts.prefixes.push(a.slice('ref-prefix '.length));
          }
          sendBuffer(res, 200, lsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'command=fetch') {
          const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
          for (const a of args) {
            if (a === 'thin-pack') fetchReq.thinPack = true;
            else if (a.startsWith('want ')) fetchReq.wants.push(a.slice(5).trim());
            else if (a.startsWith('have ')) fetchReq.haves.push(a.slice(5).trim());
            else if (a.startsWith('shallow ')) fetchReq.shallow.push(a.slice(8).trim());
            else if (a.startsWith('deepen ')) {
              const n = Number(a.slice(7).trim());
              if (Number.isFinite(n)) fetchReq.deepen = n;
            }
          }
          const plan = planFetch(repo, fetchReq);
          sendBuffer(res, 200, v2FetchResponse(repo, fetchReq, plan), 'application/x-git-upload-pack-result');
          return true;
        }
        sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(command)}` });
        return true;
      }
      // v0 fetch.
      const fetchReq = parseV0Fetch(body);
      const plan = planFetch(repo, fetchReq);
      sendBuffer(res, 200, v0FetchResponse(plan), 'application/x-git-upload-pack-result');
      return true;
    } catch (err) {
      sendJson(res, 400, { message: (err as Error).message });
      return true;
    }
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    try {
      const { report } = handleReceivePack(repo, body);
      sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
      return true;
    } catch (err) {
      sendJson(res, 400, { message: (err as Error).message });
      return true;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------------------
// main router
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = await readBody(req);

        // git smart HTTP (no auth enforcement; the client always sends the token).
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (handleGit(req, res, path, body)) return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const outcome = handleMcp(body);
          if (outcome.body === null) {
            sendNoBody(res, outcome.status);
            return;
          }
          sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
          return;
        }

        // GraphQL.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end('{"message":"Unauthorized"}\n');
            return;
          }
          let parsed: unknown;
          try {
            parsed = body.length === 0 ? null : (JSON.parse(body.toString('utf8')) as unknown);
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return;
          }
          const envelope = executeGraphQL(parsed);
          sendJson(res, 200, envelope);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          let parsed: unknown = null;
          if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            try {
              parsed = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return;
            }
          }
          const rawSegments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/');
          const segments = rawSegments.filter((s) => s !== '').map(decodeSegment);
          const ctx: RestCtx = {
            method,
            segments,
            query: queryOf(req),
            body: parsed,
            baseUrl: `http://${req.headers.host ?? 'localhost'}`,
          };
          const result = routeRest(ctx);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (result.noBody === true) {
            sendNoBody(res, result.status);
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: (err as Error).message });
        } catch {
          // Response already gone; nothing to do.
        }
      }
    })();
  });
}

// Re-exported for the local smoke test.
export { pktLine };
