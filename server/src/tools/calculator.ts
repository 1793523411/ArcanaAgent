import { tool } from "@langchain/core/tools";
import { z } from "zod";

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if ("+-*/()%^".includes(expr[i])) { tokens.push(expr[i]); i++; continue; }
    if (/[\d.]/.test(expr[i])) {
      let num = "";
      while (i < expr.length && /[\d.]/.test(expr[i])) { num += expr[i]; i++; }
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Invalid number: ${num}`);
      tokens.push(num);
      continue;
    }
    throw new Error(`Invalid character: ${expr[i]}`);
  }
  return tokens;
}

function safeEvaluate(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseExpr(): number {
    let left = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = consume();
      const right = parseUnary();
      if ((op === "/" || op === "%") && right === 0) throw new Error("Division by zero");
      left = op === "*" ? left * right : op === "/" ? left / right : left % right;
    }
    return left;
  }

  function parseUnary(): number {
    if (peek() === "-") { consume(); return -parsePower(); }
    if (peek() === "+") { consume(); return parsePower(); }
    return parsePower();
  }

  function parsePower(): number {
    let base = parsePrimary();
    while (peek() === "^") {
      consume();
      const exp = parseUnary();
      base = Math.pow(base, exp);
    }
    return base;
  }

  function parsePrimary(): number {
    if (peek() === "(") {
      consume();
      const val = parseExpr();
      if (peek() !== ")") throw new Error("Missing closing parenthesis");
      consume();
      return val;
    }
    const token = consume();
    if (token === undefined) throw new Error("Unexpected end of expression");
    const num = Number(token);
    if (isNaN(num)) throw new Error(`Unexpected token: ${token}`);
    return num;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token: ${tokens[pos]}`);
  if (!isFinite(result)) throw new Error("Result is not finite");
  return result;
}

export const calculator = tool(
  (input: { expression: string }) => {
    try {
      return String(safeEvaluate(input.expression));
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : "invalid expression"}`;
    }
  },
  {
    name: "calculator",
    description: "Evaluate a math expression safely. Supports + - * / % ^ ( ). Example: (3+5)*2^3",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate, e.g. (3+5)*2"),
    }),
  }
);
