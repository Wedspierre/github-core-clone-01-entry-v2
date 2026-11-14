# github-core-clone-01-entry

A standalone, GitHub-compatible git forge for [the contest](https://make.fun/bounty/github-core-clone-01):
one Node process serving git smart HTTP, REST v3, GraphQL v4 and MCP from its own
in-memory store — no UI, no outside service, no `git` binary, no dependencies.

Owner: Wedspierre · referral: `ta01qs0h` · wallet in `.makefun/owner.json`.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own. There is nothing to install: the program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only.

The env's origin is in `MAKEFUN_ENV_URL` and the bearer token in `MAKEFUN_SHOP_TOKEN`
(the suite presents the same token on every API call; `/healthz` takes none). Without
`MAKEFUN_ENV_URL` the process exits 1. For a local smoke test, point `MAKEFUN_ENV_URL` at
a stub or run the server directly — see "Grade locally" below.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)`; never bind 8080 (the env's port).
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repos, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message": "Not Found"}` |

Every REST reply is `application/json` and carries `X-GitHub-Request-Id`. A request
without the bearer token is 401; a repository under another owner is 404, never 403.

## Architecture

- `main.ts` — the entry <-> env lifecycle only.
- `app.ts` — the HTTP server: routing, auth, JSON plumbing, git dispatch.
- `store.ts` — the in-memory store: repos, refs, git objects, issues, pull requests;
  deterministic timestamps from `MAKEFUN_TRIAL_NOW` (never the wall clock) and
  counter-based ids, so two runs over the same requests leave the same state.
- `gitproto.ts` — pkt-line codec, packfile read (plain + OFS/REF deltas) and write
  (plain, version 2), v2 `ls-refs`/`fetch` with shallow/deepen/incremental support,
  v0 fetch, and receive-pack with per-ref fast-forward checks and `report-status`.
- `rest.ts` — the REST v3 resources, including squash merges with three-way
  conflict detection and contents backed by real git objects.
- `graphql.ts` — a small GraphQL parser + executor for the suite's documents,
  including introspection, opaque global ids, cursor pagination and mutations.
- `mcp.ts` — the MCP tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) on the same store.

## Grade locally

```sh
# from the kit directory, with the server running on $PORT:
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:$PORT --token "$MAKEFUN_SHOP_TOKEN" --perf
```

## Layout

- `main.ts`, `app.ts`, `store.ts`, `gitproto.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`:
  the server.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT), `.makefun/owner.json`: metadata.
