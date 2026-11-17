import { describe, expect, it } from "vitest";
import { formatPrice, formatUsd, parsePrice, parseUnits, parseUsd, usdcToWad, wadToUsdc } from "../src/index.js";

describe("units", () => {
  it("parses decimal strings exactly", () => {
    expect(parseUsd("10")).toBe(10n * 10n ** 18n);
    expect(parseUsd("0.1")).toBe(10n ** 17n);
    expect(parseUsd(10)).toBe(10n * 10n ** 18n);
    expect(parseUnits("-1.5", 2)).toBe(-150n);
  });

  it("rejects floats and excess precision", () => {
    expect(() => parseUsd(0.1)).toThrow(/decimal strings/);
    expect(() => parseUnits("1.234", 2)).toThrow(/fractional/);
    expect(() => parseUsd("1e3")).toThrow();
  });

  it("formats", () => {
    expect(formatUsd(155658016138493807n)).toBe("0.155658016138493807");
    expect(formatUsd(-(10n ** 18n))).toBe("-1");
  });

  it("prices use priceScale", () => {
    expect(parsePrice("83773.5", 0)).toBe(837735n);
    expect(parsePrice("3000.25", 1)).toBe(300025n);
    expect(formatPrice("837735", 0)).toBe("83773.5");
    expect(() => parsePrice("83773.55", 0)).toThrow();
  });

  it("usdc conversion", () => {
    expect(wadToUsdc(parseUsd("1.5"))).toBe(1_500_000n);
    expect(usdcToWad(1_500_000n)).toBe(parseUsd("1.5"));
    expect(() => wadToUsdc(1n)).toThrow();
  });
});
