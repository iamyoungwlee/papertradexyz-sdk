# papertradexyz-sdk (TypeScript)

Unofficial TypeScript SDK for [Papertrade](https://papertrade.xyz) (HyperEVM perpetuals).
Not affiliated with the Papertrade team. The protocol was reverse-engineered and may change without notice.

- EIP-712 intent signing + intentId (passes the signing vectors)
- Settlement PnL estimate (passes the PnL vectors)
- `/state/user/live` SSE wallet stream with revision-checked merge (passes the stream vectors)
- Live build check: refuses to sign if the frontend's typed-data changed
- Order lifecycle: `prepared → accepted → succeeded | rejected | unknown`

Zero runtime dependencies; `viem` is a peer dependency.

```bash
npm install papertradexyz-sdk viem
```

## Trade

```ts
import { PapertradeClient } from "papertradexyz-sdk";
import { privateKeyToAccount } from "viem/accounts";

const master = privateKeyToAccount(process.env.MASTER_KEY as `0x${string}`);
const sessionKey = privateKeyToAccount(process.env.SESSION_KEY as `0x${string}`);

const pt = new PapertradeClient({
  user: master.address,
  sessionKey,
  master, // only needed for registerSessionKey
  observer: (intent, status) => saveSomewhere(intent.intentId, status, intent.body), // persist before POST
});

// once: register the session key (master signs). feeAddress defaults to 0x0 = no builder fee.
await pt.submit(await pt.prepareRegisterSessionKey({ key: sessionKey.address }));

// `margin` is the signed `size`: USD margin, not notional. Decimal strings only.
const open = await pt.prepareOpen({ instrument: "BTC", isLong: true, margin: "10", leverage: 100 });
const res = await pt.submitAndWait(open, { timeoutMs: 60_000 });
// res.status: "succeeded" | "rejected" | "unknown"
if (res.fill?.status === "succeeded") console.log(res.fill.position?.positionId);

const close = await pt.prepareClose([res.fill!.position!.positionId]);
await pt.submitAndWait(close);
pt.close();
```

Rules the client enforces:

- HTTP 201 is only **accepted**, not filled. Fills come from the wallet stream; the waiter is registered before the POST because the stream can beat the HTTP response.
- POSTs are never retried automatically. `unknown` (timeout, connection reset, 5xx, intentId mismatch) does not mean failed. To resend, call `submit` again with the **same** prepared intent; a new nonce is a new order.
- A close that `succeeded` can still settle as a liquidation (`positionClosed` event → `liquidated`).
- Actions marked `inferred` in the spec (cancel, withdraw, staking) need `allowInferred: true`.

## Wallet stream

```ts
const stream = pt.stream(); // one connection per wallet; reopening gets 429
stream.on("positionOpened", (p) => console.log(p.positionId, p.bustPriceRaw));
stream.on("positionClosed", (c) => console.log(c.netPnlRaw, c.liquidated)); // authoritative PnL
stream.on("error", console.error); // gaps/replays trigger a reconnect with a fresh snapshot
```

## Math

```ts
import { estimateClosePnlRange, parsePrice, formatUsd } from "papertradexyz-sdk";

// The payout curve in force (standard / off-hours) cannot be read, so the estimate is a range.
const r = estimateClosePnlRange({ instrumentId: 0, isLong: true, margin: 10, leverage: 100, entryPrice: 80000, exitPrice: 80080 });
console.log(r.netPnlMin, r.netPnlMax);
```

PnL is a float estimate (relative error ~1e-9 vs the spec formula). Amounts, nonces and signatures are `bigint`.

## Reads

`protocolSummary()`, `marketStats()`, `queueSummary()`, `priceHistory()`, `liquidationMap()`, `accountHistory()`,
`accountFunding()`, `queueBalances()`, or `pt.http.get(path, query)`. These return raw JSON: response shapes are not pinned
down by fixtures yet.

## Development

```bash
npm install
npm test        # vitest, includes the spec vectors in test/spec/
npm run sync-spec  # refresh test/spec/ from the spec (PAPERTRADE_SPEC_DIR, default ../refs/pjt-papertrade/spec)
npm run typecheck
npm run build   # ESM + CJS + d.ts
```
