import { readFileSync } from "node:fs";

/** typed-data chunk served by the live site at build e465c69ba182 (2026-11-17). */
export const TYPED_DATA_CHUNK = readFileSync(new URL("./fixtures/typed-data-e465c69ba182.js", import.meta.url), "utf8");

type Handler = (url: URL, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>;

/** Fake fetch serving the frontend (index.html, build chunk, typed-data chunk) plus any extra routes. */
export function fakeSite(extra: Handler = () => undefined, typedData = TYPED_DATA_CHUNK): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const custom = await extra(url, init);
    if (custom) return custom;
    if (url.pathname === "/") {
      return new Response('<script src="/assets/build-AbC.js"></script><link rel="modulepreload" href="/assets/typed-data-XyZ.js">');
    }
    if (url.pathname === "/assets/build-AbC.js") return new Response("var e=`e465c69ba182`,t=`https://exchange.papertrade.xyz`;");
    if (url.pathname === "/assets/typed-data-XyZ.js") return new Response(typedData);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
