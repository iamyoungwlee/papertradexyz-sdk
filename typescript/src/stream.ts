/**
 * `GET /state/user/live?wallet=` SSE: snapshot/delta merge, tuple decoding, fill detection, reconnects.
 * Spec: spec/stream.json, spec/sdk-policy.md.
 *
 * Keep ONE stream per wallet: reopening it repeatedly gets HTTP 429.
 */
import type { Address, Hex } from "viem";
import { MAINNET, type PapertradeNetwork } from "./constants.js";
import { DEFAULT_USER_AGENT } from "./build.js";
import { HttpError, PapertradeError } from "./errors.js";
import { parseRetryAfter } from "./http.js";

export type Tuple = readonly unknown[];

/** Raw wallet state as the server sends it. Unknown fields are kept. */
export interface WalletState {
  accountRevision: number;
  openPositions: Tuple[];
  operations: Tuple[];
  [key: string]: unknown;
}

export interface MergeResult {
  kind: "snapshot" | "delta";
  state: WalletState;
  addedPositions: Tuple[];
  closedPositions: Tuple[];
  intentOutcomes: Tuple[];
}

/** The event cannot be applied; the connection must be dropped and reopened. */
export class StreamProtocolError extends PapertradeError {}

const idOf = (t: Tuple): string => String(t[0]);

function asTuples(v: unknown, key: string): Tuple[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((t) => Array.isArray(t) && (typeof t[0] === "string" || typeof t[0] === "number"))) {
    throw new StreamProtocolError(`${key}: expected tuple[] with a string/number id at [0]`);
  }
  return v as Tuple[];
}

function asIds(v: unknown, key: string): Set<string> {
  if (v === undefined) return new Set();
  if (!Array.isArray(v)) throw new StreamProtocolError(`${key}: expected array`);
  return new Set(v.map(String));
}

function assertUnique(items: Tuple[], key: string): void {
  if (new Set(items.map(idOf)).size !== items.length) throw new StreamProtocolError(`${key}: duplicate ids`);
}

/**
 * Apply one `wallet` event to the current state (pure; inputs are not mutated).
 * A delta has a `state` key. Gaps, non-increasing revisions, deltas before a snapshot and duplicate ids throw.
 */
export function mergeWalletEvent(cur: WalletState | null, ev: Record<string, unknown>): MergeResult {
  if (typeof ev.accountRevision !== "number") throw new StreamProtocolError("missing accountRevision");

  if (!("state" in ev)) {
    const openPositions = asTuples(ev.openPositions, "openPositions");
    const operations = asTuples(ev.operations, "operations");
    if (!("openPositions" in ev) || !("operations" in ev)) throw new StreamProtocolError("incomplete snapshot");
    assertUnique(openPositions, "openPositions");
    assertUnique(operations, "operations");
    return {
      kind: "snapshot",
      state: { ...ev, accountRevision: ev.accountRevision, openPositions: [...openPositions], operations: [...operations] },
      addedPositions: [],
      closedPositions: [],
      intentOutcomes: [],
    };
  }

  if (!cur) throw new StreamProtocolError("delta before snapshot");
  if (ev.baseAccountRevision !== cur.accountRevision) {
    throw new StreamProtocolError(`revision gap: base ${String(ev.baseAccountRevision)} != current ${cur.accountRevision}`);
  }
  if (ev.accountRevision <= cur.accountRevision) throw new StreamProtocolError("non-increasing accountRevision");
  const patch = ev.state;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new StreamProtocolError("state: expected object");

  const added = asTuples(ev.addedPositions, "addedPositions");
  const addedOps = asTuples(ev.addedOperations, "addedOperations");
  const closedPositions = asTuples(ev.closedPositions, "closedPositions");
  const intentOutcomes = asTuples(ev.intentOutcomes, "intentOutcomes");
  const rmPos = asIds(ev.removedPositionIds, "removedPositionIds");
  const rmOps = asIds(ev.removedOperationIds, "removedOperationIds");

  const state: WalletState = { ...cur, ...(patch as object), accountRevision: ev.accountRevision } as WalletState;
  if ("lifetime" in ev) state.lifetime = ev.lifetime;
  state.openPositions = [...cur.openPositions.filter((p) => !rmPos.has(idOf(p))), ...added];
  state.operations = [...cur.operations.filter((o) => !rmOps.has(idOf(o))), ...addedOps];
  assertUnique(state.openPositions, "openPositions");
  assertUnique(state.operations, "operations");
  return { kind: "delta", state, addedPositions: added, closedPositions, intentOutcomes };
}

