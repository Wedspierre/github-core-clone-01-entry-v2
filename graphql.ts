// GitHub GraphQL v4: a small hand-rolled parser for the documents gh and
// github-mcp-server actually send, plus an executor over the same store REST
// and git use. Unknown fields are GraphQL errors (HTTP 200), never HTTP 400.

import { decodeGid, gid } from './rest.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface Selection {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: Selection[] | null;
  fragmentType: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: Record<string, ValueNode | undefined> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.next();
    if (token.kind === 'spread') {
      // Inline fragment: `... on Type { ... }` (fragment spreads are not used here).
      let fragmentType: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selections, fragmentType };
    }
    if (token.kind !== 'name') throw new Error('expected field name');
    let alias: string | null = null;
    let name = token.value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (not used by the suite's documents) are skipped.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function valueOf(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, ctx));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argValue(selection: Selection, name: string, ctx: Ctx): unknown {
  const arg = selection.args.find((candidate) => candidate.name === name);
  if (!arg) return undefined;
  return valueOf(arg.value, ctx);
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url', 'author'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url', 'description', 'isPrivate'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_TYPE_FIELDS,
  PullRequest: PR_TYPE_FIELDS,
  Repository: REPO_TYPE_FIELDS,
  SearchType: [],
};

function typeDescriptor(name: string): AnyRecord | null {
  if (name === 'SearchType') {
    return {
      name,
      fields: null,
      enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'].map((value) => ({ name: value })),
    };
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return { name, fields: fields.map((field) => ({ name: field })), enumValues: null };
}

interface NodeRef {
  __typename: string;
  repo: Repo;
  issueNumber?: number;
  prNumber?: number;
}

function repoNode(store: Store, repo: Repo): NodeRef {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, number: number): NodeRef {
  return { __typename: 'Issue', repo, issueNumber: number };
}

function prNode(repo: Repo, number: number): NodeRef {
  return { __typename: 'PullRequest', repo, prNumber: number };
}

function resolveNode(ctx: Ctx, id: string): NodeRef | null {
  const decoded = decodeGid(id);
  if (!decoded) return null;
  if (decoded.kind === 'R') {
    const [owner, name] = decoded.key.split('/');
    const repo = owner !== undefined && name !== undefined ? ctx.store.getRepo(owner, name) : undefined;
    return repo ? repoNode(ctx.store, repo) : null;
  }
  if (decoded.kind === 'I' || decoded.kind === 'P') {
    const parts = decoded.key.split('/');
    const owner = parts[0];
    const name = parts[1];
    const number = Number.parseInt(parts[2] ?? '', 10);
    if (owner === undefined || name === undefined || !Number.isFinite(number)) return null;
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return null;
    return decoded.kind === 'I' ? issueNode(repo, number) : prNode(repo, number);
  }
  return null;
}

function selectFields(typeName: string, value: unknown, selections: Selection[] | null, ctx: Ctx): AnyRecord {
  const out: AnyRecord = {};
  if (selections === null) return value as AnyRecord;
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== typeName) continue;
      Object.assign(out, selectFields(typeName, value, selection.selections, ctx));
      continue;
    }
    if (selection.name === '') continue;
    const key = selection.alias ?? selection.name;
    const field = resolveField(typeName, value, selection, ctx);
    out[key] = field === undefined ? null : field;
  }
  return out;
}

function unknownField(typeName: string, name: string, ctx: Ctx): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}"` });
  return null;
}

