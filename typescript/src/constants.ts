/**
 * Protocol constants mirrored from `spec/protocol.json` and `spec/instruments.json`.
 * `test/spec-sync.test.ts` fails if these drift from the spec files.
 */
import type { Address } from "viem";

export const SPEC_VERSION = "0.3.0";
/** Build id the spec was captured against. A different live build means the signing scheme must be rechecked. */
export const OBSERVED_BUILD = "38cca5f93d1d";

/** Confidence level of a protocol fact (see spec/README.md). */
export type SpecStatus = "verified" | "observed" | "inferred";

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export type DomainName = "exchange" | "paperStaking" | "cancellation";

export interface PapertradeContracts {
  exchange: Address;
  batchExecutor: Address;
  sessionKeyManager: Address;
  builderRegistry: Address;
  priceOracle: Address;
  depositProxyFactory: Address;
  paperToken: Address;
  paperStaking: Address;
  paperTokenomics: Address;
  collateral: Address;
  bboPrecompile: Address;
}

/** Everything that differs per deployment. Pass a custom one to target another deployment. */
export interface PapertradeNetwork {
  chainId: number;
  apiUrl: string;
  streamUrl: string;
  rpcUrl: string;
  hyperliquidInfoUrl: string;
  hyperliquidWsUrl: string;
  contracts: PapertradeContracts;
  domains: Record<DomainName, Eip712Domain>;
}

const EXCHANGE: Address = "0x6cd5661646289FB6E65EA5C032310fDEd797D0a2";
const PAPER_STAKING: Address = "0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016";

export const MAINNET: PapertradeNetwork = {
  chainId: 999,
  apiUrl: "https://exchange.papertrade.xyz",
  streamUrl: "wss://stream.papertrade.xyz/connection/websocket",
  rpcUrl: "https://rpc.hyperliquid.xyz/evm",
  hyperliquidInfoUrl: "https://api.hyperliquid.xyz/info",
  hyperliquidWsUrl: "wss://api.hyperliquid.xyz/ws",
  contracts: {
    exchange: EXCHANGE,
    batchExecutor: "0x233Ff29b239abc1D7748605dA9b205C3e008626E",
    sessionKeyManager: "0x8326Eb8896e358717f10502Ec73CE8D28E37B108",
    builderRegistry: "0xFdc6550436Dd75Ce8a0B145f935B7D3A64F53248",
    priceOracle: "0xa9B4c7b7Ca5835652d81E25739c870D49F39cC2e",
    depositProxyFactory: "0x1629b7D46bef6E13FF754174FC9F32dEa309b38F",
    paperToken: "0xe40f17915DAa230324030003A197cdAEf2261C0e",
    paperStaking: PAPER_STAKING,
    paperTokenomics: "0x75174549dbBD44497D31a47E2E2D7406408d63D9",
    // Bundle value. Differs from the USDC address in the docs (0xb883…630f); see spec/protocol.json.
    collateral: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
    bboPrecompile: "0x000000000000000000000000000000000000080e",
  },
  domains: {
    // The domain name is literally "String".
    exchange: { name: "String", version: "1", chainId: 999, verifyingContract: EXCHANGE },
    paperStaking: { name: "PaperStaking", version: "1", chainId: 999, verifyingContract: PAPER_STAKING },
    cancellation: { name: "PaperTrade Intent Cancel", version: "2", chainId: 999, verifyingContract: EXCHANGE },
  },
};

