// Regression tests for issues found in the first review.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  BuildCheckError,
  HttpClient,
  HttpError,
  PapertradeClient,
  SseParser,
  TransportError,
  WalletStream,
  checkLiveBuild,
  classifyRejection,
  type WalletState,
} from "../src/index.js";
import { fakeSite } from "./site.js";
import { loadSpec } from "./spec.js";

const master = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const session = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86da7f6a2da9a4b6e3fd34c1d0b4");
const fx = loadSpec("vectors/fixtures/sse_open_close.json");
const httpErr = (status: number, body: unknown) => new HttpError({ url: "u", status, body });

describe("submit status classification", () => {
  it("only recognized refusals are rejected", () => {
    expect(classifyRejection(httpErr(400, { error: "unauthorized_intent" }))).toBe("rejected");
    expect(classifyRejection(httpErr(429, { error: "rate_limited" }))).toBe("rejected");
    expect(classifyRejection(httpErr(409, { error: "admission_rejected", reason: "other" }))).toBe("rejected");
  });
  it("ambiguous answers are unknown", () => {
    expect(classifyRejection(httpErr(409, { error: "admission_rejected", reason: "alreadyQueued" }))).toBe("unknown");
    expect(classifyRejection(httpErr(409, { error: "intent_conflict" }))).toBe("unknown");
    expect(classifyRejection(httpErr(400, { error: "deadline_expired" }))).toBe("unknown");
    expect(classifyRejection(httpErr(400, { error: "something_new" }))).toBe("unknown");
    expect(classifyRejection(httpErr(400, "plain text"))).toBe("unknown");
    expect(classifyRejection(httpErr(408, undefined))).toBe("unknown");
    expect(classifyRejection(httpErr(502, undefined))).toBe("unknown");
  });
});

describe("http timeout covers the body", () => {
  it("a stalled body becomes a TransportError", async () => {
    const f = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 201 })) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(new HttpClient({ fetch: f, timeoutMs: 50 }).post("/intents", {})).rejects.toBeInstanceOf(TransportError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("prepareClose id normalization", () => {
  const client = new PapertradeClient({ user: master.address, sessionKey: session, fetch: fakeSite() });
  it("rejects unsafe numbers and treats '01' and '1' as duplicates", async () => {
    await expect(client.prepareClose([12345678901234567890])).rejects.toThrow(/safe integer/);
    await expect(client.prepareClose(["1", "01"])).rejects.toThrow(/unique/);
    await expect(client.prepareClose(["-1"])).rejects.toThrow(/unsigned/);
    const p = await client.prepareClose(["007", 8n]);
    expect(p.body.signed.positionIds).toEqual(["7", "8"]);
  });
});

describe("build check extraction failure", () => {
  it("is reported as extraction_failed, not mismatch", async () => {
    const err = await checkLiveBuild({ fetch: fakeSite(undefined, 'export const x = "something else";') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildCheckError);
    expect((err as BuildCheckError).reason).toBe("extraction_failed");
  });
  it("a stalled frontend times out", async () => {
    const f = (async () => new Promise(() => {})) as unknown as typeof fetch;
    const err = await checkLiveBuild({ fetch: f, timeoutMs: 30 }).catch((e: unknown) => e);
    expect((err as BuildCheckError).reason).toBe("discovery_failed");
  });
});

describe("WalletStream", () => {
  const conn = (): { current: WalletState | null } => ({ current: null });

  it("close results carry the settled positions (liquidation flag)", async () => {
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fakeSite() });
    const c = conn();
    for (const ev of fx.events) ws.handleWalletEvent(ev, c);
    const closeIntent = fx.events[3].addedOperations[0][0] as Hex;
    const r = await ws.waitForIntent(closeIntent, 10);
    expect(r.status).toBe("succeeded");
    if (r.status !== "succeeded") return;
    expect(r.closedPositions?.map((p) => [p.positionId, p.liquidated, p.netPnlRaw])).toEqual([["1000001", false, 155658016138493807n]]);
  });

  it("a malformed operation tuple rejects the whole event", () => {
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fakeSite() });
    const c = conn();
    ws.handleWalletEvent(fx.events[0], c);
    const bad = { accountRevision: 2, baseAccountRevision: 1, state: {}, addedOperations: [["0xabc", 5]] };
    expect(() => ws.handleWalletEvent(bad, c)).toThrow();
    expect(ws.state?.accountRevision).toBe(1);
    expect(() => ws.operations).not.toThrow();
  });

  it("stop() from a listener halts the rest of the chunk", async () => {
    const enc = new TextEncoder();
    const all = fx.events.map((e: unknown) => `event: wallet\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const f = (async () =>
      new Response(new ReadableStream({ start: (ctrl) => ctrl.enqueue(enc.encode(all)) }))) as unknown as typeof fetch;
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: f });
    let seen = 0;
    ws.on("state", () => {
      seen++;
      ws.stop();
    });
    ws.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toBe(1);
  });

  it("abort signal releases a waiter", async () => {
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fakeSite() });
    const ctrl = new AbortController();
    const p = ws.waitForIntent(("0x" + "cd".repeat(32)) as Hex, 60_000, ctrl.signal);
    ctrl.abort();
    expect((await p).status).toBe("unknown");
    expect((ws as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(0);
  });
});

describe("SseParser BOM", () => {
  it("strips a leading BOM", () => {
    expect(new SseParser().push("﻿event: wallet\ndata: {}\n\n")).toEqual([{ event: "wallet", data: "{}" }]);
  });
});
