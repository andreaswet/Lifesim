import { describe, expect, it } from 'vitest'
import { ExprError, compileExpr, compileTemplate, evalBool, evalExpr, evalNumber, renderTemplate, type Env } from '../src/engine/core/expr'

const env: Env = {
  vars: { self: { age: 34, sex: 'female', flag: { met: true }, nothing: null }, world: { month: 3 }, fact: { name: 'Elin', n: 2.5 } },
  fns: { max: ((a: number, b: number) => Math.max(a, b)) as never, has: ((id: string) => id === 'flu') as never, span: ((m: number) => `${m} months`) as never },
}
const run = (src: string): unknown => evalExpr(compileExpr(src), env)

describe('expression language', () => {
  it('respects precedence and associativity', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('10 - 4 - 3')).toBe(3)
    expect(run('-2 * 3')).toBe(-6)
    expect(run('7 % 4')).toBe(3)
    expect(run('1 < 2 && 2 < 3 || false')).toBe(true)
    expect(run('!(1 < 2)')).toBe(false)
    expect(run('1 < 2 ? "yes" : "no"')).toBe('yes')
    expect(run('false ? 1 : true ? 2 : 3')).toBe(2)
  })

  it('reads accessors and calls functions', () => {
    expect(run('self.age >= 30 && self.sex == "female"')).toBe(true)
    expect(run("self.flag.met ? 'a' : 'b'")).toBe('a')
    expect(run('max(self.age, 40) + world.month')).toBe(43)
    expect(run("has('flu') && !has('cold')")).toBe(true)
    expect(evalNumber(compileExpr('self.age % 10'), env)).toBe(4)
    expect(evalBool(compileExpr('self.age % 10 == 4'), env)).toBe(true)
  })

  it('treats reading through something absent as null, not as an error', () => {
    expect(run('self.nothing.deeper')).toBe(null)
    expect(run('self.missing == null')).toBe(true)
    expect(run('fact.lastShared != null')).toBe(false)
  })

  it('reports content mistakes with the expression in the message', () => {
    expect(() => compileExpr('1 +')).toThrow(ExprError)
    expect(() => compileExpr('a b')).toThrow(ExprError)
    expect(() => compileExpr("'unterminated")).toThrow(ExprError)
    expect(() => compileExpr('1 # 2')).toThrow(ExprError)
    expect(() => run('unknown + 1')).toThrow(/Unknown name 'unknown'/)
    expect(() => run('nope(1)')).toThrow(/Unknown function 'nope'/)
    expect(() => run('self.sex * 2')).toThrow(/Expected a number/)
  })

  it('lists the paths and functions an expression uses', () => {
    const e = compileExpr("self.age > 3 && has('x') ? fact.name : world.month + max(1, self.flag.met)")
    expect([...e.paths].sort()).toEqual(['fact.name', 'self.age', 'self.flag.met', 'world.month'])
    expect([...e.calls].sort()).toEqual(['has', 'max'])
  })

  it('never evaluates code', () => {
    expect(() => compileExpr('constructor.constructor("return 1")()')).toThrow(ExprError)
    expect(() => run('self.constructor')).not.toThrow()
    expect(() => compileExpr('a = 1')).toThrow(ExprError)
  })

  it('renders templates with placeholders and escaped braces', () => {
    const t = compileTemplate('{fact.name} is {self.age}, and waited {span(6)}. {{literal}} {fact.n}')
    expect(renderTemplate(t, env)).toBe('Elin is 34, and waited 6 months. {literal} 2.5')
    expect(() => compileTemplate('broken {self.age')).toThrow(ExprError)
    expect(() => renderTemplate(compileTemplate('{self.nothing}'), env)).toThrow(/produced nothing/)
  })
})
