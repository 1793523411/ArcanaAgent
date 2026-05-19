/**
 * Minimal expression DSL for pipeline `when` predicates. Deliberately tiny so
 * templates stay declarative and serializable — complex logic should fall back
 * to the Planner (requirement-kind tasks).
 *
 * Operands: literal JSON values, or strings containing ${var} placeholders
 * resolved from the evaluation context (pipeline inputs, later step outputs).
 *
 * Operators: eq / neq / exists / in / gt / lt / and / or / not.
 */

export type Expression =
  | { eq: [unknown, unknown] }
  | { neq: [unknown, unknown] }
  | { gt: [unknown, unknown] }
  | { lt: [unknown, unknown] }
  | { in: [unknown, unknown[]] }
  | { exists: string }
  | { and: Expression[] }
  | { or: Expression[] }
  | { not: Expression };

export type ExpressionContext = Record<string, unknown>;

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/** Resolve a single operand: interpolates ${var} against context, else returns as-is. */
function resolve(operand: unknown, ctx: ExpressionContext): unknown {
  if (typeof operand !== "string") return operand;
  const whole = operand.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}$/);
  if (whole) {
    return lookup(ctx, whole[1]);
  }
  return operand.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g, (_, path: string) => {
    const v = lookup(ctx, path);
    return v === undefined || v === null ? "" : String(v);
  });
}

function lookup(ctx: ExpressionContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

export function evaluate(expr: Expression | undefined, ctx: ExpressionContext): boolean {
  if (expr === undefined) return true;
  if (expr === null || typeof expr !== "object") {
    throw new ExpressionError("Expression must be an object");
  }
  if ("eq" in expr) {
    const [a, b] = expr.eq;
    return resolve(a, ctx) === resolve(b, ctx);
  }
  if ("neq" in expr) {
    const [a, b] = expr.neq;
    return resolve(a, ctx) !== resolve(b, ctx);
  }
  if ("gt" in expr) {
    const a = asNumber(resolve(expr.gt[0], ctx));
    const b = asNumber(resolve(expr.gt[1], ctx));
    return a !== null && b !== null && a > b;
  }
  if ("lt" in expr) {
    const a = asNumber(resolve(expr.lt[0], ctx));
    const b = asNumber(resolve(expr.lt[1], ctx));
    return a !== null && b !== null && a < b;
  }
  if ("in" in expr) {
    const [needle, haystack] = expr.in;
    if (!Array.isArray(haystack)) return false;
    const resolvedNeedle = resolve(needle, ctx);
    return haystack.some((h) => resolve(h, ctx) === resolvedNeedle);
  }
  if ("exists" in expr) {
    const v = lookup(ctx, expr.exists);
    return v !== undefined && v !== null && v !== "";
  }
  if ("and" in expr) return expr.and.every((e) => evaluate(e, ctx));
  if ("or" in expr) return expr.or.some((e) => evaluate(e, ctx));
  if ("not" in expr) return !evaluate(expr.not, ctx);
  throw new ExpressionError(`Unknown operator in expression: ${Object.keys(expr).join(",")}`);
}

/** Structural validation — returns error messages (empty when valid). */
export function validateExpression(expr: unknown, path = ""): string[] {
  const errs: string[] = [];
  if (expr === null || typeof expr !== "object" || Array.isArray(expr)) {
    errs.push(`${path || "expression"} 必须是对象`);
    return errs;
  }
  const keys = Object.keys(expr as object);
  if (keys.length !== 1) {
    errs.push(`${path || "expression"} 必须只有一个操作符键`);
    return errs;
  }
  const op = keys[0];
  const val = (expr as Record<string, unknown>)[op];
  switch (op) {
    case "eq":
    case "neq":
    case "gt":
    case "lt":
      if (!Array.isArray(val) || val.length !== 2) {
        errs.push(`${path}.${op} 必须是 [a, b]`);
      }
      break;
    case "in":
      if (!Array.isArray(val) || val.length !== 2 || !Array.isArray(val[1])) {
        errs.push(`${path}.in 必须是 [needle, [haystack...]]`);
      }
      break;
    case "exists":
      if (typeof val !== "string") errs.push(`${path}.exists 必须是字符串`);
      break;
    case "and":
    case "or":
      if (!Array.isArray(val)) errs.push(`${path}.${op} 必须是数组`);
      else val.forEach((sub, i) => errs.push(...validateExpression(sub, `${path}.${op}[${i}]`)));
      break;
    case "not":
      errs.push(...validateExpression(val, `${path}.not`));
      break;
    default:
      errs.push(`${path || "expression"} 未知操作符: ${op}`);
  }
  return errs;
}