function resolveField(typeName: string, value: unknown, selection: Selection, ctx: Ctx): unknown {
  const store = ctx.store;
  const name = selection.name;
  if (typeName === 'Query') {
    if (name === 'viewer') {
      return selectFields('User', { login: VIEWER_LOGIN }, selection.selections, ctx);
    }
    if (name === 'repository') {
      const owner = argValue(selection, 'owner', ctx);
      const repoName = argValue(selection, 'name', ctx);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = store.getRepo(owner, repoName);
      if (!repo) return null;
      return selectFields('Repository', repoNode(store, repo), selection.selections, ctx);
    }
    if (name === 'node') {
      const id = argValue(selection, 'id', ctx);
      if (typeof id !== 'string') return null;
      const node = resolveNode(ctx, id);
      if (!node) return null;
      return selectFields(node.__typename, node, selection.selections, ctx);
    }
    if (name === '__type') {
      const typeNameArg = argValue(selection, 'name', ctx);
      if (typeof typeNameArg !== 'string') return null;
      const descriptor = typeDescriptor(typeNameArg);
      if (!descriptor) return null;
      return selectFields('__Type', descriptor, selection.selections, ctx);
    }
    return unknownField('Query', name, ctx);
  }
  if (typeName === 'User') {
    if (name === 'login') return VIEWER_LOGIN;
    return unknownField('User', name, ctx);
  }
  if (typeName === '__Type') {
    const record = value as AnyRecord;
    if (name === 'name') return record.name ?? null;
    if (name === 'fields') return record.fields ?? null;
    if (name === 'enumValues') return record.enumValues ?? null;
    return unknownField('__Type', name, ctx);
  }
  if (typeName === 'Repository') {
    const node = value as NodeRef;
    const repo = node.repo;
    switch (name) {
      case 'id':
        return gid('R', `${repo.owner}/${repo.name}`);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return selectFields('User', { login: repo.owner }, selection.selections, ctx);
      case 'defaultBranchRef':
        return selectFields('Ref', { name: repo.defaultBranch }, selection.selections, ctx);
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
      case 'updatedAt':
        return store.nowIso;
      case 'url':
        return `/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = argValue(selection, 'number', ctx);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return selectFields('Issue', issueNode(repo, number), selection.selections, ctx);
      }
      case 'issues': {
        const first = argValue(selection, 'first', ctx);
        const states = argValue(selection, 'states', ctx);
        const orderBy = argValue(selection, 'orderBy', ctx) as AnyRecord | undefined;
        const after = argValue(selection, 'after', ctx);
        let list = [...repo.issues.values()];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const direction = orderBy !== undefined && typeof orderBy === 'object' ? String(orderBy.direction ?? 'ASC') : 'ASC';
        list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        if (typeof after === 'string' && after !== '') {
          const decoded = decodeGid(after);
          const cursorNumber = decoded !== null ? Number.parseInt(decoded.key, 10) : Number.NaN;
          if (Number.isFinite(cursorNumber)) {
            const index = list.findIndex((issue) => issue.number === cursorNumber);
            if (index >= 0) list = list.slice(index + 1);
          }
        }
        const limit = typeof first === 'number' ? first : list.length;
        const page = list.slice(0, limit);
        const hasNext = list.length > limit;
        const endCursor = page.length > 0 ? gid('cursor', String(page[page.length - 1]!.number)) : null;
        const nodes = page.map((issue) => selectFields('Issue', issueNode(repo, issue.number), selection.selections?.find((s) => s.name === 'nodes')?.selections ?? null, ctx));
        const connection: AnyRecord = { nodes };
        const pageInfoSelection = selection.selections?.find((s) => s.name === 'pageInfo');
        if (pageInfoSelection) {
          connection.pageInfo = { hasNextPage: hasNext, endCursor };
        }
        return connection;
      }
      case 'pullRequests': {
        const first = argValue(selection, 'first', ctx);
        const list = [...repo.prs.values()].sort((a, b) => b.seq - a.seq);
        const limit = typeof first === 'number' ? first : list.length;
        const nodes = list.slice(0, limit).map((pr) => selectFields('PullRequest', prNode(repo, pr.number), selection.selections?.find((s) => s.name === 'nodes')?.selections ?? null, ctx));
        return { nodes };
      }
      case 'pullRequest': {
        const number = argValue(selection, 'number', ctx);
        if (typeof number !== 'number') return null;
        const pr = repo.prs.get(number);
        if (!pr) return null;
        return selectFields('PullRequest', prNode(repo, number), selection.selections, ctx);
      }
      default:
        return unknownField('Repository', name, ctx);
    }
  }
  if (typeName === 'Issue') {
    const node = value as NodeRef;
    const issue = node.repo.issues.get(node.issueNumber ?? -1);
    if (!issue) return null;
    switch (name) {
      case 'id':
        return gid('I', `${node.repo.owner}/${node.repo.name}/${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state.toUpperCase();
      case 'body':
        return issue.body;
      case 'createdAt':
      case 'updatedAt':
        return store.nowIso;
      case 'url':
        return `/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
      case 'author':
        return selectFields('User', { login: VIEWER_LOGIN }, selection.selections, ctx);
      case 'labels':
        return { nodes: issue.labels.map((label) => ({ name: label.name })) };
      case 'comments':
        return { totalCount: node.repo.comments.get(issue.number)?.length ?? 0 };
      default:
        return unknownField('Issue', name, ctx);
    }
  }
  if (typeName === 'PullRequest') {
    const node = value as NodeRef;
    const pr = node.repo.prs.get(node.prNumber ?? -1);
    if (!pr) return null;
    switch (name) {
      case 'id':
        return gid('P', `${node.repo.owner}/${node.repo.name}/${pr.number}`);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'state':
        return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      case 'merged':
        return pr.merged;
      case 'mergeable':
        return store.prConflicts(node.repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'headRefOid':
        return pr.headSha;
      case 'baseRefOid':
        return pr.baseSha;
      case 'createdAt':
      case 'updatedAt':
        return store.nowIso;
      case 'url':
        return `/${node.repo.owner}/${node.repo.name}/pull/${pr.number}`;
      case 'author':
        return selectFields('User', { login: VIEWER_LOGIN }, selection.selections, ctx);
      case 'files': {
        const first = argValue(selection, 'first', ctx);
        const files = store.prFiles(node.repo, pr);
        const limit = typeof first === 'number' ? first : files.length;
        const nodes = files.slice(0, limit).map((file) => ({ path: file.filename }));
        return { nodes };
      }
      default:
        return unknownField('PullRequest', name, ctx);
    }
  }
  if (typeName === 'Ref') {
    const record = value as AnyRecord;
    if (name === 'name') return record.name ?? null;
    return unknownField('Ref', name, ctx);
  }
  return unknownField(typeName, name, ctx);
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: AnyRecord; errors: { message: string }[] } {
  const ctx: Ctx = { store, variables, errors: [] };
  const data: AnyRecord = {};
  if (operation.kind === 'mutation') {
    for (const selection of operation.selections) {
      if (selection.fragmentType !== null) continue;
      const key = selection.alias ?? selection.name;
      data[key] = executeMutation(selection, ctx);
    }
    return { data, errors: ctx.errors };
  }
  for (const selection of operation.selections) {
    if (selection.fragmentType !== null) continue;
    const key = selection.alias ?? selection.name;
    const field = resolveField('Query', null, selection, ctx);
    data[key] = field === undefined ? null : field;
  }
  return { data, errors: ctx.errors };
}

function inputOf(selection: Selection, ctx: Ctx): AnyRecord {
  const value = argValue(selection, 'input', ctx);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function executeMutation(selection: Selection, ctx: Ctx): AnyRecord {
  const store = ctx.store;
  const name = selection.name;
  const input = inputOf(selection, ctx);
  const wrap = (fieldName: string, inner: unknown): AnyRecord => {
    const out: AnyRecord = {};
    const innerSelection = selection.selections?.find((s) => s.name === fieldName);
    out[fieldName] = inner === null ? null : selectFields(fieldName === 'issue' ? 'Issue' : fieldName === 'pullRequest' ? 'PullRequest' : 'Comment', inner, innerSelection?.selections ?? null, ctx);
    return out;
  };
  if (name === 'createIssue') {
    const node = typeof input.repositoryId === 'string' ? resolveNode(ctx, input.repositoryId) : null;
    if (!node || node.__typename !== 'Repository') {
      ctx.errors.push({ message: 'createIssue: unknown repository' });
      return { issue: null };
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = store.createIssue(node.repo, title, body, []);
    return wrap('issue', issueNode(node.repo, issue.number));
  }
  if (name === 'closeIssue') {
    const node = typeof input.issueId === 'string' ? resolveNode(ctx, input.issueId) : null;
    if (!node || node.__typename !== 'Issue' || node.issueNumber === undefined) {
      ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return { issue: null };
    }
    const issue = node.repo.issues.get(node.issueNumber);
    if (!issue) {
      ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return { issue: null };
    }
    issue.state = 'closed';
    issue.cache = null;
    return wrap('issue', issueNode(node.repo, issue.number));
  }
  if (name === 'createPullRequest') {
    const node = typeof input.repositoryId === 'string' ? resolveNode(ctx, input.repositoryId) : null;
    if (!node || node.__typename !== 'Repository') {
      ctx.errors.push({ message: 'createPullRequest: unknown repository' });
      return { pullRequest: null };
    }
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : node.repo.defaultBranch;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const pr = store.createPull(node.repo, title, body, head, base);
    if (!pr) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch not found' });
      return { pullRequest: null };
    }
    return wrap('pullRequest', prNode(node.repo, pr.number));
  }
  if (name === 'mergePullRequest') {
    const node = typeof input.pullRequestId === 'string' ? resolveNode(ctx, input.pullRequestId) : null;
    if (!node || node.__typename !== 'PullRequest' || node.prNumber === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return { pullRequest: null };
    }
    const pr = node.repo.prs.get(node.prNumber);
    if (!pr) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return { pullRequest: null };
    }
    const sha = store.mergePull(node.repo, pr);
    if (sha === null) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return { pullRequest: null };
    }
    return wrap('pullRequest', prNode(node.repo, pr.number));
  }
  if (name === 'addComment') {
    const node = typeof input.subjectId === 'string' ? resolveNode(ctx, input.subjectId) : null;
    if (!node || node.__typename !== 'Issue' || node.issueNumber === undefined) {
      ctx.errors.push({ message: 'addComment: unknown subject' });
      return { commentEdge: null };
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: store.nextId(), body, seq: store.nextSeq() };
    const list = node.repo.comments.get(node.issueNumber) ?? [];
    list.push(comment);
    node.repo.comments.set(node.issueNumber, list);
    const edgeSelection = selection.selections?.find((s) => s.name === 'commentEdge');
    const nodeSelection = edgeSelection?.selections?.find((s) => s.name === 'node');
    const nodeOut: AnyRecord = {};
    if (nodeSelection) {
      for (const field of nodeSelection.selections ?? []) {
        if (field.name === 'id') nodeOut.id = gid('C', `${node.repo.owner}/${node.repo.name}/${node.issueNumber}/${comment.id}`);
        if (field.name === 'body') nodeOut.body = comment.body;
      }
    }
    return { commentEdge: { node: nodeOut } };
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation"` });
  return {};
}

/** Run one GraphQL operation body ({query, variables, operationName}) and return the response object. */
export function runGraphQL(store: Store, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL body must be an object' }] };
  }
  const record = body as AnyRecord;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  let operation = operations[0]!;
  if (operationName !== null) {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named) operation = named;
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [key, defaultValue] of Object.entries(operation.variables)) {
    if (mergedVariables[key] === undefined && defaultValue !== undefined) {
      mergedVariables[key] = valueOf(defaultValue, { store, variables, errors: [] });
    }
  }
  const { data, errors } = executeOperation(store, operation, mergedVariables);
  if (errors.length > 0) return { data, errors };
  return { data };
}

/** Run a batched body (a JSON array of operations) and return an array of responses. */
export function runGraphQLBatch(store: Store, body: unknown): unknown[] {
  if (!Array.isArray(body)) return [runGraphQL(store, body)];
  return body.map((entry) => runGraphQL(store, entry));
}
