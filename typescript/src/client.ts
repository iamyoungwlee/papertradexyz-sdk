/**
 * High-level client: prepare (validate + sign) → submit → confirm via the wallet stream.
 *
 * Order states follow spec/sdk-policy.md:
 *   prepared  signed, body and intentId known (persist it now)
 *   accepted  HTTP 201 with a matching intentId; NOT a fill
 *   succeeded the stream reported the intent as succeeded
 *   rejected  the server explicitly refused the submission
 *   unknown   anything ambiguous: transport failure, intentId mismatch, unsupported outcome, timeout
 */
import { isAddress, type Address, type Hex } from "viem";
import { ACTIONS, LIMITS, MAINNET, getInstrument, getInstrumentByName, type ActionName, type PapertradeNetwork } from "./constants.js";
import { checkLiveBuild, type BuildInfo, type CompatibilityResult } from "./build.js";
import { BuildCheckError, HttpError, TransportError, ValidationError } from "./errors.js";
import { HttpClient, type HttpOptions, type IntentAccepted, type Query } from "./http.js";
import { randomNonce } from "./nonce.js";
import { WalletStream, type IntentWaitResult, type WalletStreamOptions } from "./stream.js";
import { signIntent, type MessageInput, type SignedIntent, type TypedDataSigner } from "./typed-data.js";
import { parseUsd } from "./units.js";

export type OrderStatus = "prepared" | "accepted" | "succeeded" | "rejected" | "unknown";

export interface PreparedIntent extends SignedIntent {
  nonce: bigint | undefined;
  /** Unix seconds */
  deadline: bigint;
  createdAtMs: number;
}

export interface SubmitResult {
  status: Extract<OrderStatus, "accepted" | "rejected" | "unknown">;
  intentId: Hex;
  response?: IntentAccepted;
  error?: unknown;
}

export interface OrderResult {
  status: Exclude<OrderStatus, "prepared">;
  intentId: Hex;
  submit: SubmitResult;
  fill?: IntentWaitResult;
}

/** Called with every state change. Persist `prepared` before the request goes out. */
export type IntentObserver = (intent: PreparedIntent, status: OrderStatus, detail?: unknown) => void | Promise<void>;

export interface PapertradeClientOptions extends Omit<HttpOptions, "buildId"> {
  /** Master wallet address (the `user` of every intent). */
  user: Address;
  /** Signs open/close/cancel. Required for trading. */
  sessionKey?: TypedDataSigner;
  /** Signs registerSessionKey and master-signed actions. Only needed for those. */
  master?: TypedDataSigner;
  /**
   * Before signing, verify that the live frontend's typed-data matches this SDK (default true).
   * Disable only if you have verified the scheme yourself.
   */
  checkBuild?: boolean;
  /** Re-run the build check after this long. Default 10 min. */
  buildRefreshMs?: number;
  /** Fixed `X-Papertrade-Build` value. Default: the id found by the build check. */
  buildId?: string;
  /** Allow `inferred` actions (cancel, withdraw, staking). */
  allowInferred?: boolean;
  /** Skip local min-margin / max-notional checks (those limits are themselves partly inferred). */
  skipLimitChecks?: boolean;
  observer?: IntentObserver;
  stream?: Omit<WalletStreamOptions, "wallet" | "network" | "fetch" | "userAgent">;
  /** Clock override for tests (ms). */
  now?: () => number;
}

export interface OpenParams {
  /** Instrument id or symbol ("BTC", "ETH"). */
  instrument: number | string;
  isLong: boolean;
  /** USD margin as a decimal string (e.g. "10" or "12.5"). This is the signed `size`, not the notional. */
  margin: string | bigint;
  leverage: number;
  useDebt?: boolean;
}

export class PapertradeClient {
  readonly network: PapertradeNetwork;
  readonly http: HttpClient;
  readonly user: Address;
  private readonly opts: PapertradeClientOptions;
  private buildState: { checkedAtMs: number; info: BuildInfo & CompatibilityResult } | undefined;
  private buildPending: Promise<BuildInfo & CompatibilityResult> | undefined;
  private walletStream: WalletStream | undefined;

