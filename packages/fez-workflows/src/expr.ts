/**
 * Tiny condition evaluator for step `if:` expressions — Buzz uses Rust's
 * evalexpr; the JS equivalents either eval-adjacent or unmaintained, and
 * the needed grammar is small, so fez owns it. Vocabulary:
 *
 *   trigger.text matches "urgent|asap"
 *   trigger.author_name == "researcher" && !(trigger.text contains "draft")
 *
 * Values: single/double-quoted strings, numbers, true/false, and dotted
 * variable names. Operators (by precedence): ! · == != < <= > >=
 * matches contains · && · ||. `matches` is a case-insensitive regex
 * test, `contains` a substring test. No assignment, no calls, no
 * property access on objects — variables resolve from a flat map, so
 * there is nothing to inject into.
 */

export type ExprValue = string | number | boolean;

type Token =
  | { kind: "value"; value: ExprValue }
  | { kind: "var"; name: string }
  | { kind: "op"; op: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end < 0) throw new Error(`unterminated string at ${i}`);
      tokens.push({ kind: "value", value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "op", op: two });
      i += 2;
      continue;
    }
    if ("!<>()".includes(ch)) {
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    const num = input.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num) {
      tokens.push({ kind: "value", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = input.slice(i).match(/^[A-Za-z_][\w.]*/);
    if (word) {
      const w = word[0];
      if (w === "true" || w === "false") tokens.push({ kind: "value", value: w === "true" });
      else if (w === "matches" || w === "contains") tokens.push({ kind: "op", op: w });
      else tokens.push({ kind: "var", name: w });
      i += w.length;
      continue;
    }
    throw new Error(`unexpected character "${ch}" at ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private vars: Record<string, ExprValue>) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private takeOp(...ops: string[]): string | undefined {
    const t = this.peek();
    if (t?.kind === "op" && ops.includes(t.op)) {
      this.pos++;
      return t.op;
    }
    return undefined;
  }

  parse(): ExprValue {
    const value = this.or();
    if (this.pos < this.tokens.length) throw new Error(`unexpected trailing input`);
    return value;
  }

  private or(): ExprValue {
    let left = this.and();
    while (this.takeOp("||")) left = truthy(left) || truthy(this.and());
    return left;
  }
  private and(): ExprValue {
    let left = this.unary();
    while (this.takeOp("&&")) left = truthy(left) && truthy(this.unary());
    return left;
  }
  private unary(): ExprValue {
    if (this.takeOp("!")) return !truthy(this.unary());
    return this.comparison();
  }
  private comparison(): ExprValue {
    const left = this.term();
    const op = this.takeOp("==", "!=", "<", "<=", ">", ">=", "matches", "contains");
    if (!op) return left;
    const right = this.term();
    switch (op) {
      case "==": return compare(left, right) === 0;
      case "!=": return compare(left, right) !== 0;
      case "<": return compare(left, right) < 0;
      case "<=": return compare(left, right) <= 0;
      case ">": return compare(left, right) > 0;
      case ">=": return compare(left, right) >= 0;
      case "matches": return new RegExp(String(right), "i").test(String(left));
      case "contains": return String(left).toLowerCase().includes(String(right).toLowerCase());
      default: throw new Error(`unreachable`);
    }
  }
  private term(): ExprValue {
    if (this.takeOp("(")) {
      const inner = this.or();
      if (!this.takeOp(")")) throw new Error(`missing ")"`);
      return inner;
    }
    const t = this.peek();
    if (t?.kind === "value") { this.pos++; return t.value; }
    if (t?.kind === "var") {
      this.pos++;
      const v = this.vars[t.name];
      if (v === undefined) throw new Error(`unknown variable "${t.name}"`);
      return v;
    }
    throw new Error(`expected a value`);
  }
}

function truthy(v: ExprValue): boolean {
  return typeof v === "string" ? v.length > 0 : Boolean(v);
}

function compare(a: ExprValue, b: ExprValue): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const [sa, sb] = [String(a), String(b)];
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Evaluate an `if:` expression to a boolean. Throws on syntax errors or unknown variables. */
export function evalCondition(expr: string, vars: Record<string, ExprValue>): boolean {
  return truthy(new Parser(tokenize(expr), vars).parse());
}
