import { describe, expect, it } from "vitest";
import { parseHandoffFromSummary, parseStructuredOutput } from "./handoffParser.js";

describe("parseStructuredOutput", () => {
  it("parses a valid pipeline-output fence", () => {
    const raw = "Done.\n```pipeline-output\n{ \"items\": [1,2,3], \"format\": \"html\" }\n```";
    expect(parseStructuredOutput(raw)).toEqual({ items: [1, 2, 3], format: "html" });
  });
  it("returns null when fence missing", () => {
    expect(parseStructuredOutput("no fence here")).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    expect(parseStructuredOutput("```pipeline-output\n{ bad json }\n```")).toBeNull();
  });
  it("rejects non-object roots (array)", () => {
    expect(parseStructuredOutput("```pipeline-output\n[1,2,3]\n```")).toBeNull();
  });
});

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
