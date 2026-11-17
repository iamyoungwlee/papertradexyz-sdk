/**
 * REST transport. GETs retry with exponential backoff + jitter and honor Retry-After.
 * Intent POSTs are never retried automatically (spec/sdk-policy.md): a lost response does not prove the
 * intent was not accepted.
 */
import { BUILD_HEADER, MAINNET, type PapertradeNetwork } from "./constants.js";
import { DEFAULT_USER_AGENT } from "./build.js";
import { HttpError, TransportError } from "./errors.js";
import type { IntentRequestBody } from "./typed-data.js";
import type { Hex } from "viem";

export type QueryValue = string | number | bigint | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export interface HttpOptions {
  network?: PapertradeNetwork;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** GET retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt with full jitter. Default 500 ms. */
  backoffBaseMs?: number;
  /** Value or provider for the `X-Papertrade-Build` header sent on write requests. */
  buildId?: string | (() => Promise<string | undefined> | string | undefined);
}

/** Observed `POST /intents` 201 response. Unknown fields kept as-is. */
export interface IntentAccepted {
  intentId: Hex;
  action: string;
  state: string;
  acceptedAt: unknown;
  queueRevision: unknown;
  [extra: string]: unknown;
}

/** Sorted keys, undefined/null dropped. The API rejects unknown/unsorted query keys on some routes. */
export function canonicalQuery(query: Query = {}): string {
  const parts = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After header (seconds or HTTP-date) → seconds. */
export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, (t - Date.now()) / 1000);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class HttpClient {
  readonly network: PapertradeNetwork;
  private readonly f: typeof fetch;
  private readonly ua: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly buildId: HttpOptions["buildId"];

  constructor(opts: HttpOptions = {}) {
    this.network = opts.network ?? MAINNET;
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.ua = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.buildId = opts.buildId;
  }

  url(path: string, query?: Query): string {
    return `${this.network.apiUrl}${path.startsWith("/") ? path : `/${path}`}${canonicalQuery(query)}`;
  }

  /** Request + full body read under one timeout. Any failure here means the outcome is unknown. */
  private async send(url: string, init: RequestInit): Promise<{ res: Response; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
    const timedOut = new Promise<never>((_, reject) =>
      ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason), { once: true }),
    );
    try {
      const res = await Promise.race([this.f(url, { ...init, signal: ctrl.signal }), timedOut]);
      // Not every fetch aborts a pending body read; race it against the timer as well.
      const body = await Promise.race([readBody(res), timedOut]);
      return { res, body };
    } catch (e) {
      throw new TransportError(`${init.method ?? "GET"} ${url} failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
    } finally {
      clearTimeout(timer);
      timedOut.catch(() => {});
    }
  }

  /** GET returning parsed JSON (untyped: most REST shapes are not pinned down, see spec/responses.md). */
  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    for (let attempt = 0; ; attempt++) {
      let wait: number | undefined;
      try {
        const { res, body } = await this.send(url, { method: "GET", headers: { "user-agent": this.ua, accept: "application/json" } });
        if (res.ok) return body as T;
        const err = new HttpError({ url, status: res.status, body, retryAfter: parseRetryAfter(res.headers.get("retry-after")) });
        if (!(res.status === 429 || res.status >= 500) || attempt >= this.maxRetries) throw err;
        wait = err.retryAfter !== undefined ? err.retryAfter * 1000 : undefined;
      } catch (e) {
        if (!(e instanceof TransportError) || attempt >= this.maxRetries) throw e;
      }
      await sleep(wait ?? Math.random() * this.backoffBaseMs * 2 ** attempt);
    }
  }

  private async resolveBuildId(): Promise<string | undefined> {
    return typeof this.buildId === "function" ? await this.buildId() : this.buildId;
  }

  /**
   * POST once, no retry.
   * - non-2xx response → HttpError (the server answered; the intent was not accepted)
   * - network failure / timeout → TransportError (outcome unknown; do not resend with a new nonce)
   */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = this.url(path);
    const headers: Record<string, string> = {
      "user-agent": this.ua,
      accept: "application/json",
      "content-type": "application/json",
    };
    const build = await this.resolveBuildId();
    if (build) headers[BUILD_HEADER] = build;
    const { res, body: parsed } = await this.send(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new HttpError({ url, status: res.status, body: parsed, retryAfter: parseRetryAfter(res.headers.get("retry-after")) });
    return parsed as T;
  }

  postIntent(body: IntentRequestBody): Promise<IntentAccepted> {
    return this.post<IntentAccepted>("/intents", body);
  }
}
