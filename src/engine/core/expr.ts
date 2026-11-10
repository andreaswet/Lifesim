/**
 * The content expression language (design §12.2).
 *
 * Conditions, weights and text placeholders in data files are written in this small language. It
 * is parsed to a tree and interpreted; nothing is ever passed to `eval`. Expressions read state
 * only through named accessors (`self.age`, `world.month`, `has('flu')`), never raw state paths,
 * so the engine's internal shape can change without breaking content.
 *
 * Grammar, loosest to tightest:
 *   ternary  := or ('?' ternary ':' ternary)?
 *   or       := and ('||' and)*
 *   and      := equality ('&&' equality)*
 *   equality := compare (('==' | '!=') compare)*
 *   compare  := sum (('<' | '<=' | '>' | '>=') sum)*
 *   sum      := product (('+' | '-') product)*
 *   product  := unary (('*' | '/' | '%') unary)*
 *   unary    := ('!' | '-') unary | postfix
 *   postfix  := primary ('.' name)*
 *   primary  := number | string | true | false | null | name | name '(' args ')' | '(' ternary ')'
 */

export type Value = number | string | boolean | null | undefined | { readonly [key: string]: unknown }

export type Node =
  | { t: 'lit'; v: number | string | boolean | null }
  | { t: 'ident'; name: string }
  | { t: 'member'; obj: Node; name: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'unary'; op: '!' | '-'; arg: Node }
  | { t: 'binary'; op: string; l: Node; r: Node }
  | { t: 'cond'; test: Node; yes: Node; no: Node }

export interface Env {
  vars: Readonly<Record<string, unknown>>
  fns: Readonly<Record<string, (...args: never[]) => unknown>>
}

export class ExprError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${message} in expression: ${source}`)
  }
}

interface Token {
  k: 'num' | 'str' | 'name' | 'op' | 'end'
  v: string
  pos: number
}

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '.', ',', '?', ':']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] !== undefined && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      let j = i
      while (j < src.length && ((src[j]! >= '0' && src[j]! <= '9') || src[j] === '.')) j++
      out.push({ k: 'num', v: src.slice(i, j), pos: i })
      i = j
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) j++
        s += src[j]
        j++
      }
      if (j >= src.length) throw new ExprError('Unterminated string', src)
      out.push({ k: 'str', v: s, pos: i })
      i = j + 1
      continue
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++
      out.push({ k: 'name', v: src.slice(i, j), pos: i })
      i = j
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (!op) throw new ExprError(`Unexpected character '${ch}'`, src)
    out.push({ k: 'op', v: op, pos: i })
    i += op.length
  }
  out.push({ k: 'end', v: '', pos: src.length })
  return out
}

export function parse(src: string): Node {
  const tokens = tokenize(src)
  let p = 0
  const peek = (): Token => tokens[p]!
  const next = (): Token => tokens[p++]!
  const isOp = (v: string): boolean => peek().k === 'op' && peek().v === v
  const expectOp = (v: string): void => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}'`, src)
    p++
  }

  const binaryLevel = (ops: string[], lower: () => Node): (() => Node) => {
    return () => {
      let left = lower()
      while (peek().k === 'op' && ops.includes(peek().v)) {
        const op = next().v
        left = { t: 'binary', op, l: left, r: lower() }
      }
      return left
    }
  }

  const primary = (): Node => {
    const tok = next()
    if (tok.k === 'num') return { t: 'lit', v: Number(tok.v) }
    if (tok.k === 'str') return { t: 'lit', v: tok.v }
    if (tok.k === 'name') {
      if (tok.v === 'true') return { t: 'lit', v: true }
      if (tok.v === 'false') return { t: 'lit', v: false }
      if (tok.v === 'null') return { t: 'lit', v: null }
      if (isOp('(')) {
        p++
        const args: Node[] = []
        if (!isOp(')')) {
          args.push(ternary())
          while (isOp(',')) {
            p++
            args.push(ternary())
          }
        }
        expectOp(')')
        return { t: 'call', fn: tok.v, args }
      }
      return { t: 'ident', name: tok.v }
    }
    if (tok.k === 'op' && tok.v === '(') {
      const inner = ternary()
      expectOp(')')
      return inner
    }
    throw new ExprError(`Unexpected '${tok.v || 'end of input'}'`, src)
  }

  const postfix = (): Node => {
    let node = primary()
    while (isOp('.')) {
      p++
      const name = next()
      if (name.k !== 'name') throw new ExprError("Expected a name after '.'", src)
      node = { t: 'member', obj: node, name: name.v }
    }
    return node
  }

  const unary = (): Node => {
    if (isOp('!') || isOp('-')) {
      const op = next().v as '!' | '-'
      return { t: 'unary', op, arg: unary() }
    }
    return postfix()
  }

  const product = binaryLevel(['*', '/', '%'], unary)
  const sum = binaryLevel(['+', '-'], product)
  const compare = binaryLevel(['<', '<=', '>', '>='], sum)
  const equality = binaryLevel(['==', '!='], compare)
  const and = binaryLevel(['&&'], equality)
  const or = binaryLevel(['||'], and)

  function ternary(): Node {
    const test = or()
    if (isOp('?')) {
      p++
      const yes = ternary()
      expectOp(':')
      const no = ternary()
      return { t: 'cond', test, yes, no }
    }
    return test
  }

  const root = ternary()
  if (peek().k !== 'end') throw new ExprError(`Unexpected '${peek().v}'`, src)
  return root
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== ''
}

function num(v: unknown, src: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new ExprError(`Expected a number but got ${v === null || v === undefined ? 'nothing' : typeof v}`, src)
}

