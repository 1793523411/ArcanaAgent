import { describe, it, expect } from "vitest";
import { evaluate, validateExpression } from "./expression.js";

describe("expression.evaluate", () => {
  const ctx = { format: "pdf", count: 5, tags: ["a", "b"] };

  it("eq resolves ${vars}", () => {
    expect(evaluate({ eq: ["${format}", "pdf"] }, ctx)).toBe(true);
    expect(evaluate({ eq: ["${format}", "html"] }, ctx)).toBe(false);
  });
  it("neq", () => {
    expect(evaluate({ neq: ["${format}", "html"] }, ctx)).toBe(true);
  });
  it("gt/lt coerce numeric strings", () => {
    expect(evaluate({ gt: ["${count}", 3] }, ctx)).toBe(true);
    expect(evaluate({ lt: ["${count}", 3] }, ctx)).toBe(false);
  });
  it("in checks membership", () => {
    expect(evaluate({ in: ["${format}", ["html", "pdf"]] }, ctx)).toBe(true);
    expect(evaluate({ in: ["${format}", ["html", "md"]] }, ctx)).toBe(false);
  });
  it("exists checks non-empty", () => {
    expect(evaluate({ exists: "format" }, ctx)).toBe(true);
    expect(evaluate({ exists: "nope" }, ctx)).toBe(false);
  });
  it("and/or/not compose", () => {
    expect(
      evaluate(
        { and: [{ eq: ["${format}", "pdf"] }, { gt: ["${count}", 0] }] },
        ctx,
      ),
    ).toBe(true);
    expect(evaluate({ or: [{ eq: ["${format}", "html"] }, { exists: "tags" }] }, ctx)).toBe(true);
    expect(evaluate({ not: { eq: ["${format}", "html"] } }, ctx)).toBe(true);
  });
  it("validateExpression flags unknown ops and malformed shapes", () => {
    expect(validateExpression({ wat: [1, 2] })).toHaveLength(1);
    expect(validateExpression({ eq: [1] })).toHaveLength(1);
    expect(validateExpression({ and: { nope: true } })).toHaveLength(1);
    expect(validateExpression({ eq: [1, 2] })).toEqual([]);
  });
});
