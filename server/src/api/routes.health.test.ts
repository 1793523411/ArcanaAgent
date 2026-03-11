import { describe, it, expect, vi } from "vitest";
import { getHealth } from "./routes.js";

describe("getHealth", () => {
  it("returns 200 with status ok", () => {
    const res = {
      json: vi.fn(),
    };
    getHealth({} as any, res as any);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
  });
});
