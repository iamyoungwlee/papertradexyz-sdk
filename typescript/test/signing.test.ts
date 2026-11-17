import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, serializeSignature, type Hex } from "viem";
import {
  buildTypedData,
  domainSeparator,
  signIntent,
  structHash,
  typedDataDigest,
  type ActionName,
} from "../src/index.js";
import { loadSpec } from "./spec.js";

const vectors = loadSpec("vectors/signing.json");

describe("spec/vectors/signing.json", () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      const { action, signerPrivateKey, message } = c.input;
      const e = c.expected;
      const account = privateKeyToAccount(signerPrivateKey as Hex);
      const payload = buildTypedData(action as ActionName, message, { allowInferred: true });

      expect(payload.primaryType).toBe(c.input.primaryType);
      expect(domainSeparator(payload)).toBe(e.domainSeparator);
      expect(structHash(payload)).toBe(e.structHash);
      expect(typedDataDigest(payload)).toBe(e.digest);

      const signed = await signIntent(action as ActionName, message, account, { allowInferred: true });
      expect(signed.signer.toLowerCase()).toBe(e.signer.toLowerCase());
      expect(signed.signature).toEqual(e.signature);
      expect(signed.intentId).toBe(e.intentId);
      expect(signed.body).toEqual(e.requestBody);

      const recovered = await recoverTypedDataAddress({
        ...(payload as any),
        signature: serializeSignature({ r: signed.signature.r, s: signed.signature.s, v: BigInt(signed.signature.v) }),
      });
      expect(recovered.toLowerCase()).toBe(e.signer.toLowerCase());
    });
  }
});

describe("validation", () => {
  const user = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const base = { user, instrumentId: 0, isLong: true, size: "10000000000000000000", leverage: 100, useDebt: false, nonce: 1n, deadline: 1n };

  it("rejects inferred actions without opt-in", () => {
    expect(() => buildTypedData("cancel", { user, intentId: "0x" + "00".repeat(32), deadline: 1 })).toThrow(/allowInferred/);
  });
  it("rejects out-of-range uints", () => {
    expect(() => buildTypedData("openPosition", { ...base, leverage: 2 ** 32 })).toThrow(/uint32/);
    expect(() => buildTypedData("openPosition", { ...base, size: "-1" })).toThrow();
    expect(() => buildTypedData("openPosition", { ...base, size: 1.5 })).toThrow(/safe integer/);
  });
  it("rejects non-boolean bools, bad addresses, unknown and missing fields", () => {
    expect(() => buildTypedData("openPosition", { ...base, isLong: "true" as any })).toThrow(/boolean/);
    expect(() => buildTypedData("openPosition", { ...base, user: "0x1234" })).toThrow(/address/);
    expect(() => buildTypedData("openPosition", { ...base, extra: 1 })).toThrow(/unknown field/);
    const { nonce: _n, ...missing } = base;
    expect(() => buildTypedData("openPosition", missing)).toThrow(/missing/);
  });
});