/** EIP-712 struct definitions, field order matters. */
export const PAPERTRADE_TYPES = {
  RegisterSessionKey: [
    { name: "user", type: "address" },
    { name: "key", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "feeAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  OpenPosition: [
    { name: "user", type: "address" },
    { name: "instrumentId", type: "uint32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint128" },
    { name: "leverage", type: "uint32" },
    { name: "useDebt", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Close: [
    { name: "user", type: "address" },
    { name: "positionIds", type: "uint256[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  WithdrawToCore: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Stake: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Unstake: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Claim: [
    { name: "user", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Distribute: [
    { name: "user", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  CancelIntent: [
    { name: "user", type: "address" },
    { name: "intentId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PrimaryType = keyof typeof PAPERTRADE_TYPES;

export interface ActionSpec {
  primaryType: PrimaryType;
  domain: DomainName;
  /** Which key signs: the master wallet or the registered session key. */
  signer: "master" | "sessionKey";
  status: SpecStatus;
}

/** `action` value of `POST /intents` → what gets signed and by whom. */
export const ACTIONS = {
  registerSessionKey: { primaryType: "RegisterSessionKey", domain: "exchange", signer: "master", status: "verified" },
  openPosition: { primaryType: "OpenPosition", domain: "exchange", signer: "sessionKey", status: "verified" },
  closePositions: { primaryType: "Close", domain: "exchange", signer: "sessionKey", status: "verified" },
  withdrawToCore: { primaryType: "WithdrawToCore", domain: "exchange", signer: "master", status: "inferred" },
  paperStake: { primaryType: "Stake", domain: "paperStaking", signer: "master", status: "inferred" },
  paperUnstake: { primaryType: "Unstake", domain: "paperStaking", signer: "master", status: "inferred" },
  paperClaim: { primaryType: "Claim", domain: "paperStaking", signer: "master", status: "inferred" },
  cancel: { primaryType: "CancelIntent", domain: "cancellation", signer: "sessionKey", status: "inferred" },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;

export const INTENT_ID_SALT = "papertrade:intent-id:v2";

export const LIMITS = {
  intentDeadlineSeconds: 3600,
  sessionKeyExpirySeconds: 2_592_000,
  closeMaxPositionIds: 12,
  feeAddressDefault: "0x0000000000000000000000000000000000000000" as Address,
  /** inferred: a 9.77 USD margin was rejected. */
  minMarginUsd: 10,
  maxNotionalUsd: 10_000_000,
  builderFeeRate: 0.005,
} as const;

export const BUILD_HEADER = "X-Papertrade-Build";

/** Raw USD amounts (margin, balances, PnL) are 18-decimal integers. */
export const WAD_DECIMALS = 18;
/** HyperEVM USDC token decimals. */
export const COLLATERAL_EVM_DECIMALS = 6;

export interface ImpactParams {
  baseRate: number;
  rateMultiplier: number;
  referenceNotional: number;
  positionMultiplier: number;
}

export interface Instrument {
  id: number;
  name: string;
  /** Hyperliquid asset index (input of the BBO precompile). */
  assetIndex: number;
  /** price raw = price × priceScale */
  priceScale: number;
  impact: ImpactParams;
}

export const INSTRUMENTS: readonly Instrument[] = [
  {
    id: 0, name: "BTC", assetIndex: 0, priceScale: 10,
    impact: { baseRate: 0.1, rateMultiplier: 15000, referenceNotional: 100000, positionMultiplier: 814.598 },
  },
  {
    id: 1, name: "ETH", assetIndex: 1, priceScale: 100,
    impact: { baseRate: 0.1, rateMultiplier: 15000, referenceNotional: 100000, positionMultiplier: 483.979 },
  },
];

export interface PayoutCurve {
  startPpm: number;
  endPpm: number;
  holdback: number;
  fallPower: number;
}

export type PayoutCurveName = "standard" | "offHours";

export const SETTLEMENT = {
  deadbandDivisor: 50000,
  winFee: 0.02,
  builderFee: 0.005,
  payoutCurves: {
    standard: { startPpm: 75, endPpm: 600, holdback: 3.597, fallPower: 2 },
    offHours: { startPpm: 30, endPpm: 1000, holdback: 6.085, fallPower: 3 },
  } satisfies Record<PayoutCurveName, PayoutCurve>,
} as const;

export interface ContractSet {
  set: number;
  exchangeImplementation: Address;
  /** Unix ms, inclusive. */
  liveFromMs: number;
}

/** Exchange implementations in order. Settlement formulas differ between sets. */
export const CONTRACT_SETS: readonly ContractSet[] = [
  { set: 1, exchangeImplementation: "0x0F3feBFc94876b0C895F7aceCDc8F5c863b549EE", liveFromMs: Date.parse("2026-10-07T00:00:00Z") },
  { set: 2, exchangeImplementation: "0x0A44049dBbb6b4762a6ba37aa0f7548c0B4A3723", liveFromMs: Date.parse("2026-10-21T22:00:02Z") },
];

export function getInstrument(id: number): Instrument {
  const inst = INSTRUMENTS.find((i) => i.id === id);
  if (!inst) throw new RangeError(`Unknown instrumentId ${id}`);
  return inst;
}

export function getInstrumentByName(name: string): Instrument {
  const inst = INSTRUMENTS.find((i) => i.name === name.toUpperCase());
  if (!inst) throw new RangeError(`Unknown instrument ${name}`);
  return inst;
}

/** Contract set that settled a trade executed at `timestampMs`. */
export function contractSetAt(timestampMs: number): number {
  let current: number | undefined;
  for (const cs of CONTRACT_SETS) if (timestampMs >= cs.liveFromMs) current = cs.set;
  if (current === undefined) throw new RangeError(`No contract set live at ${new Date(timestampMs).toISOString()}`);
  return current;
}
