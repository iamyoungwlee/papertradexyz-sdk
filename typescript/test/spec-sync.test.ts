import { describe, expect, it } from "vitest";
import { ACTIONS, CONTRACT_SETS, INSTRUMENTS, INTENT_ID_SALT, LIMITS, MAINNET, OBSERVED_BUILD, PAPERTRADE_TYPES, SETTLEMENT, SPEC_VERSION } from "../src/index.js";
import { loadSpec } from "./spec.js";

const proto = loadSpec("protocol.json");
const instr = loadSpec("instruments.json");

describe("constants mirror spec/*.json", () => {
  it("version, hosts, network", () => {
    expect(SPEC_VERSION).toBe(proto.specVersion);
    expect(OBSERVED_BUILD).toBe(proto.observedBuild);
    expect(MAINNET.chainId).toBe(proto.network.chainId);
    expect(MAINNET.rpcUrl).toBe(proto.network.rpcUrl);
    expect(MAINNET.apiUrl).toBe(proto.hosts.api);
    expect(MAINNET.streamUrl).toBe(proto.hosts.stream);
  });

  it("contracts", () => {
    const c = proto.contracts;
    const keys = ["exchange", "batchExecutor", "sessionKeyManager", "builderRegistry", "priceOracle",
      "depositProxyFactory", "paperToken", "paperStaking", "paperTokenomics", "bboPrecompile"] as const;
    for (const k of keys) expect(MAINNET.contracts[k], k).toBe(c[k]);
    expect(MAINNET.contracts.collateral).toBe(c.collateral.address);
  });

  it("domains, types, actions, salt", () => {
    for (const [k, d] of Object.entries<any>(proto.domains)) {
      const { status: _s, $comment: _c, ...rest } = d;
      expect(MAINNET.domains[k as keyof typeof MAINNET.domains]).toEqual(rest);
    }
    const types = Object.fromEntries(Object.entries(PAPERTRADE_TYPES).map(([k, v]) => [k, v.map((f) => [f.name, f.type])]));
    expect(types).toEqual(proto.types);
    for (const [k, a] of Object.entries<any>(proto.actions)) {
      if (k === "$comment") continue;
      expect(ACTIONS[k as keyof typeof ACTIONS], k).toMatchObject({
        primaryType: a.primaryType, domain: a.domain, signer: a.signer, status: a.status,
      });
    }
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(proto.actions).filter((k) => k !== "$comment").sort());
    expect(INTENT_ID_SALT).toBe(proto.intentId.salt);
  });

  it("limits", () => {
    for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) expect(LIMITS[k], k).toBe(proto.limits[k].value);
  });

  it("instruments and settlement", () => {
    expect(INSTRUMENTS).toEqual(instr.instruments);
    expect(SETTLEMENT.deadbandDivisor).toBe(instr.settlement.deadbandDivisor);
    expect(SETTLEMENT.winFee).toBe(instr.settlement.winFee);
    expect(SETTLEMENT.builderFee).toBe(instr.settlement.builderFee.value);
    const { status: _s, $comment: _c, ...curves } = instr.settlement.payoutCurves;
    expect(SETTLEMENT.payoutCurves).toEqual(curves);
  });

  it("contract sets", () => {
    expect(CONTRACT_SETS.map((c) => c.exchangeImplementation)).toEqual(proto.contractSets.map((c: any) => c.exchangeImplementation));
    expect(CONTRACT_SETS[1]!.liveFromMs).toBe(Date.parse(proto.contractSets[1].liveFrom));
  });
});
