/**
 * EIP-712 typed data, intentId and `POST /intents` body construction.
 * Spec: spec/protocol.json → domains, types, actions, serialization, intentId.
 */
import {
  concat,
  encodeAbiParameters,
  hashDomain,
  hashTypedData,
  isAddress,
  keccak256,
  parseSignature,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { ACTIONS, INTENT_ID_SALT, MAINNET, PAPERTRADE_TYPES, type ActionName, type PapertradeNetwork, type PrimaryType } from "./constants.js";
import { InferredActionError, ValidationError } from "./errors.js";

/** Field value as accepted from callers: bigint / safe-integer number / decimal string for uints. */
export type FieldInput = string | number | bigint | boolean | readonly (string | number | bigint)[];
export type MessageInput = Record<string, FieldInput>;

/** Message normalized to the types viem expects (bigint for uints, lowercase hex for address/bytes). */
export type NormalizedMessage = Record<string, bigint | boolean | Hex | bigint[]>;

/** Serialized `signed` object of the request body (spec/protocol.json → serialization). */
export type SignedFields = Record<string, string | boolean | string[]> & { v: string; r: Hex; s: Hex };

export interface IntentRequestBody {
  action: ActionName;
  signed: SignedFields;
}

export interface TypedDataPayload {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: PrimaryType;
  message: NormalizedMessage;
}

export interface ActionOptions {
  network?: PapertradeNetwork;
  /** Required for actions whose spec status is `inferred` (withdraw, staking, cancel). */
  allowInferred?: boolean;
}

/** Minimal signer: a viem LocalAccount satisfies this. */
export interface TypedDataSigner {
  address: Address;
  signTypedData(args: TypedDataPayload): Promise<Hex>;
}

const UINT_RE = /^uint(\d+)$/;
const DEC_RE = /^\d+$/;

function toUint(value: unknown, bits: number, field: string): bigint {
  let v: bigint;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ValidationError(`${field}: number ${value} is not a safe integer; pass bigint or decimal string`);
    v = BigInt(value);
  } else if (typeof value === "string" && DEC_RE.test(value)) v = BigInt(value);
  else throw new ValidationError(`${field}: expected unsigned integer, got ${JSON.stringify(value)}`);
  if (v < 0n || v >= 1n << BigInt(bits)) throw new ValidationError(`${field}: ${v} out of range for uint${bits}`);
  return v;
}

function normalizeField(type: string, value: unknown, field: string): bigint | boolean | Hex | bigint[] {
  if (value === undefined) throw new ValidationError(`${field}: missing`);
  const uint = UINT_RE.exec(type);
  if (uint) return toUint(value, Number(uint[1]), field);
  if (type === "uint256[]") {
    if (!Array.isArray(value)) throw new ValidationError(`${field}: expected array`);
    return value.map((x, i) => toUint(x, 256, `${field}[${i}]`));
  }
  if (type === "address") {
    if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new ValidationError(`${field}: invalid address`);
    return value.toLowerCase() as Hex;
  }
  if (type === "bytes32") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ValidationError(`${field}: expected 32-byte hex`);
    return value.toLowerCase() as Hex;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new ValidationError(`${field}: expected boolean`);
    return value;
  }
  throw new ValidationError(`${field}: unsupported type ${type}`);
}

function assertAllowed(action: ActionName, opts: ActionOptions): void {
  const spec = ACTIONS[action];
  if (!spec) throw new ValidationError(`Unknown action ${action}`);
  if (spec.status === "inferred" && !opts.allowInferred) {
    throw new InferredActionError(`Action "${action}" is only inferred from the frontend bundle; pass allowInferred: true to use it`);
  }
}