  constructor(opts: PapertradeClientOptions) {
    this.opts = opts;
    this.network = opts.network ?? MAINNET;
    this.user = opts.user.toLowerCase() as Address;
    this.http = new HttpClient({ ...opts, network: this.network, buildId: () => opts.buildId ?? this.buildState?.info.buildId });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // ------------------------------------------------------------------------------------------ build check

  /** Run (or reuse a fresh) build check. Throws BuildCheckError when signing would be unsafe. */
  async ensureBuild(): Promise<(BuildInfo & CompatibilityResult) | undefined> {
    if (this.opts.checkBuild === false) return undefined;
    const fresh = this.buildState && this.now() - this.buildState.checkedAtMs < (this.opts.buildRefreshMs ?? 600_000);
    if (!fresh) {
      this.buildPending ??= checkLiveBuild({ network: this.network, fetch: this.opts.fetch, userAgent: this.opts.userAgent }).finally(() => {
        this.buildPending = undefined;
      });
      const info = await this.buildPending;
      this.buildState = { checkedAtMs: this.now(), info };
    }
    const info = this.buildState!.info;
    if (!info.compatible) {
      throw new BuildCheckError(`live build ${info.buildId} changed the signing scheme: ${info.differences.join("; ")}`, "mismatch", info.buildId);
    }
    return info;
  }

  // ------------------------------------------------------------------------------------------ prepare

  /** Validate and sign any action. Prefer the typed helpers below. */
  async prepare(action: ActionName, message: MessageInput, signer: TypedDataSigner): Promise<PreparedIntent> {
    await this.ensureBuild();
    const signed = await signIntent(action, message, signer, { network: this.network, allowInferred: this.opts.allowInferred });
    const prepared: PreparedIntent = {
      ...signed,
      nonce: "nonce" in signed.payload.message ? (signed.payload.message.nonce as bigint) : undefined,
      deadline: signed.payload.message.deadline as bigint,
      createdAtMs: this.now(),
    };
    await this.opts.observer?.(prepared, "prepared");
    return prepared;
  }

  private deadline(): bigint {
    return BigInt(Math.floor(this.now() / 1000) + LIMITS.intentDeadlineSeconds);
  }

  private requireSigner(kind: "sessionKey" | "master"): TypedDataSigner {
    const s = kind === "master" ? this.opts.master : this.opts.sessionKey;
    if (!s) throw new ValidationError(`${kind} signer is required for this action`);
    return s;
  }

  /**
   * Register `key` as a session key (signed by the master wallet).
   * `feeAddress` is a builder code: a non-zero approved builder takes 0.5% of every profitable close.
   */
  async prepareRegisterSessionKey(params: { key: Address; expirySeconds?: number; feeAddress?: Address }): Promise<PreparedIntent> {
    const ttl = params.expirySeconds ?? LIMITS.sessionKeyExpirySeconds;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new ValidationError("expirySeconds must be a positive integer");
    const expiry = BigInt(Math.floor(this.now() / 1000) + ttl);
    return this.prepare(
      "registerSessionKey",
      { user: this.user, key: params.key, expiry, feeAddress: params.feeAddress ?? LIMITS.feeAddressDefault, nonce: randomNonce(), deadline: this.deadline() },
      this.requireSigner("master"),
    );
  }

  async prepareOpen(params: OpenParams): Promise<PreparedIntent> {
    const inst = typeof params.instrument === "number" ? getInstrument(params.instrument) : getInstrumentByName(params.instrument);
    const size = typeof params.margin === "bigint" ? params.margin : parseUsd(params.margin);
    if (!Number.isSafeInteger(params.leverage) || params.leverage < 1) throw new ValidationError("leverage must be a positive integer");
    if (size <= 0n) throw new ValidationError("margin must be positive");
    if (!this.opts.skipLimitChecks) {
      if (size < parseUsd(LIMITS.minMarginUsd)) throw new ValidationError(`margin below ${LIMITS.minMarginUsd} USD`);
      if (size * BigInt(params.leverage) > parseUsd(LIMITS.maxNotionalUsd)) throw new ValidationError(`notional above ${LIMITS.maxNotionalUsd} USD`);
    }
    return this.prepare(
      "openPosition",
      {
        user: this.user, instrumentId: inst.id, isLong: params.isLong, size, leverage: params.leverage,
        useDebt: params.useDebt ?? false, nonce: randomNonce(), deadline: this.deadline(),
      },
      this.requireSigner("sessionKey"),
    );
  }

  async prepareClose(positionIds: readonly (string | bigint | number)[]): Promise<PreparedIntent> {
    // Normalize to bigint first: "01" and "1" are the same id, and unsafe numbers have already lost digits.
    const ids = positionIds.map((id, i) => {
      if (typeof id === "number" && !Number.isSafeInteger(id)) throw new ValidationError(`positionIds[${i}]: ${id} is not a safe integer; pass a string or bigint`);
      if (typeof id === "string" && !/^\d+$/.test(id)) throw new ValidationError(`positionIds[${i}]: not an unsigned integer`);
      const v = BigInt(id);
      if (v < 0n || v >= 1n << 256n) throw new ValidationError(`positionIds[${i}]: out of uint256 range`);
      return v;
    });
    if (!ids.length) throw new ValidationError("positionIds must not be empty");
    if (new Set(ids).size !== ids.length) throw new ValidationError("positionIds must be unique");
    if (ids.length > LIMITS.closeMaxPositionIds) throw new ValidationError(`at most ${LIMITS.closeMaxPositionIds} positionIds per close`);
    return this.prepare(
      "closePositions",
      { user: this.user, positionIds: ids, nonce: randomNonce(), deadline: this.deadline() },
      this.requireSigner("sessionKey"),
    );
  }

  /** inferred: requires `allowInferred`. */
  async prepareCancel(intentId: Hex): Promise<PreparedIntent> {
    return this.prepare("cancel", { user: this.user, intentId, deadline: this.deadline() }, this.requireSigner(ACTIONS.cancel.signer));
  }

  // ------------------------------------------------------------------------------------------ submit

  /**
   * POST the prepared body once. Never retried automatically; to resend, call again with the SAME prepared intent.
   */
  async submit(prepared: PreparedIntent): Promise<SubmitResult> {
    const path = prepared.action === "cancel" ? `/intents/${prepared.payload.message.intentId as string}/cancel` : "/intents";
    let result: SubmitResult;
    try {
      const response = await this.http.post<IntentAccepted>(path, prepared.body);
      const match = typeof response?.intentId === "string" && response.intentId.toLowerCase() === prepared.intentId.toLowerCase();
      result = match
        ? { status: "accepted", intentId: prepared.intentId, response }
        : { status: "unknown", intentId: prepared.intentId, response, error: new ValidationError("server intentId differs from local intentId") };
    } catch (error) {
      if (error instanceof HttpError) result = { status: classifyRejection(error), intentId: prepared.intentId, error };
      else if (error instanceof TransportError) result = { status: "unknown", intentId: prepared.intentId, error };
      else throw error;
    }
    await this.opts.observer?.(prepared, result.status, result.response ?? result.error);
    return result;
  }

  /** Shared wallet stream for `user` (one connection per wallet). Started on first use. */
  stream(): WalletStream {
    if (!this.walletStream) {
      this.walletStream = new WalletStream({
        ...this.opts.stream, wallet: this.user, network: this.network, fetch: this.opts.fetch, userAgent: this.opts.userAgent,
      });
      this.walletStream.start();
    }
    return this.walletStream;
  }

  /**
   * Submit and wait for the fill on the wallet stream. The waiter is registered before the POST because the
   * stream can report the fill before the HTTP response returns.
   */
  async submitAndWait(prepared: PreparedIntent, opts: { timeoutMs?: number } = {}): Promise<OrderResult> {
    const cancelWait = new AbortController();
    const fillPromise = this.stream().waitForIntent(prepared.intentId, opts.timeoutMs ?? 60_000, cancelWait.signal);
    let submit: SubmitResult;
    try {
      submit = await this.submit(prepared);
    } catch (e) {
      cancelWait.abort();
      throw e;
    }
    if (submit.status === "rejected") {
      cancelWait.abort();
      return { status: "rejected", intentId: prepared.intentId, submit };
    }
    // accepted or unknown: the intent may still execute, so keep watching the stream.
    const fill = await fillPromise;
    // A fill seen on the stream wins even if the HTTP response was lost or mismatched.
    const status: OrderResult["status"] = fill.status === "succeeded" ? "succeeded" : "unknown";
    await this.opts.observer?.(prepared, status, fill);
    return { status, intentId: prepared.intentId, submit, fill };
  }

  close(): void {
    this.walletStream?.stop();
    this.walletStream = undefined;
  }

  // ------------------------------------------------------------------------------------------ public reads
  // Response shapes are not pinned down by fixtures yet (spec/responses.md), so these return raw JSON.

  protocolSummary(): Promise<unknown> {
    return this.http.get("/query/protocol/summary");
  }
  marketStats(): Promise<unknown> {
    return this.http.get("/query/protocol/market-stats");
  }
  queueSummary(): Promise<unknown> {
    return this.http.get("/query/protocol/queue-summary");
  }
  /** intervalMs ≥ 125. */
  async priceHistory(instrumentId: number, query: { fromMs: number; toMs: number; intervalMs: number }): Promise<unknown> {
    for (const k of ["fromMs", "toMs", "intervalMs"] as const) {
      if (!Number.isSafeInteger(query[k]) || query[k] < 0) throw new ValidationError(`${k} must be a non-negative integer`);
    }
    if (query.intervalMs < 125) throw new ValidationError("intervalMs must be ≥ 125");
    return this.http.get(`/query/markets/${getInstrument(instrumentId).id}/price-history`, query);
  }
  async liquidationMap(instrumentId: number, query: Query = {}): Promise<unknown> {
    return this.http.get(`/query/markets/${getInstrument(instrumentId).id}/liquidation-map`, query);
  }
  /** `/query/accounts/{addr}/{kind}`. Pagination is manual: required params and cursor rules differ per kind. */
  async accountHistory(kind: string, query: Query = {}, address: Address = this.user): Promise<unknown> {
    if (!/^[\w-]+$/.test(kind)) throw new ValidationError(`invalid kind ${kind}`);
    return this.http.get(`/query/accounts/${checkAddress(address)}/${kind}`, query);
  }
  async accountFunding(address: Address = this.user): Promise<unknown> {
    return this.http.get(`/query/accounts/${checkAddress(address)}/funding`);
  }
  async queueBalances(address: Address = this.user): Promise<unknown> {
    return this.http.get(`/query/accounts/${checkAddress(address)}/queue-balances`);
  }
}

function checkAddress(address: string): string {
  if (!isAddress(address, { strict: false })) throw new ValidationError(`invalid address ${address}`);
  return address.toLowerCase();
}

/** Codes that mean "check what happened to the earlier attempt", not "this order is dead" (spec/sdk-policy.md). */
const AMBIGUOUS_CODES = new Set(["intent_conflict", "deadline_expired"]);
/** Codes that explicitly refuse this submission. */
const REJECTION_CODES = new Set([
  "unauthorized_intent", "admission_rejected", "below_minimum_paper_stake", "below_minimum_withdrawal",
  "invalid_onward", "intake_action_paused", "rate_limited",
]);

/**
 * Map an HTTP error from an intent POST to an order status. Only a recognized refusal is `rejected`;
 * anything that might hide an already-queued or executing intent is `unknown`.
 */
export function classifyRejection(error: HttpError): "rejected" | "unknown" {
  if (error.status >= 500 || error.status === 408) return "unknown";
  if (error.status === 429) return "rejected"; // refused before admission; honor Retry-After
  const code = error.code;
  if (!code || AMBIGUOUS_CODES.has(code)) return "unknown";
  // admission_rejected with reason alreadyQueued: the same intent is already in the queue.
  if (code === "admission_rejected" && JSON.stringify(error.body ?? "").includes("alreadyQueued")) return "unknown";
  return REJECTION_CODES.has(code) ? "rejected" : "unknown";
}
