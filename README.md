# github-core-clone-01-entry

[![competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Wedspierre/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Wedspierre/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node 22 process,
built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## What it serves

- **Git smart HTTP** — `info/refs`, `upload-pack` and `receive-pack`, protocol
  v2 (`ls-refs`, `fetch`, shallow/deepen) and v0, with sideband framing and
  packfiles (plain, no deltas).
- **REST v3** — repositories, branches, commits, contents, labels, issues,
  comments and pull requests with files and squash merges.
- **GraphQL v4** — the documents `gh` and `github-mcp-server` send: viewer,
  repositories, issues and pull requests with cursor pagination, mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `node(id:)` and introspection of `Issue`, `PullRequest`,
  `Repository` and `SearchType`.
- **MCP over streamable HTTP** — modern `server/discover` (2026-07-28) and
  the legacy `initialize` flow, with `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`.

## Run

```sh
node --experimental-strip-types main.ts
```

The server listens on an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, and exits when `GET /done` reports
`{"done": true}`. `/healthz` answers `{"ok": true}` without auth; every
other route requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Design notes

- One in-memory store backs git, REST, GraphQL and MCP, so a push is visible
  to every surface at once.
- Issue reads serve cached response bytes; clone responses are cached as
  final buffers per fetch plan; pushes ingest synchronously with a fast
  fast-forward path.
- No `Date.now()` or `Math.random()` on the request path: all timestamps come
  from `MAKEFUN_TRIAL_NOW`, so replays are byte-deterministic.
