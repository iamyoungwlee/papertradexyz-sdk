/**
 * Nonces are client-chosen uint256 values; only reuse is rejected (not sequential).
 * The SDK uses a CSPRNG and never reuses a value within the process, except when resending the same signed body.
 */
const used = new Set<bigint>();

export function randomNonce(): bigint {
  for (;;) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
}
