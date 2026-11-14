// graphql.ts — a small GraphQL executor for the documents gh / github-mcp-server send.
// Supports queries, mutations, aliases, variables, arguments (scalars, enums, lists,
// objects), inline fragments and batched bodies. Unknown fields produce a 200 with
// an errors array naming the field (partial data, like GitHub).

import {
  VIEWER_LOGIN,
  branchTip,
  commitFile,
  findIssueByGlobalId,
  findPullByGlobalId,
  findRepoByGlobalId,
  getObject,
  getRepo,
  issueGlobalId,
  nextSeq,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  commentGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { mergePullRequest as restMerge, prConflicts } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (subset)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      // Block string """...""" or normal "...".
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}():$!@=[]|&.'.includes(c)) {
      // '...' is three '.' puncts in a row.
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    // Unknown character: skip it.
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'punct' && this.peek().value === '$') this.next();
        const varName = this.expectName();
        this.expectPunct(':');
        // Type: a name, possibly wrapped in [] or suffixed with !. Skip it.
        while (this.peek().kind === 'punct' && (this.peek().value === '[' || this.peek().value === '!')) this.next();
        this.expectName();
        while (this.peek().kind === 'punct' && (this.peek().value === ']' || this.peek().value === '!')) this.next();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '.') {
      // '...' — inline fragment (or a spread, which we do not support; treat as inline).
      this.next();
      this.next();
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selection };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) — skip.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${t.value} in value`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, variables);
}

// ---------------------------------------------------------------------------
// Schema surface (for introspection + unknown-field errors)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changeType'],
  BranchRef: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Node: ['id'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  variables: Variables;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

type AnyObj = Record<string, unknown>;

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string | null | undefined): number | null {
  if (cursor === undefined || cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function resolveField(
  typeName: string,
  obj: AnyObj,
  field: FieldNode,
  exec: ExecCtx,
  path: (string | number)[],
): unknown {
  const allowed = TYPE_FIELDS[typeName];
  if (allowed !== undefined && !allowed.includes(field.name)) {
    exec.errors.push({
      message: `Cannot query field "${field.name}" on type "${typeName}".`,
      path: [...path, field.name],
    });
    return undefined;
  }
  return resolveKnownField(typeName, obj, field, exec, path);
}

function resolveKnownField(
  typeName: string,
  obj: AnyObj,
  field: FieldNode,
  exec: ExecCtx,
  path: (string | number)[],
): unknown {
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', exec.variables) as string | undefined;
        const name = argValue(field, 'name', exec.variables) as string | undefined;
        if (owner !== VIEWER_LOGIN || name === undefined) return null;
        const repo = getRepo(owner, name);
        if (repo === undefined) return null;
        return { __typename: 'Repository', repo };
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', exec.variables) as string | undefined;
        if (id === undefined) return null;
        const repo = findRepoByGlobalId(id);
        if (repo !== undefined) return { __typename: 'Repository', repo };
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', exec.variables) as string | undefined;
        if (name === undefined) return null;
        if (TYPE_FIELDS[name] !== undefined || TYPE_ENUM_VALUES[name] !== undefined) {
          return { __typename: '__Type', typeName: name };
        }
        return null;
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return `U_1000`;
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      return null;
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { __typename: 'BranchRef', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'issue': {
          const number = argValue(field, 'number', exec.variables) as number | undefined;
          const issue = repo.issues.find((i) => i.number === number);
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        case 'issues': {
          const first = (argValue(field, 'first', exec.variables) as number | undefined) ?? 10;
          const after = argValue(field, 'after', exec.variables) as string | null | undefined;
          const states = argValue(field, 'states', exec.variables) as string[] | undefined;
          const orderBy = argValue(field, 'orderBy', exec.variables) as Record<string, unknown> | undefined;
          let list = [...repo.issues];
          if (states !== undefined) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            list = list.filter((i) => wanted.has(i.state));
          }
          const direction = orderBy !== undefined && orderBy.direction === 'ASC' ? 1 : -1;
          list.sort((a, b) => (a.number - b.number) * direction);
          const afterNum = numberFromCursor(after);
          if (afterNum !== null) {
            list = direction === -1 ? list.filter((i) => i.number < afterNum) : list.filter((i) => i.number > afterNum);
          }
          const nodes = list.slice(0, first);
          const hasNextPage = list.length > first;
          const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]?.number as number) : null;
          return {
            __typename: 'IssueConnection',
            nodes: nodes.map((issue) => ({ __typename: 'Issue', repo, issue })),
            pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
          };
        }
        case 'pullRequests': {
          const first = (argValue(field, 'first', exec.variables) as number | undefined) ?? 10;
          const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
          return {
            __typename: 'PullRequestConnection',
            nodes: list.map((pr) => ({ __typename: 'PullRequest', repo, pr })),
          };
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', exec.variables) as number | undefined;
          const pr = repo.pulls.find((p) => p.number === number);
          return pr === undefined ? null : { __typename: 'PullRequest', repo, pr };
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = obj.issue as Issue;
      const repo = obj.repo as Repo;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.nodes;
      if (field.name === 'pageInfo') return obj.pageInfo;
      if (field.name === 'totalCount') return (obj.nodes as unknown[]).length;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const pr = obj.pr as PullRequest;
      const repo = obj.repo as Repo;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pr);
        case 'number':
          return pr.number;
        case 'title':
          return pr.title;
        case 'body':
          return pr.body;
        case 'state':
          return prState(pr);
        case 'merged':
          return pr.merged;
        case 'headRefName':
          return pr.headRef;
        case 'baseRefName':
          return pr.baseRef;
        case 'mergeable':
          return prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
        case 'files': {
          const first = (argValue(field, 'first', exec.variables) as number | undefined) ?? 10;
          const headObj = getObject(pr.headSha);
          const baseObj = getObject(pr.baseSha);
          const paths: string[] = [];
          const headTree = headObj !== undefined && headObj.type === 'commit' ? parseCommit(headObj.data).tree : null;
          const baseTree = baseObj !== undefined && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : null;
          if (headTree !== null && baseTree !== null) {
            for (const d of diffTrees(baseTree, headTree)) paths.push(d.path);
          }
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: paths.slice(0, first).map((p) => ({ __typename: 'PullRequestChangedFile', path: p })),
          };
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.nodes;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return obj.nodes;
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return obj.path;
      if (field.name === 'filename') return obj.path;
      return null;
    }
    case 'BranchRef': {
      if (field.name === 'name') return obj.name;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return obj.issue;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return obj.pullRequest;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return obj.commentEdge;
      if (field.name === 'comment') return obj.commentEdge?.node ?? null;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return obj.node;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return obj.id;
      if (field.name === 'body') return obj.body;
      return null;
    }
    case '__Type': {
      const typeName = obj.typeName as string;
      if (field.name === 'name') return typeName;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }));
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUM_VALUES[typeName] ?? [];
        return names.map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      return null;
    }
    default:
      return null;
  }
}

// The diff helper lives in store.ts.
import { diffTrees } from './store.ts';

function executeSelection(
  typeName: string,
  obj: AnyObj,
  selection: SelectionNode[],
  exec: ExecCtx,
  path: (string | number)[],
): AnyObj {
  const out: AnyObj = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName && sel.typeCondition !== 'Node') continue;
      const frag = executeSelection(typeName, obj, sel.selection, exec, path);
      Object.assign(out, frag);
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const value = resolveField(typeName, obj, field, exec, [...path, key]);
    if (value === undefined) continue; // unknown field: error recorded, no value
    out[key] = completeValue(value, field, exec, [...path, key]);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, exec: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return value;
  if (field.selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item !== null && typeof item === 'object' && '__typename' in (item as AnyObj)) {
        return executeSelection((item as AnyObj).__typename as string, item as AnyObj, field.selection as SelectionNode[], exec, [...path, i]);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__typename' in (value as AnyObj)) {
    return executeSelection((value as AnyObj).__typename as string, value as AnyObj, field.selection as SelectionNode[], exec, path);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function executeMutation(op: OperationNode, exec: ExecCtx): AnyObj {
  const out: AnyObj = {};
  for (const sel of op.selection) {
    if (sel.kind !== 'field') continue;
    const field = sel.field;
    const key = field.alias ?? field.name;
    const input = (argValue(field, 'input', exec.variables) ?? {}) as Record<string, unknown>;
    try {
      const payload = runMutation(field.name, input, exec);
      out[key] = field.selection === null ? payload : completeValue(payload, field, exec, [key]);
    } catch (err) {
      exec.errors.push({ message: (err as Error).message, path: [key] });
      out[key] = null;
    }
  }
  return out;
}

function runMutation(name: string, input: Record<string, unknown>, exec: ExecCtx): AnyObj {
  void exec;
  switch (name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const title = String(input.title ?? '');
      if (title === '') throw new Error('title is required');
      repo.numberSeq += 1;
      const issue: Issue = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: nextSeq(),
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(String(input.issueId ?? ''));
      if (found === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } };
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
      repo.numberSeq += 1;
      const pr: PullRequest = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: nextSeq(),
      };
      repo.pulls.push(pr);
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr } };
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
      if (found === undefined) throw new Error('pull request not found');
      const merged = restMerge(found.repo, found.pr);
      if (!merged.ok) throw new Error(merged.message ?? 'merge failed');
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo: found.repo, pr: found.pr } };
    }
    case 'addComment': {
      const found = findIssueByGlobalId(String(input.subjectId ?? ''));
      if (found === undefined) throw new Error('issue not found');
      const body = String(input.body ?? '');
      if (body === '') throw new Error('body is required');
      found.repo.commentSeq += 1;
      const comment = { id: found.repo.commentSeq, body, createdSeq: nextSeq() };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: commentGlobalId(found.repo, found.issue, comment), body },
        },
      };
    }
    default:
      throw new Error(`unknown mutation ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLEnvelope {
  data: unknown;
  errors?: Array<{ message: string; path?: (string | number)[] }>;
}

export function executeGraphQL(body: unknown): GraphQLEnvelope | GraphQLEnvelope[] {
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(item));
  }
  return executeOne(body);
}

function executeOne(body: unknown): GraphQLEnvelope {
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Variables;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  let ops: OperationNode[];
  try {
    ops = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `syntax error: ${(err as Error).message}` }] };
  }
  if (ops.length === 0) {
    return { data: null, errors: [{ message: 'no operation found' }] };
  }
  const exec: ExecCtx = { variables, errors: [] };
  const data: AnyObj = {};
  for (const op of ops) {
    if (op.kind === 'mutation') {
      Object.assign(data, executeMutation(op, exec));
    } else {
      // Query root: resolve each top-level field against the Query type.
      const root = executeSelection('Query', { __typename: 'Query' }, op.selection, exec, []);
      Object.assign(data, root);
    }
  }
  const envelope: GraphQLEnvelope = { data };
  if (exec.errors.length > 0) envelope.errors = exec.errors;
  return envelope;
}