// ---------------------------------------------------------------------------------------------- tuple decoding

const big = (v: unknown, k: string): bigint => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new StreamProtocolError(`${k}: expected integer, got ${JSON.stringify(v)}`);
};
const num = (v: unknown, k: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new StreamProtocolError(`${k}: expected number`);
  return n;
};
const bool = (v: unknown, k: string): boolean => {
  if (typeof v !== "boolean") throw new StreamProtocolError(`${k}: expected boolean`);
  return v;
};
const str = (v: unknown, k: string): string => {
  if (typeof v !== "string") throw new StreamProtocolError(`${k}: expected string`);
  return v;
};
const nullable = <T>(v: unknown, f: (v: unknown, k: string) => T, k: string): T | null => (v === null ? null : f(v, k));

export interface OpenPosition {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  useDebt: boolean;
  /** price × priceScale */
  entryPriceRaw: bigint;
  /** USD, 18 decimals */
  marginRaw: bigint;
  leverage: number;
  /** Use this instead of computing a bust price. */
  bustPriceRaw: bigint;
  openedAtMs: number;
  intentId: Hex;
  raw: Tuple;
}

export function decodeOpenPosition(t: Tuple): OpenPosition {
  return {
    positionId: String(t[0]),
    instrumentId: num(t[1], "instrumentId"),
    isLong: bool(t[2], "isLong"),
    useDebt: bool(t[3], "useDebt"),
    entryPriceRaw: big(t[4], "entryPriceRaw"),
    marginRaw: big(t[5], "marginRaw"),
    leverage: num(t[6], "leverage"),
    bustPriceRaw: big(t[7], "bustPriceRaw"),
    openedAtMs: num(t[8], "openedAtMs"),
    intentId: str(t[9], "intentId").toLowerCase() as Hex,
    raw: t,
  };
}

export interface Operation {
  intentId: Hex;
  action: string;
  /** null for closePositions */
  instrumentId: number | null;
  isLong: boolean | null;
  useDebt: boolean | null;
  marginRaw: bigint | null;
  leverage: number | null;
  acceptedAtMs: number;
  /** Unix seconds */
  deadline: number;
  /** Only for closePositions. */
  positionIds: string[] | null;
  raw: Tuple;
}

export function decodeOperation(t: Tuple): Operation {
  const ids = t[9];
  if (ids !== null && !Array.isArray(ids)) throw new StreamProtocolError("positionIds: expected array or null");
  return {
    intentId: str(t[0], "intentId").toLowerCase() as Hex,
    action: str(t[1], "action"),
    instrumentId: nullable(t[2], num, "instrumentId"),
    isLong: nullable(t[3], bool, "isLong"),
    useDebt: nullable(t[4], bool, "useDebt"),
    marginRaw: nullable(t[5], big, "marginRaw"),
    leverage: nullable(t[6], num, "leverage"),
    acceptedAtMs: num(t[7], "acceptedAtMs"),
    deadline: num(t[8], "deadline"),
    positionIds: ids === null || ids === undefined ? null : ids.map(String),
    raw: t,
  };
}

export interface ClosedPosition {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  marginRaw: bigint;
  leverage: number;
  /** true = liquidated (incl. a set-2 close filled at/past the bust price). */
  liquidated: boolean;
  /** Settled PnL after all haircuts and fees, 18 decimals, may be negative. Authoritative. */
  netPnlRaw: bigint;
  paperMintedRaw: bigint;
  raw: Tuple;
}