/** Validate and normalize a message, then build the full EIP-712 payload for `action`. */
export function buildTypedData(action: ActionName, message: MessageInput, opts: ActionOptions = {}): TypedDataPayload {
  assertAllowed(action, opts);
  const network = opts.network ?? MAINNET;
  const spec = ACTIONS[action];
  const fields = PAPERTRADE_TYPES[spec.primaryType];
  const known = new Set<string>(fields.map((f) => f.name));
  for (const k of Object.keys(message)) if (!known.has(k)) throw new ValidationError(`${spec.primaryType}: unknown field ${k}`);

  const normalized: NormalizedMessage = {};
  for (const f of fields) normalized[f.name] = normalizeField(f.type, message[f.name], `${spec.primaryType}.${f.name}`);

  const d = network.domains[spec.domain];
  return {
    domain: { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
    types: { [spec.primaryType]: fields },
    primaryType: spec.primaryType,
    message: normalized,
  };
}

export function domainSeparator(payload: TypedDataPayload): Hex {
  return hashDomain({
    domain: payload.domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
}

/** hashStruct(message). Supports the primitive and uint256[] fields used by Papertrade. */
export function structHash(payload: TypedDataPayload): Hex {
  const fields = PAPERTRADE_TYPES[payload.primaryType];
  const typeHash = keccak256(toBytes(`${payload.primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`));
  const params: { type: string }[] = [{ type: "bytes32" }];
  const values: unknown[] = [typeHash];
  for (const f of fields) {
    const v = payload.message[f.name];
    if (f.type === "uint256[]") {
      const items = v as bigint[];
      params.push({ type: "bytes32" });
      values.push(keccak256(items.length ? concat(items.map((x) => encodeAbiParameters([{ type: "uint256" }], [x]))) : "0x"));
    } else {
      params.push({ type: f.type });
      values.push(v);
    }
  }
  return keccak256(encodeAbiParameters(params, values));
}

export function typedDataDigest(payload: TypedDataPayload): Hex {
  // viem's types are generic over literal type definitions; the payload is validated above.
  return hashTypedData(payload as Parameters<typeof hashTypedData>[0]);
}

/** intentId = keccak256(keccak256(utf8(salt)) ‖ digest ‖ signerAddress). Signer is the key that signed (session key for open/close). */
export function computeIntentId(digest: Hex, signer: Address): Hex {
  if (!isAddress(signer, { strict: false })) throw new ValidationError(`invalid signer address ${signer}`);
  return keccak256(concat([keccak256(toBytes(INTENT_ID_SALT)), digest, signer.toLowerCase() as Hex]));
}

function serializeMessage(payload: TypedDataPayload): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (const f of PAPERTRADE_TYPES[payload.primaryType]) {
    const v = payload.message[f.name]!;
    if (Array.isArray(v)) out[f.name] = v.map(String);
    else if (typeof v === "bigint") out[f.name] = v.toString();
    else out[f.name] = v; // boolean or lowercase hex
  }
  return out;
}

export interface SignedIntent {
  action: ActionName;
  payload: TypedDataPayload;
  signer: Address;
  digest: Hex;
  intentId: Hex;
  signature: { v: string; r: Hex; s: Hex };
  body: IntentRequestBody;
}

/** Split a 65-byte signature into the request's decimal `v` ("27"|"28") and lowercase r/s. */
export function splitSignature(signature: Hex): { v: string; r: Hex; s: Hex } {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  const v27 = v < 27 ? v + 27 : v;
  return { v: String(v27), r: sig.r.toLowerCase() as Hex, s: sig.s.toLowerCase() as Hex };
}

/** Assemble the `POST /intents` body from a payload and its signature. */
export function buildRequestBody(action: ActionName, payload: TypedDataPayload, sig: { v: string; r: Hex; s: Hex }): IntentRequestBody {
  return { action, signed: { ...serializeMessage(payload), v: sig.v, r: sig.r, s: sig.s } };
}

/** Validate, sign and package an intent. Does not send anything. */
export async function signIntent(
  action: ActionName,
  message: MessageInput,
  signer: TypedDataSigner,
  opts: ActionOptions = {},
): Promise<SignedIntent> {
  const payload = buildTypedData(action, message, opts);
  const digest = typedDataDigest(payload);
  const signature = splitSignature(await signer.signTypedData(payload));
  return {
    action,
    payload,
    signer: signer.address,
    digest,
    intentId: computeIntentId(digest, signer.address),
    signature,
    body: buildRequestBody(action, payload, signature),
  };
}
