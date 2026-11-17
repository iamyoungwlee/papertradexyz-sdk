import { describe, expect, it } from "vitest";
import { mergeWalletEvent, SseParser, StreamProtocolError, WalletStream, decodeOpenPosition, decodeClosedPosition, decodeOperation, type WalletState } from "../src/index.js";
import { loadSpec } from "./spec.js";

const fx = loadSpec("vectors/fixtures/sse_open_close.json");
const vec = loadSpec("vectors/stream.json");

describe("spec/vectors/stream.json", () => {
  it("merges fixture events into the expected steps", () => {
    let state: WalletState | null = null;
    fx.events.forEach((ev: any, i: number) => {
      const r = mergeWalletEvent(state, ev);
      state = r.state;
      const s = vec.steps[i];
      expect(state.accountRevision).toBe(s.accountRevision);
      expect(state.openPositions.map((p) => String(p[0]))).toEqual(s.openPositionIds);
      expect(state.operations.map((o) => o[0])).toEqual(s.operationIds);
      for (const k of ["balance", "locked", "funds", "queueRevision"]) expect(state[k], k).toEqual(s[k]);
      const emitted: Record<string, unknown> = {};
      if (r.closedPositions.length) emitted.closedPositions = r.closedPositions;
      if (r.intentOutcomes.length) emitted.intentOutcomes = r.intentOutcomes;
      expect(emitted).toEqual(s.emitted);
    });
    for (const k of vec.compareKeysWithReconnect) expect(state![k], k).toEqual(fx.reconnectSnapshot[k]);
  });

  it("reconnect snapshot replaces state and resets revision", () => {
    let state: WalletState | null = null;
    for (const ev of fx.events) state = mergeWalletEvent(state, ev).state;
    const r = mergeWalletEvent(state, fx.reconnectSnapshot);
    expect(r.kind).toBe("snapshot");
    expect(r.state.accountRevision).toBe(fx.reconnectSnapshot.accountRevision);
  });

  it("does not mutate inputs", () => {
    const snap = structuredClone(fx.events[0]);
    const s0 = mergeWalletEvent(null, snap).state;
    const before = structuredClone(s0);
    mergeWalletEvent(s0, fx.events[1]);
    expect(s0).toEqual(before);
    expect(snap).toEqual(fx.events[0]);
  });

  it("rejects delta before snapshot, gaps, replays and duplicates", () => {
    const s0 = mergeWalletEvent(null, fx.events[0]).state;
    expect(() => mergeWalletEvent(null, fx.events[1])).toThrow(StreamProtocolError);
    expect(() => mergeWalletEvent(s0, fx.events[2])).toThrow(/gap/);
    const s1 = mergeWalletEvent(s0, fx.events[1]).state;
    expect(() => mergeWalletEvent(s1, { ...fx.events[1], baseAccountRevision: s1.accountRevision })).toThrow(/non-increasing/);
    const s2 = mergeWalletEvent(s1, fx.events[2]).state;
    const dup = { accountRevision: s2.accountRevision + 1, baseAccountRevision: s2.accountRevision, state: {}, addedPositions: [s2.openPositions[0]] };
    expect(() => mergeWalletEvent(s2, dup)).toThrow(/duplicate/);
  });

  it("decodes tuples", () => {
    let state: WalletState | null = null;
    for (const ev of fx.events.slice(0, 3)) state = mergeWalletEvent(state, ev).state;
    const p = decodeOpenPosition(state!.openPositions[0]!);
    expect(p.positionId).toBe("1000001");
    expect(typeof p.marginRaw).toBe("bigint");
    expect(p.intentId).toMatch(/^0x[0-9a-f]{64}$/);
    const closedEv = fx.events.find((e: any) => e.closedPositions);
    const c = decodeClosedPosition(closedEv.closedPositions[0]);
    expect(c.netPnlRaw).toBe(155658016138493807n);
    expect(c.liquidated).toBe(false);
    const opEv = fx.events.find((e: any) => e.addedOperations);
    expect(decodeOperation(opEv.addedOperations[0]).action).toMatch(/Position/);
  });
});

describe("SseParser", () => {
  it("handles split chunks, CRLF, comments and multi-line data", () => {
    const p = new SseParser();
    expect(p.push(": hi\r\nevent: wal")).toEqual([]);
    expect(p.push("let\r\ndata: {\"a\":\r")).toEqual([]);
    const out = p.push("\ndata: 1}\r\n\r\nevent: heartbeat\ndata:\n\n");
    // An empty data line still dispatches (WHATWG), so data-less heartbeats keep their event name.
    expect(out).toEqual([{ event: "wallet", data: '{"a":\n1}' }, { event: "heartbeat", data: "" }]);
    expect(p.push("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });
});

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      // keep open
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("WalletStream", () => {
  it("resolves waiters for fills, including results that arrived before waiting", async () => {
    const opened = fx.events[2].intentOutcomes[0][0];
    const closedIntent = fx.events.find((e: any) => e.closedPositions).intentOutcomes?.[0]?.[0];
    const fetchMock = async () => sseResponse([frame("liveness", { heartbeatIntervalMs: 15000 }), ...fx.events.map((e: any) => frame("wallet", e))]);
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fetchMock as any });
    const closes: unknown[] = [];
    ws.on("positionClosed", (c) => closes.push(c));
    const early = ws.waitForIntent(opened, 2000);
    ws.start();
    expect((await early).status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 20));
    const late = await ws.waitForIntent(opened, 10);
    expect(late.status).toBe("succeeded");
    if (closedIntent) expect((await ws.waitForIntent(closedIntent, 10)).status).toBe("succeeded");
    expect(closes).toHaveLength(1);
    expect(ws.state?.accountRevision).toBe(fx.events.at(-1).accountRevision);
    ws.stop();
  });

  it("times out as unknown, and reconnects after a protocol error", async () => {
    let calls = 0;
    const fetchMock = async () => {
      calls++;
      return calls === 1
        ? sseResponse([frame("wallet", fx.events[1])]) // delta before snapshot → reconnect
        : sseResponse([frame("wallet", fx.events[0])]);
    };
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fetchMock as any, reconnectBaseMs: 1 });
    const errors: unknown[] = [];
    ws.on("error", (e) => errors.push(e));
    ws.start();
    const r = await ws.waitForIntent(("0x" + "ab".repeat(32)) as any, 50);
    expect(r).toEqual({ status: "unknown", intentId: "0x" + "ab".repeat(32), outcome: null });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(errors[0]).toBeInstanceOf(StreamProtocolError);
    expect(ws.state?.accountRevision).toBe(fx.events[0].accountRevision);
    ws.stop();
  });

  it("reconnects when heartbeats stop", async () => {
    let calls = 0;
    const fetchMock = async () => (calls++, sseResponse([frame("wallet", fx.events[0])]));
    const ws = new WalletStream({ wallet: fx.events[0].address, fetch: fetchMock as any, heartbeatTimeoutMs: 30, reconnectBaseMs: 1 });
    ws.start();
    await new Promise((r) => setTimeout(r, 150));
    ws.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
