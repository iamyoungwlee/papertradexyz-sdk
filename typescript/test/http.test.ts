import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, TransportError, canonicalQuery } from "../src/index.js";

describe("http", () => {
  it("canonical query sorts keys and drops empty values", () => {
    expect(canonicalQuery({ toMs: 2, fromMs: 1, x: undefined, intervalMs: 125n })).toBe("?fromMs=1&intervalMs=125&toMs=2");
    expect(canonicalQuery({})).toBe("");
  });

  it("GET retries 429/5xx, honoring Retry-After, then succeeds", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "0" } });
      if (n === 2) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const http = new HttpClient({ fetch: f, backoffBaseMs: 1 });
    expect(await http.get("/query/protocol/summary")).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("GET does not retry 4xx and keeps the body", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
    }) as unknown as typeof fetch;
    const err = await new HttpClient({ fetch: f }).get("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("nope");
    expect((err as HttpError).body).toEqual({ error: "nope" });
    expect(n).toBe(1);
  });

  it("POST is sent once with the build header; a network failure is a TransportError", async () => {
    const calls: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const http = new HttpClient({ fetch: f, buildId: () => "b1" });
    await expect(http.post("/intents", { a: 1 })).rejects.toBeInstanceOf(TransportError);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.headers as Record<string, string>)["X-Papertrade-Build"]).toBe("b1");
  });
});
