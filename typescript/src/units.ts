/**
 * Decimal ↔ raw integer conversion without going through binary floats.
 *
 * - USD amounts (margin, balances, PnL): 18 decimals ("wad")
 * - HyperEVM USDC: 6 decimals
 * - Prices: raw = price × priceScale (BTC 10, ETH 100)
 */
import { COLLATERAL_EVM_DECIMALS, WAD_DECIMALS, getInstrument } from "./constants.js";
import { ValidationError } from "./errors.js";

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string into an integer with `decimals` fractional digits.
 * Rejects more fractional digits than `decimals` instead of rounding.
 * `number` input is accepted only for safe integers, to keep float error out of raw amounts.
 */
export function parseUnits(value: string | number | bigint, decimals: number): bigint {
  if (typeof value === "bigint") return value * 10n ** BigInt(decimals);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError(`Pass non-integer amounts as decimal strings, got number ${value}`);
    }
    return BigInt(value) * 10n ** BigInt(decimals);
  }
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) throw new ValidationError(`Not a decimal string: ${JSON.stringify(value)}`);
  const [, sign, int, frac = ""] = m;
  if (frac.length > decimals) {
    throw new ValidationError(`${value} has more than ${decimals} fractional digits`);
  }
  const raw = BigInt(int! + frac.padEnd(decimals, "0"));
  return sign ? -raw : raw;
}

/** Format a raw integer as a decimal string, trimming trailing zeros. */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** "10" → 10_000000000000000000n */
export const parseUsd = (value: string | number | bigint): bigint => parseUnits(value, WAD_DECIMALS);
export const formatUsd = (raw: bigint): string => formatUnits(raw, WAD_DECIMALS);

/** Wad (18 decimals) → HyperEVM USDC (6 decimals). Throws if precision would be lost. */
export function wadToUsdc(wad: bigint): bigint {
  const factor = 10n ** BigInt(WAD_DECIMALS - COLLATERAL_EVM_DECIMALS);
  if (wad % factor !== 0n) throw new ValidationError(`${wad} wad is not representable in 6-decimal USDC`);
  return wad / factor;
}

export const usdcToWad = (usdc: bigint): bigint => usdc * 10n ** BigInt(WAD_DECIMALS - COLLATERAL_EVM_DECIMALS);

function scaleDecimals(priceScale: number): number {
  const d = Math.log10(priceScale);
  if (!Number.isInteger(d)) throw new RangeError(`priceScale ${priceScale} is not a power of 10`);
  return d;
}

/** "83773.5" on BTC → 837735n */
export function parsePrice(value: string | number | bigint, instrumentId: number): bigint {
  return parseUnits(value, scaleDecimals(getInstrument(instrumentId).priceScale));
}

export function formatPrice(raw: bigint | string, instrumentId: number): string {
  return formatUnits(BigInt(raw), scaleDecimals(getInstrument(instrumentId).priceScale));
}

/** Lossy conversion for display and estimates only. */
export const rawToNumber = (raw: bigint | string, decimals: number): number => Number(formatUnits(BigInt(raw), decimals));
