export class PapertradeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input rejected locally before signing or sending. */
export class ValidationError extends PapertradeError {}

/** An `inferred` action was used without `allowInferred: true`. */
export class InferredActionError extends PapertradeError {}

/** Known `error` codes of `POST /intents` (spec/endpoints.md). Other strings are passed through. */
export type IntentErrorCode =
  | "deadline_expired"
  | "unauthorized_intent"
  | "intent_conflict"
  | "admission_rejected"
  | "below_minimum_paper_stake"
  | "below_minimum_withdrawal"
  | "invalid_onward"
  | "intake_action_paused"
  | "rate_limited";

/** Non-2xx HTTP response. Keeps the raw body so nothing the server said is lost. */
export class HttpError extends PapertradeError {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | undefined;
  /** Seconds, from `Retry-After`. */
  readonly retryAfter: number | undefined;
  readonly url: string;

  constructor(args: { url: string; status: number; body: unknown; retryAfter?: number | undefined }) {
    const code = extractCode(args.body);
    super(`HTTP ${args.status} from ${args.url}${code ? ` (${code})` : ""}`);
    this.url = args.url;
    this.status = args.status;
    this.body = args.body;
    this.code = code;
    this.retryAfter = args.retryAfter;
  }
}

/** The request may or may not have reached the server (timeout, connection reset, unparsable response). */
export class TransportError extends PapertradeError {}

/** Live build differs from what the signing scheme was verified against, or could not be discovered. */
export class BuildCheckError extends PapertradeError {
  constructor(
    message: string,
    /**
     * mismatch: the bundle's signing scheme differs (confirmed incompatible).
     * discovery_failed: the build or typed-data chunk could not be fetched.
     * extraction_failed: the chunk was fetched but could not be parsed (compatibility not established either way).
     */
    readonly reason: "mismatch" | "discovery_failed" | "extraction_failed",
    readonly liveBuild?: string,
  ) {
    super(message);
  }
}

function extractCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
      return (e as { code: string }).code;
    }
  }
  return undefined;
}