export function decodeClosedPosition(t: Tuple): ClosedPosition {
  return {
    positionId: String(t[0]),
    instrumentId: num(t[1], "instrumentId"),
    isLong: bool(t[2], "isLong"),
    marginRaw: big(t[3], "marginRaw"),
    leverage: num(t[4], "leverage"),
    liquidated: bool(t[5], "liquidated"),
    netPnlRaw: big(t[6], "netPnlRaw"),
    paperMintedRaw: big(t[7], "paperMintedRaw"),
    raw: t,
  };
}

export interface SessionKeyInfo {
  address: Address;
  /** Unix seconds */
  expiry: number;
}

export function decodeSessionKey(t: Tuple): SessionKeyInfo {
  return { address: str(t[0], "address").toLowerCase() as Address, expiry: num(t[1], "expiry") };
}

export interface IntentOutcome {
  intentId: Hex;
  /** "succeeded" is the only value observed so far; anything else is passed through untouched. */
  outcome: string;
}

export function decodeIntentOutcome(t: Tuple): IntentOutcome {
  return { intentId: str(t[0], "intentId").toLowerCase() as Hex, outcome: str(t[1], "outcome") };
}

// ---------------------------------------------------------------------------------------------- SSE parsing

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  private started = false;

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    if (!this.started && this.buf.length) {
      this.started = true;
      if (this.buf.charCodeAt(0) === 0xfeff) this.buf = this.buf.slice(1); // leading BOM
    }
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      // A lone trailing \r may be the first half of \r\n; wait for more input.
      if (this.buf[nl] === "\r" && sepLen === 1 && nl === this.buf.length - 1) break;
      this.buf = this.buf.slice(nl + sepLen);
      if (line === "") {
        if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id ? { id: this.id } : {}) });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------- WalletStream

export type IntentWaitResult =
  | {
      status: "succeeded";
      intentId: Hex;
      outcome: string;
      /** Open: the position the intent created. */
      position?: OpenPosition;
      /**
       * Close: settled positions of this intent seen so far. Check `liquidated`: a set-2 close filled at or past
       * the bust price settles as a liquidation even though the intent succeeded.
       */
      closedPositions?: ClosedPosition[];
    }
  /** An outcome other than "succeeded" (not yet observed in the wild); raw value preserved. */
  | { status: "unknown"; intentId: Hex; outcome: string }
  /** No result before timeout / stop. Does NOT mean the intent failed. */
  | { status: "unknown"; intentId: Hex; outcome: null };

export interface WalletStreamEvents {
  connected: () => void;
  disconnected: (reason: unknown) => void;
  /** After every applied snapshot or delta. */
  state: (state: WalletState, result: MergeResult) => void;
  positionOpened: (position: OpenPosition) => void;
  positionClosed: (position: ClosedPosition) => void;
  intentOutcome: (outcome: IntentOutcome) => void;
  error: (error: unknown) => void;
}

export interface WalletStreamOptions {
  wallet: Address;
  network?: PapertradeNetwork;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Reconnect when nothing (not even a heartbeat) arrives for this long. Default 45 s. */
  heartbeatTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Remembered intent results, for waiters registered after the event arrived. Default 10 000. */
  maxRememberedIntents?: number;
}

type Listeners = { [K in keyof WalletStreamEvents]: Set<WalletStreamEvents[K]> };
type IntentRecord = { outcome: string; position?: OpenPosition | undefined; closed?: ClosedPosition[] | undefined };

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

export class WalletStream {
  readonly wallet: Address;
  /** Last applied state, or null before the first snapshot. */
  state: WalletState | null = null;

  private readonly opts: Required<Omit<WalletStreamOptions, "network" | "fetch" | "wallet">> & { network: PapertradeNetwork; fetch: typeof fetch };
  private readonly listeners: Listeners = {
    connected: new Set(), disconnected: new Set(), state: new Set(), positionOpened: new Set(),
    positionClosed: new Set(), intentOutcome: new Set(), error: new Set(),
  };
  private running = false;
  private generation = 0;
  private abort: AbortController | undefined;
  private readonly results = new Map<string, IntentRecord>();
  private readonly waiters = new Map<string, Set<(r: IntentWaitResult) => void>>();
  /** close intentId -> positionIds, from operations */
  private readonly closeIntents = new Map<string, string[]>();
  /** positionId -> settlement */
  private readonly closedById = new Map<string, ClosedPosition>();

