import { describe, expect, it } from "vitest";
import { parseHandoffFromSummary } from "./handoffParser.js";

describe("parseHandoffFromSummary", () => {
  it("extracts fenced handoff json", () => {
    const raw = [
      "Did the backend part.",
      "```handoff",
      JSON.stringify({
        summary: "Added /users endpoint",
        artifacts: [{ kind: "file", ref: "api/users.ts", description: "handler" }],
        inputsConsumed: ["subtask_001"],
        openQuestions: ["auth scope?"],
      }),
      "```",
    ].join("\n");

    const h = parseHandoffFromSummary(raw);
    expect(h).not.toBeNull();
    expect(h?.summary).toBe("Added /users endpoint");
    expect(h?.artifacts).toHaveLength(1);
    expect(h?.artifacts[0].kind).toBe("file");
    expect(h?.inputsConsumed).toEqual(["subtask_001"]);
    expect(h?.openQuestions).toEqual(["auth scope?"]);
  });

  it("falls back to plain summary when no fence is present", () => {
    const h = parseHandoffFromSummary("Just finished the task. No json here.");
    expect(h).not.toBeNull();
    expect(h?.summary).toContain("Just finished");
    expect(h?.artifacts).toEqual([]);
  });

  it("handles malformed json by degrading to summary", () => {
    const raw = "```handoff\n{summary: not-json}\n```";
    const h = parseHandoffFromSummary(raw);
    expect(h).not.toBeNull();
    expect(h?.artifacts).toEqual([]);
  });

  it("returns null on empty input", () => {
    expect(parseHandoffFromSummary("")).toBeNull();
  });

  it("drops artifacts with invalid kind", () => {
    const raw = "```handoff\n" + JSON.stringify({
      summary: "x",
      artifacts: [
        { kind: "file", ref: "a.ts" },
        { kind: "bogus", ref: "b.ts" },
      ],
    }) + "\n```";
    const h = parseHandoffFromSummary(raw);
    expect(h?.artifacts).toHaveLength(1);
    expect(h?.artifacts[0].ref).toBe("a.ts");
  });
});
