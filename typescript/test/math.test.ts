import { describe, expect, it } from "vitest";
import { estimateClosePnl, estimateClosePnlRange, contractSetAt, type ClosePnlBreakdown } from "../src/index.js";
import { loadSpec } from "./spec.js";

const vectors = loadSpec("vectors/pnl.json");
const tol = vectors.tolerance;

function close(actual: number, expected: number, rel: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, rel * Math.abs(expected)));
}

describe("spec/vectors/pnl.json", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const { contractSet, curve, ...rest } = c.input;
      const r = estimateClosePnl({ ...rest, contractSet, curve: curve ?? undefined });
      for (const [k, v] of Object.entries(c.expected)) {
        const a = r[k as keyof ClosePnlBreakdown];
        if (v === null || typeof v === "boolean") expect(a, k).toBe(v);
        else close(a as number, v as number, tol.expected);
      }
      for (const [k, v] of Object.entries(c.observed ?? {})) {
        if (k === "source") continue;
        const a = r[k as keyof ClosePnlBreakdown] as number;
        const isRaw = String(v).replace(/^-?\d*\.?/, "").length > 4;
        if (isRaw) close(a, v as number, tol.observedRaw);
        else expect(Math.abs(a - (v as number))).toBeLessThanOrEqual(tol.observedRounded);
      }
    });
  }
});

describe("helpers", () => {
  it("range returns both curves", () => {
    const r = estimateClosePnlRange({ instrumentId: 0, isLong: true, margin: 10, leverage: 100, entryPrice: 80000, exitPrice: 80027 });
    expect(r.netPnlMin).toBeLessThanOrEqual(r.netPnlMax);
    expect([r.standard.netPnl, r.offHours.netPnl]).toContain(r.netPnlMin);
  });
  it("set 2 without curve throws", () => {
    expect(() => estimateClosePnl({ instrumentId: 0, isLong: true, margin: 10, leverage: 100, entryPrice: 1, exitPrice: 2 })).toThrow(/curve/);
  });
  it("contractSetAt picks set by execution time", () => {
    expect(contractSetAt(Date.parse("2026-10-21T13:19:00Z"))).toBe(1);
    expect(contractSetAt(Date.parse("2026-10-21T22:00:02Z"))).toBe(2);
  });
});
