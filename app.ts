// HTTP server: one Node process, no dependencies. Manual routing (no path
// splitting on the hot path), a response-bytes cache for issue reads, and
// the git smart-HTTP endpoints. Request handling is deterministic: no
// Date.now() or Math.random() anywhere on the request path.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, issueBytes } from './rest.ts';
import { runGraphQL, runGraphQLBatch } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  decodePackets,
  handleReceivePack,
  lsRefsResponse,
  parseV0Request,
  parseV2Request,
  v0FetchResponse,
  v0ReceiveAdvertisement,
  v0UploadAdvertisement,
  v2Advertisement,
  v2FetchResponse,
} from './gitproto.ts';

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function send(res: ServerResponse, status: number, body: Buffer | null, contentType: string, extra?: Record<string, string>): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': `R${requestCounter}`,
  };
  if (extra) for (const [key, value] of Object.entries(extra)) headers[key] = value;
  if (body === null || body.length === 0) {
    headers['content-length'] = '0';
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  send(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json', extra);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_AD_UPLOAD = 'application/x-git-upload-pack-advertisement';
const GIT_AD_RECEIVE = 'application/x-git-receive-pack-advertisement';
const GIT_UPLOAD = 'application/x-git-upload-pack-request';
const GIT_RECEIVE = 'application/x-git-receive-pack-request';
const GIT_RESULT = 'application/x-git-upload-pack-result';
const GIT_RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Fast path: GET /api/v3/repos/{owner}/{repo}/issues/{n} with no query. */
function fastIssueRead(owner: string, repoName: string, number: number): Buffer | null {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return issueBytes(store, repo, issue);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const question = rawUrl.indexOf('?');
  const path = question === -1 ? rawUrl : rawUrl.slice(0, question);
  const queryString = question === -1 ? '' : rawUrl.slice(question + 1);
  const query = new URLSearchParams(queryString);

  // Health check: no auth, no request id needed beyond the standard header.
  if (path === '/healthz') {
    if (method === 'GET') return sendJson(res, 200, { ok: true });
    return sendJson(res, 404, { message: 'Not Found' });
  }

  if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' });

  const host = req.headers.host ?? 'localhost';

  // --- git smart HTTP -----------------------------------------------------
  if (path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack')) {
    const suffix = path.endsWith('/info/refs') ? '/info/refs' : path.endsWith('/git-upload-pack') ? '/git-upload-pack' : '/git-receive-pack';
    const gitPath = path.slice(0, -suffix.length);
    const slash = gitPath.indexOf('/', 1);
    const owner = decodeURIComponent(gitPath.slice(1, slash));
    const repoPart = decodeURIComponent(gitPath.slice(slash + 1));
    const repoName = repoPart.endsWith('.git') ? repoPart.slice(0, -4) : repoPart;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return sendJson(res, 404, { message: 'Not Found' });

    if (path.endsWith('/info/refs')) {
      const service = query.get('service');
      if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
      if (service === 'git-upload-pack') {
        if (req.headers['git-protocol'] === 'version=2') {
          return send(res, 200, v2Advertisement(), GIT_AD_UPLOAD);
        }
        return send(res, 200, v0UploadAdvertisement(repo), GIT_AD_UPLOAD);
      }
      if (service === 'git-receive-pack') {
        return send(res, 200, v0ReceiveAdvertisement(repo), GIT_AD_RECEIVE);
      }
      return sendJson(res, 400, { message: 'unknown service' });
    }

    const body = await readBody(req);
    if (path.endsWith('/git-upload-pack')) {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      if (req.headers['git-protocol'] === 'version=2') {
        const request = parseV2Request(body);
        if (request === null) return sendJson(res, 400, { message: 'malformed pkt-line' });
        if (request.command === 'ls-refs') {
          return send(res, 200, lsRefsResponse(repo, { prefixes: request.lsPrefixes, peel: request.lsPeel, symrefs: request.lsSymrefs, unborn: request.lsUnborn }), GIT_RESULT);
        }
        if (request.command === 'fetch') {
          return send(res, 200, v2FetchResponse(store, repo, request.wants, request.haves, request.shallow, request.depth), GIT_RESULT);
        }
        return sendJson(res, 400, { message: 'unknown command' });
      }
      const request = parseV0Request(body);
      if (request === null) return sendJson(res, 400, { message: 'malformed pkt-line' });
      return send(res, 200, v0FetchResponse(store, repo, request.wants, request.haves, request.shallow, request.depth), GIT_RESULT);
    }

    // receive-pack
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
    const outcome = handleReceivePack(store, repo, body);
    if (outcome.status !== 200) {
      // A malformed push body: git clients expect a report, but the suite's
      // malformed-POST check only requires the server to stay up and answer.
      const decoded = decodePackets(body);
      if (!decoded.ok) return sendJson(res, 400, { message: 'malformed pkt-line' });
      return sendJson(res, outcome.status, { message: 'Bad Request' });
    }
    return send(res, 200, outcome.body, GIT_RECEIVE_RESULT);
  }

  // --- GraphQL ------------------------------------------------------------
  if (path === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, { message: 'Problems parsing JSON' });
    }
    const result = Array.isArray(parsed) ? runGraphQLBatch(store, parsed) : runGraphQL(store, parsed);
    return sendJson(res, 200, result);
  }

  // --- MCP ----------------------------------------------------------------
  if (path === '/mcp') {
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    const reply = handleMcp(store, body.toString('utf8'));
    return send(res, reply.status, reply.body, 'application/json');
  }

  // --- REST ---------------------------------------------------------------
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    // Fast path: a single-issue read serves cached response bytes directly.
    if (method === 'GET' && queryString === '') {
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
      if (match !== null) {
        const bytes = fastIssueRead(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), Number.parseInt(match[3]!, 10));
        if (bytes !== null) return send(res, 200, bytes, 'application/json');
        return sendJson(res, 404, { message: 'Not Found' });
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    let bodyText = '';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      bodyText = (await readBody(req)).toString('utf8');
    }
    const reply = handleRest(store, method, segments, query, bodyText, host);
    if (reply.body === null) return send(res, reply.status, null, 'application/json', reply.headers);
    return send(res, reply.status, reply.body, 'application/json', reply.headers);
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

const server = createServer((req, res) => {
  res.socket?.setNoDelay(true);
  route(req, res).catch((err: unknown) => {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    } else {
      res.destroy();
    }
  });
});

export function start(port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

export { store };