function evaluate(node: Node, env: Env, src: string): unknown {
  switch (node.t) {
    case 'lit':
      return node.v
    case 'ident': {
      if (!(node.name in env.vars)) throw new ExprError(`Unknown name '${node.name}'`, src)
      return env.vars[node.name]
    }
    case 'member': {
      const obj = evaluate(node.obj, env, src)
      // Reading through something absent gives null, so `fact.lastShared != null` is safe.
      if (obj === null || obj === undefined || typeof obj !== 'object') return null
      const v = (obj as Record<string, unknown>)[node.name]
      return v === undefined ? null : v
    }
    case 'call': {
      const fn = env.fns[node.fn] as ((...args: unknown[]) => unknown) | undefined
      if (!fn) throw new ExprError(`Unknown function '${node.fn}'`, src)
      return fn(...node.args.map((a) => evaluate(a, env, src)))
    }
    case 'unary': {
      const v = evaluate(node.arg, env, src)
      return node.op === '!' ? !truthy(v) : -num(v, src)
    }
    case 'cond':
      return truthy(evaluate(node.test, env, src)) ? evaluate(node.yes, env, src) : evaluate(node.no, env, src)
    case 'binary': {
      if (node.op === '&&') {
        const l = evaluate(node.l, env, src)
        return truthy(l) ? evaluate(node.r, env, src) : l
      }
      if (node.op === '||') {
        const l = evaluate(node.l, env, src)
        return truthy(l) ? l : evaluate(node.r, env, src)
      }
      const l = evaluate(node.l, env, src)
      const r = evaluate(node.r, env, src)
      switch (node.op) {
        case '==':
          return (l ?? null) === (r ?? null)
        case '!=':
          return (l ?? null) !== (r ?? null)
        case '+':
          return typeof l === 'string' || typeof r === 'string' ? String(l ?? '') + String(r ?? '') : num(l, src) + num(r, src)
        case '-':
          return num(l, src) - num(r, src)
        case '*':
          return num(l, src) * num(r, src)
        case '/':
          return num(l, src) / num(r, src)
        case '%':
          return num(l, src) % num(r, src)
        case '<':
          return num(l, src) < num(r, src)
        case '<=':
          return num(l, src) <= num(r, src)
        case '>':
          return num(l, src) > num(r, src)
        case '>=':
          return num(l, src) >= num(r, src)
      }
      throw new ExprError(`Unknown operator '${node.op}'`, src)
    }
  }
}

/** A parsed expression together with the names it reads, for build-time validation. */
export interface Expr {
  readonly source: string
  readonly node: Node
  /** Dotted paths rooted at a variable, e.g. "self.age", "fact.stage". */
  readonly paths: readonly string[]
  /** Function names called. */
  readonly calls: readonly string[]
}

function collect(node: Node, paths: Set<string>, calls: Set<string>): void {
  switch (node.t) {
    case 'lit':
      return
    case 'ident':
      paths.add(node.name)
      return
    case 'member': {
      const parts: string[] = [node.name]
      let cur: Node = node.obj
      while (cur.t === 'member') {
        parts.unshift(cur.name)
        cur = cur.obj
      }
      if (cur.t === 'ident') {
        paths.add([cur.name, ...parts].join('.'))
      } else {
        collect(cur, paths, calls)
      }
      return
    }
    case 'call':
      calls.add(node.fn)
      for (const a of node.args) collect(a, paths, calls)
      return
    case 'unary':
      collect(node.arg, paths, calls)
      return
    case 'binary':
      collect(node.l, paths, calls)
      collect(node.r, paths, calls)
      return
    case 'cond':
      collect(node.test, paths, calls)
      collect(node.yes, paths, calls)
      collect(node.no, paths, calls)
      return
  }
}

const cache = new Map<string, Expr>()

export function compileExpr(source: string): Expr {
  const hit = cache.get(source)
  if (hit) return hit
  const node = parse(source)
  const paths = new Set<string>()
  const calls = new Set<string>()
  collect(node, paths, calls)
  const expr: Expr = { source, node, paths: [...paths], calls: [...calls] }
  cache.set(source, expr)
  return expr
}

export function evalExpr(expr: Expr, env: Env): unknown {
  return evaluate(expr.node, env, expr.source)
}

export function evalNumber(expr: Expr, env: Env): number {
  return num(evalExpr(expr, env), expr.source)
}

export function evalBool(expr: Expr, env: Env): boolean {
  return truthy(evalExpr(expr, env))
}

/**
 * Text with `{expression}` placeholders. Literal braces are written `{{` and `}}`.
 */
export interface Template {
  readonly source: string
  readonly parts: ReadonlyArray<string | Expr>
}

export function compileTemplate(source: string): Template {
  const parts: Array<string | Expr> = []
  let buf = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '{' && source[i + 1] === '{') {
      buf += '{'
      i += 2
    } else if (ch === '}' && source[i + 1] === '}') {
      buf += '}'
      i += 2
    } else if (ch === '{') {
      const end = source.indexOf('}', i)
      if (end < 0) throw new ExprError('Unclosed {', source)
      if (buf) parts.push(buf)
      buf = ''
      parts.push(compileExpr(source.slice(i + 1, end)))
      i = end + 1
    } else {
      buf += ch
      i++
    }
  }
  if (buf) parts.push(buf)
  return { source, parts }
}

export function renderTemplate(template: Template, env: Env): string {
  let out = ''
  for (const part of template.parts) {
    if (typeof part === 'string') {
      out += part
    } else {
      const v = evalExpr(part, env)
      if (v === null || v === undefined) throw new ExprError(`Placeholder {${part.source}} produced nothing`, template.source)
      out += typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v)
    }
  }
  return out
}
