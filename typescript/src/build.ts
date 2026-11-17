/**
 * Build id discovery and signing-scheme compatibility check (spec/protocol.json → build, spec/README.md "스펙 변경 감지").
 *
 * Papertrade redeploys change the build id. The SDK then re-reads the frontend's `typed-data-*.js` chunk and
 * compares struct types, domain name/version and the intentId salt with what it signs. A mismatch blocks signing.
 */
import { INTENT_ID_SALT, MAINNET, PAPERTRADE_TYPES, type DomainName, type PapertradeNetwork, type PrimaryType } from "./constants.js";
import { BuildCheckError } from "./errors.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export interface BuildInfo {
  buildId: string;
  /** Path of the typed-data chunk, if linked from index.html. */
  typedDataPath: string | undefined;
}

export interface BundleSigningScheme {
  types: Partial<Record<string, { name: string; type: string }[]>>;
  domains: Partial<Record<DomainName, { name: string; version: string }>>;
  salt: string | undefined;
}

export interface CompatibilityResult {
  compatible: boolean;
  /** Human-readable differences, empty when compatible. */
  differences: string[];
}

interface FetchOpts {
  network?: PapertradeNetwork;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
}

async function getText(url: string, opts: FetchOpts): Promise<string> {
  const f = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new BuildCheckError(`GET ${url} timed out after ${timeoutMs} ms`, "discovery_failed"));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([f(url, { headers: { "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT }, signal: ctrl.signal }), timedOut]);
    if (!res.ok) throw new BuildCheckError(`GET ${url} returned ${res.status}`, "discovery_failed");
    return await Promise.race([res.text(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** index.html → /assets/build-*.js → first template literal is the build id. */
export async function discoverBuild(opts: FetchOpts = {}): Promise<BuildInfo> {
  const base = (opts.network ?? MAINNET).apiUrl;
  try {
    const html = await getText(`${base}/`, opts);
    const buildPath = /\/assets\/build-[\w.-]+\.js/.exec(html)?.[0];
    if (!buildPath) throw new BuildCheckError("build-*.js not referenced from index.html", "discovery_failed");
    const js = await getText(base + buildPath, opts);
    const buildId = /`([^`]*)`/.exec(js)?.[1];
    if (!buildId) throw new BuildCheckError(`no build id literal in ${buildPath}`, "discovery_failed");
    return { buildId, typedDataPath: /\/assets\/typed-data-[\w.-]+\.js/.exec(html)?.[0] };
  } catch (e) {
    if (e instanceof BuildCheckError) throw e;
    throw new BuildCheckError(`build discovery failed: ${(e as Error).message}`, "discovery_failed");
  }
}

/** Extract struct types, domains and salt from the minified typed-data chunk. */
export function parseTypedDataChunk(js: string): BundleSigningScheme {
  const types: BundleSigningScheme["types"] = {};
  for (const m of js.matchAll(/(?:^|[{,])(\w+):\[((?:\{name:`[^`]*`,type:`[^`]*`\},?)+)\]/g)) {
    types[m[1]!] = [...m[2]!.matchAll(/\{name:`([^`]*)`,type:`([^`]*)`\}/g)].map((f) => ({ name: f[1]!, type: f[2]! }));
  }
  const domains: BundleSigningScheme["domains"] = {};
  for (const m of js.matchAll(/(exchange|paperStaking|cancellation):\{name:`([^`]*)`,version:`([^`]*)`\}/g)) {
    domains[m[1] as DomainName] = { name: m[2]!, version: m[3]! };
  }
  return { types, domains, salt: /`(papertrade:intent-id:[^`]*)`/.exec(js)?.[1] };
}

/** Compare a parsed bundle with what this SDK signs. */
export function compareSigningScheme(bundle: BundleSigningScheme, network: PapertradeNetwork = MAINNET): CompatibilityResult {
  const diff: string[] = [];
  for (const [name, fields] of Object.entries(PAPERTRADE_TYPES) as [PrimaryType, readonly { name: string; type: string }[]][]) {
    const got = bundle.types[name];
    const want = fields.map((f) => `${f.type} ${f.name}`).join(",");
    if (!got) diff.push(`type ${name} missing from bundle`);
    else if (got.map((f) => `${f.type} ${f.name}`).join(",") !== want) {
      diff.push(`type ${name}: bundle (${got.map((f) => `${f.type} ${f.name}`).join(",")}) != sdk (${want})`);
    }
  }
  for (const key of Object.keys(network.domains) as DomainName[]) {
    const got = bundle.domains[key];
    const want = network.domains[key];
    if (!got) diff.push(`domain ${key} missing from bundle`);
    else if (got.name !== want.name || got.version !== want.version) {
      diff.push(`domain ${key}: bundle ${got.name}/${got.version} != sdk ${want.name}/${want.version}`);
    }
  }
  if (bundle.salt !== INTENT_ID_SALT) diff.push(`intentId salt: bundle ${bundle.salt} != sdk ${INTENT_ID_SALT}`);
  return { compatible: diff.length === 0, differences: diff };
}

/** Discover the live build and verify its signing scheme matches this SDK. */
export async function checkLiveBuild(opts: FetchOpts = {}): Promise<BuildInfo & CompatibilityResult> {
  const info = await discoverBuild(opts);
  if (!info.typedDataPath) {
    throw new BuildCheckError("typed-data chunk not referenced from index.html", "discovery_failed", info.buildId);
  }
  let js: string;
  try {
    js = await getText((opts.network ?? MAINNET).apiUrl + info.typedDataPath, opts);
  } catch (e) {
    if (e instanceof BuildCheckError) throw e;
    throw new BuildCheckError(`typed-data fetch failed: ${(e as Error).message}`, "discovery_failed", info.buildId);
  }
  const parsed = parseTypedDataChunk(js);
  // Nothing recognizable means the parser no longer fits the minified output, not that the scheme changed.
  if (!Object.keys(parsed.types).length || !Object.keys(parsed.domains).length || parsed.salt === undefined) {
    throw new BuildCheckError(
      `could not extract types/domains/salt from ${info.typedDataPath}; signing scheme unverified`,
      "extraction_failed",
      info.buildId,
    );
  }
  return { ...info, ...compareSigningScheme(parsed, opts.network) };
}