  constructor(options: WalletStreamOptions) {
    this.wallet = options.wallet.toLowerCase() as Address;
    this.opts = {
      network: options.network ?? MAINNET,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      maxRememberedIntents: options.maxRememberedIntents ?? 10_000,
    };
  }

  on<K extends keyof WalletStreamEvents>(type: K, listener: WalletStreamEvents[K]): () => void {
    (this.listeners[type] as Set<WalletStreamEvents[K]>).add(listener);
    return () => (this.listeners[type] as Set<WalletStreamEvents[K]>).delete(listener);
  }

  private emit<K extends keyof WalletStreamEvents>(type: K, ...args: Parameters<WalletStreamEvents[K]>): void {
    for (const l of this.listeners[type]) {
      try {
        (l as (...a: unknown[]) => void)(...args);
      } catch (e) {
        if (type !== "error") this.emit("error", e);
      }
    }
  }

  get openPositions(): OpenPosition[] {
    return (this.state?.openPositions ?? []).map(decodeOpenPosition);
  }

  get operations(): Operation[] {
    return (this.state?.operations ?? []).map(decodeOperation);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run(++this.generation);
  }

  /** Close the connection. Pending `waitForIntent` calls resolve as unknown. */
  stop(): void {
    this.running = false;
    this.generation++;
    this.abort?.abort();
    for (const [id, set] of this.waiters) for (const r of set) r({ status: "unknown", intentId: id as Hex, outcome: null });
    this.waiters.clear();
  }

