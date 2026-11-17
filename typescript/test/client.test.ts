import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { BuildCheckError, PapertradeClient, ValidationError, type OrderStatus } from "../src/index.js";
import { TYPED_DATA_CHUNK, fakeSite } from "./site.js";
import { loadSpec } from "./spec.js";

// Public Hardhat test keys.
const master = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const session = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86da7f6a2da9a4b6e3fd34c1d0b4");
const snapshot = loadSpec("vectors/fixtures/sse_open_close.json").events[0];

const enc = new TextEncoder();
const frame = (data: unknown) => enc.encode(`event: wallet\ndata: ${JSON.stringify(data)}\n\n`);

interface ExchangeOpts {
  /** What POST /intents does. Return a Response, or undefined for the default 201. */
  onPost?: (body: any) => Response | undefined | Promise<Response | undefined>;
  /** Push the fill to the stream before answering the POST. */
  fillBeforeResponse?: boolean;
  fill?: boolean;
}

/** Fake exchange: frontend for the build check, SSE stream, POST /intents. */
function fakeExchange(opts: ExchangeOpts = {}) {
  let push: ((chunk: Uint8Array) => void) | undefined;
  let rev = snapshot.accountRevision as number;
  const posts: any[] = [];
  const fillFor = (body: any, intentId: Hex) => {
    const s = body.signed;
    const delta = body.action === "openPosition"
      ? { addedPositions: [["777", Number(s.instrumentId), s.isLong, s.useDebt, "800000", s.size, Number(s.leverage), "792400", Date.now(), intentId]] }
      : { removedPositionIds: [], closedPositions: [] };
    push?.(frame({ accountRevision: rev + 1, baseAccountRevision: rev, state: {}, ...delta, intentOutcomes: [[intentId, "succeeded"]] }));
    rev++;
  };
  const fetch = fakeSite(async (url, init) => {
    if (url.pathname === "/state/user/live") {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          push = (c) => ctrl.enqueue(c);
          ctrl.enqueue(frame(snapshot));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/intents" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ body, headers: init.headers });
      const custom = await opts.onPost?.(body);
      if (custom) return custom;
      // Server computes the same intentId; the test reads it from the client side via the observer.
      return undefined;
    }
    return undefined;
  });
  return { fetch, posts, fillFor };
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof PapertradeClient>[0]> = {}) {
  const log: [OrderStatus, Hex][] = [];
  const client = new PapertradeClient({
    user: master.address, sessionKey: session, master, fetch: fetchImpl,
    observer: (p, status) => void log.push([status, p.intentId]),
    ...extra,
  });
  return { client, log };
}

describe("PapertradeClient", () => {
  it("open → accepted → succeeded via stream, even when the fill arrives before the HTTP response", async () => {
    let fillFor: (body: any, id: Hex) => void = () => {};
    const ex = fakeExchange({
      onPost: async (body) => {
        const id = currentId!;
        fillFor(body, id); // stream first
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ intentId: id, action: body.action, state: "queued", acceptedAt: 1, queueRevision: "1" }), { status: 201 });
      },
    });
    fillFor = ex.fillFor;
    let currentId: Hex | undefined;
    const { client, log } = makeClient(ex.fetch);
    const prepared = await client.prepareOpen({ instrument: "BTC", isLong: true, margin: "10", leverage: 100 });
    currentId = prepared.intentId;
    const res = await client.submitAndWait(prepared, { timeoutMs: 2000 });
    client.close();

    expect(res.status).toBe("succeeded");
    expect(res.submit.status).toBe("accepted");
    expect(res.fill?.status === "succeeded" && res.fill.position?.positionId).toBe("777");
    expect(log.map(([s]) => s)).toEqual(["prepared", "accepted", "succeeded"]);
    const sent = ex.posts[0];
    expect(sent.body.action).toBe("openPosition");
    expect(sent.body.signed.size).toBe("10000000000000000000");
    expect(sent.body.signed.user).toBe(master.address.toLowerCase());
    expect(sent.headers["X-Papertrade-Build"]).toBe("e465c69ba182");
  });

  it("4xx → rejected, 5xx and intentId mismatch → unknown", async () => {
    const statuses: Response[] = [
      new Response(JSON.stringify({ error: "unauthorized_intent" }), { status: 400 }),
      new Response("upstream", { status: 503 }),
      new Response(JSON.stringify({ intentId: "0x" + "00".repeat(32), state: "queued" }), { status: 201 }),
    ];
    const ex = fakeExchange({ onPost: () => statuses.shift() });
    const { client } = makeClient(ex.fetch);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await client.submit(await client.prepareClose(["1"]))).status);
    expect(results).toEqual(["rejected", "unknown", "unknown"]);
  });

  it("refuses to sign when the live typed-data changed", async () => {
    const changed = TYPED_DATA_CHUNK.replace("papertrade:intent-id:v2", "papertrade:intent-id:v3");
    const { client } = makeClient(fakeSite(() => undefined, changed));
    await expect(client.prepareClose(["1"])).rejects.toBeInstanceOf(BuildCheckError);
  });

  it("validates inputs locally", async () => {
    const { client } = makeClient(fakeSite());
    await expect(client.prepareOpen({ instrument: 0, isLong: true, margin: "9.77", leverage: 100 })).rejects.toThrow(/margin below/);
    await expect(client.prepareOpen({ instrument: 0, isLong: true, margin: "10", leverage: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.prepareClose([])).rejects.toThrow(/empty/);
    await expect(client.prepareClose(["1", "1"])).rejects.toThrow(/unique/);
    await expect(client.prepareClose(Array.from({ length: 13 }, (_, i) => i))).rejects.toThrow(/at most 12/);
    await expect(client.prepareCancel(("0x" + "11".repeat(32)) as Hex)).rejects.toThrow(/allowInferred/);
    const noKey = new PapertradeClient({ user: master.address, fetch: fakeSite() });
    await expect(noKey.prepareClose(["1"])).rejects.toThrow(/sessionKey signer/);
  });

  it("session key registration is signed by the master wallet with a zero builder by default", async () => {
    const { client } = makeClient(fakeSite(), { now: () => 1_792_588_763_000 });
    const p = await client.prepareRegisterSessionKey({ key: session.address });
    expect(p.signer).toBe(master.address);
    expect(p.body.signed.feeAddress).toBe("0x0000000000000000000000000000000000000000");
    expect(p.body.signed.expiry).toBe(String(1_792_588_763 + 2_592_000));
    expect(p.body.signed.deadline).toBe(String(1_792_588_763 + 3600));
  });
});
