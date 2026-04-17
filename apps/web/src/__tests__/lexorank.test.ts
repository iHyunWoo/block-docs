import { describe, it, expect } from "vitest";
import { midpoint } from "@/lib/lexorank";

describe("midpoint (LexoRank)", () => {
  it("produces a value between two distant ranks", () => {
    const m = midpoint("a", "z");
    expect(m > "a" && m < "z").toBe(true);
  });

  it("produces a value between adjacent ranks by extending", () => {
    const m = midpoint("m", "n");
    expect(m > "m" && m < "n").toBe(true);
  });

  it("handles a null prev (insert at start)", () => {
    const m = midpoint(null, "m");
    expect(m < "m").toBe(true);
  });

  it("handles a null next (append)", () => {
    const m = midpoint("m", null);
    expect(m > "m").toBe(true);
  });

  it("handles both null (first ever)", () => {
    const m = midpoint(null, null);
    expect(m.length).toBeGreaterThan(0);
  });

  it("is stable for repeated insertion between same two keys", () => {
    let prev = "a";
    const next = "z";
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const k = midpoint(prev, next);
      expect(k > prev).toBe(true);
      expect(k < next).toBe(true);
      keys.push(k);
      prev = k;
    }
    // All keys sort in insertion order.
    expect([...keys].sort()).toEqual(keys);
  });
});