  /**
   * Resolve when the stream reports a result for `intentId`.
   * Register before POSTing when possible; results that already arrived are also returned.
   */
  waitForIntent(intentId: Hex, timeoutMs = 60_000, signal?: AbortSignal): Promise<IntentWaitResult> {
    const id = intentId.toLowerCase() as Hex;
    const known = this.results.get(id);
    if (known) return Promise.resolve(this.toResult(id, known));
    const unknown: IntentWaitResult = { status: "unknown", intentId: id, outcome: null };
    if (signal?.aborted) return Promise.resolve(unknown);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const onAbort = () => done(unknown);
      const done = (r: IntentWaitResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve(r);
      };
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(done);
    });
  }

  private toResult(id: Hex, r: IntentRecord): IntentWaitResult {
    return r.outcome === "succeeded"
      ? {
          status: "succeeded", intentId: id, outcome: r.outcome,
          ...(r.position ? { position: r.position } : {}),
          ...(r.closed?.length ? { closedPositions: r.closed } : {}),
        }
      : { status: "unknown", intentId: id, outcome: r.outcome };
  }

  private closedFor(intentId: Hex): ClosedPosition[] | undefined {
    const ids = this.closeIntents.get(intentId);
    const found = ids?.map((pid) => this.closedById.get(pid)).filter((c): c is ClosedPosition => !!c);
    return found?.length ? found : undefined;
  }

  private record(intentId: Hex, outcome: string, position?: OpenPosition): void {
    const prev = this.results.get(intentId);
    // Never downgrade a success; attach details if they arrive later.
    const entry: IntentRecord = {
      outcome: prev?.outcome === "succeeded" ? prev.outcome : outcome,
      position: position ?? prev?.position,
      closed: this.closedFor(intentId) ?? prev?.closed,
    };
    remember(this.results, intentId, entry, this.opts.maxRememberedIntents);
    if (prev?.outcome === "succeeded") return; // waiters were already resolved
    const set = this.waiters.get(intentId);
    if (set) for (const w of [...set]) w(this.toResult(intentId, entry));
  }

  /** Apply one parsed `wallet` payload. Exposed for tests and custom transports. */
  handleWalletEvent(ev: Record<string, unknown>, connState: { current: WalletState | null }): MergeResult {
    const result = mergeWalletEvent(connState.current, ev);
    // Decode everything before committing so a malformed tuple rejects the whole event.
    const opened = (result.kind === "snapshot" ? result.state.openPositions : result.addedPositions).map(decodeOpenPosition);
    const ops = (result.kind === "snapshot" ? result.state.operations : asTuples(ev.addedOperations, "addedOperations")).map(decodeOperation);
    const closed = result.closedPositions.map(decodeClosedPosition);
    const outcomes = result.intentOutcomes.map(decodeIntentOutcome);

    connState.current = result.state;
    this.state = result.state;
    this.emit("state", result.state, result);
    const max = this.opts.maxRememberedIntents;
    for (const op of ops) if (op.positionIds) remember(this.closeIntents, op.intentId, op.positionIds, max);
    for (const c of closed) remember(this.closedById, c.positionId, c, max);
    // Positions first, so a waiter resolved by the outcome in the same event also gets the position.
    for (const p of opened) {
      // An open position carrying our intentId proves the open filled.
      this.record(p.intentId, "succeeded", p);
      if (result.kind === "delta") this.emit("positionOpened", p);
    }
    for (const o of outcomes) {
      this.record(o.intentId, o.outcome);
      this.emit("intentOutcome", o);
    }
    for (const c of closed) this.emit("positionClosed", c);
    return result;
  }

  private async run(gen: number): Promise<void> {
    let attempt = 0;
    const url = `${this.opts.network.apiUrl}/state/user/live?wallet=${this.wallet}`;
    while (this.running && gen === this.generation) {
      const ctrl = new AbortController();
      this.abort = ctrl;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const kick = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ctrl.abort(new Error("heartbeat timeout")), this.opts.heartbeatTimeoutMs);
      };
      let retryAfterMs: number | undefined;
      let reason: unknown;
      let connectedAt: number | undefined;
      try {
        kick();
        const res = await this.opts.fetch(url, {
          headers: { accept: "text/event-stream", "user-agent": this.opts.userAgent, "cache-control": "no-cache" },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const ra = parseRetryAfter(res.headers.get("retry-after"));
          if (ra !== undefined) retryAfterMs = ra * 1000;
          throw new HttpError({ url, status: res.status, body: await res.text().catch(() => undefined), retryAfter: ra });
        }
        connectedAt = Date.now();
        this.emit("connected");
        // Each connection starts from its own snapshot; revisions reset on reconnect.
        const connState: { current: WalletState | null } = { current: null };
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        // Not every fetch implementation cancels the body on abort; make sure a pending read() returns.
        const cancel = () => void reader.cancel(ctrl.signal.reason).catch(() => {});
        if (ctrl.signal.aborted) cancel();
        else ctrl.signal.addEventListener("abort", cancel, { once: true });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          if (gen !== this.generation) return;
          kick();
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (gen !== this.generation) return; // a listener stopped or restarted the stream
            if (msg.event !== "wallet") continue; // liveness / heartbeat only feed the watchdog
            let payload: unknown;
            try {
              payload = JSON.parse(msg.data);
            } catch {
              throw new StreamProtocolError("wallet event is not JSON");
            }
            if (!payload || typeof payload !== "object") throw new StreamProtocolError("wallet event is not an object");
            const r = this.handleWalletEvent(payload as Record<string, unknown>, connState);
            // A snapshot alone is not proof of health (snapshot + bad delta would loop fast and hit 429).
            if (r.kind === "delta") attempt = 0;
          }
        }
      } catch (e) {
        reason = ctrl.signal.aborted && ctrl.signal.reason ? ctrl.signal.reason : e;
        if (this.running && gen === this.generation) this.emit("error", reason);
      } finally {
        clearTimeout(watchdog);
        ctrl.abort();
      }
      if (gen !== this.generation) return;
      if (connectedAt !== undefined && Date.now() - connectedAt > 60_000) attempt = 0; // long healthy connection
      this.emit("disconnected", reason);
      const backoff = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectBaseMs * 2 ** attempt++);
      await new Promise((r) => setTimeout(r, Math.max(retryAfterMs ?? 0, backoff / 2 + Math.random() * (backoff / 2))));
    }
  }
}
