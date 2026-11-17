/**
 * Close PnL estimate (spec/math.md). Floating point, relative error target 1e-9.
 * This is an estimate: the authoritative settled value is `closedPosition.netPnlRaw` from the SSE stream.
 */
import { SETTLEMENT, getInstrument, type PayoutCurveName } from "./constants.js";
import { ValidationError } from "./errors.js";

export interface ClosePnlInput {
  instrumentId: number;
  isLong: boolean;
  /** USD */
  margin: number;
  leverage: number;
  entryPrice: number;
  exitPrice: number;
  /** Session key was registered with an approved builder (`feeAddress`). Set 2 only. */
  builder?: boolean;
  /**
   * Bust price from the stream (`openPositions[].bustPriceRaw / priceScale`). Do not compute it yourself;
   * the exact formula is unknown. Set 2 settles a close at or past this price as a liquidation.
   */
  bustPrice?: number | null;
  /** Exchange implementation; defaults to 2 (current). Use `contractSetAt()` for historical trades. */
  contractSet?: 1 | 2;
  /**
   * Payout curve picked by the off-hours keeper. Required for set 2 because the current curve cannot be read;
   * use `estimateClosePnlRange` when unknown. Ignored for set 1.
   */
  curve?: PayoutCurveName;
}

export interface ClosePnlBreakdown {
  rawPnl: number;
  /** Favorable price move before deadband, as a fraction. null when not a profitable close. */
  priceMove: number | null;
  holdback: number;
  /** Move after deadband and holdback. null when not a profitable close. */
  move: number | null;
  /** Impact scale. null when not a profitable close. */
  scale: number | null;
  adjustedPnl: number;
  winFee: number;
  builderFee: number;
  netPnl: number;
  liquidated: boolean;
}

/** Holdback fraction of the payout curve at `priceMove`. 0 outside the band. */
export function payoutHoldback(priceMove: number, curve: PayoutCurveName | null): number {
  if (curve === null) return 0;
  const c = SETTLEMENT.payoutCurves[curve];
  const start = c.startPpm / 1e6;
  const end = c.endPpm / 1e6;
  if (!(start < priceMove && priceMove < end)) return 0;
  const width = end - start;
  const u = (priceMove - start) / width;
  return c.holdback * width * u ** 2 * (1 - u) ** c.fallPower;
}

/** Deadband in price units: floor(entryPriceRaw / 50000) / priceScale. */
export function deadband(instrumentId: number, entryPrice: number): number {
  const scale = getInstrument(instrumentId).priceScale;
  return Math.floor(Math.round(entryPrice * scale) / SETTLEMENT.deadbandDivisor) / scale;
}

function check(input: ClosePnlInput): void {
  for (const k of ["margin", "leverage", "entryPrice", "exitPrice"] as const) {
    if (!Number.isFinite(input[k]) || input[k] <= 0) throw new ValidationError(`${k} must be a positive number`);
  }
}

export function estimateClosePnl(input: ClosePnlInput): ClosePnlBreakdown {
  check(input);
  const set = input.contractSet ?? 2;
  if (set === 2 && !input.curve) throw new ValidationError("curve is required for contract set 2; use estimateClosePnlRange when unknown");
  const curve = set === 1 ? null : input.curve!;
  const builder = set === 2 && !!input.builder;
  const bust = set === 2 ? input.bustPrice ?? null : null;

  const { impact: p } = getInstrument(input.instrumentId);
  const { isLong, margin, entryPrice: entry, exitPrice: exit } = input;
  const notional = margin * input.leverage;
  const raw = (notional * (isLong ? exit - entry : entry - exit)) / entry;
  const out: ClosePnlBreakdown = {
    rawPnl: raw, priceMove: null, holdback: 0, move: null, scale: null,
    adjustedPnl: raw, winFee: 0, builderFee: 0, netPnl: raw, liquidated: false,
  };

  if (bust !== null && (isLong ? exit <= bust : exit >= bust)) {
    // Hard liquidation: whole margin lost, no fees.
    return { ...out, adjustedPnl: -margin, netPnl: -margin, liquidated: true };
  }
  if (raw <= 0) return out;

  const db = deadband(input.instrumentId, entry);
  const exitAdj = isLong ? exit - db : exit + db;
  const priceMove = (isLong ? exit - entry : entry - exit) / entry;
  const hb = payoutHoldback(priceMove, curve);
  const move = (isLong ? exitAdj - entry : entry - exitAdj) / entry - hb;
  Object.assign(out, { priceMove, holdback: hb, move });
  if (move <= 0) return { ...out, scale: 0, adjustedPnl: 0, netPnl: 0 };

  const t1 = 1 / (move * p.rateMultiplier);
  const t2 = p.referenceNotional / (1e6 * move * p.positionMultiplier);
  const scale = (1 - p.baseRate) / (1 + t1 + t2);
  const adj = notional * move * scale;
  const winFee = adj * SETTLEMENT.winFee;
  const builderFee = builder ? adj * SETTLEMENT.builderFee : 0;
  return { ...out, scale, adjustedPnl: adj, winFee, builderFee, netPnl: adj - winFee - builderFee };
}

/** Both payout curves, since the one in force cannot be read. `netPnl` bounds are min/max of the two. */
export function estimateClosePnlRange(input: Omit<ClosePnlInput, "curve" | "contractSet">): {
  standard: ClosePnlBreakdown;
  offHours: ClosePnlBreakdown;
  netPnlMin: number;
  netPnlMax: number;
} {
  const standard = estimateClosePnl({ ...input, contractSet: 2, curve: "standard" });
  const offHours = estimateClosePnl({ ...input, contractSet: 2, curve: "offHours" });
  return {
    standard,
    offHours,
    netPnlMin: Math.min(standard.netPnl, offHours.netPnl),
    netPnlMax: Math.max(standard.netPnl, offHours.netPnl),
  };
}

/** Zero-equity price entry × (1 ∓ 1/leverage). The displayed bust price is ~4.8–5 bps inside this (inferred). */
export function zeroEquityPrice(isLong: boolean, entryPrice: number, leverage: number): number {
  return entryPrice * (isLong ? 1 - 1 / leverage : 1 + 1 / leverage);
}
