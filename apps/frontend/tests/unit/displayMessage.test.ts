import { describe, it, expect } from "vitest";
import { interpretDisplayMessage } from "../../src/app/displayMessage";

describe("interpretDisplayMessage", () => {
  it("accepts a valid diagram and carries its seq", () => {
    const out = interpretDisplayMessage({ seq: 5, action: {
      op: "show", id: "d1", type: "diagram",
      data: { mode: "graph", nodes: [{ id: "a", label: "A" }], edges: [] } } });
    expect(out.result.ok).toBe(true);
    expect(out.seq).toBe(5);
  });

  it("rejects a bad action and still reports its seq", () => {
    const out = interpretDisplayMessage({ seq: 6, action: {
      op: "show", id: "d2", type: "diagram", data: { mode: "not-graph" } } });
    expect(out.result.ok).toBe(false);
    expect(out.seq).toBe(6);
  });
});
