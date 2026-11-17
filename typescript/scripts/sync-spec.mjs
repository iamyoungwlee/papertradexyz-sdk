// Copy the spec files the tests need from the pjt-papertrade spec (the source of truth) into test/spec/.
//   npm run sync-spec                     # default source: ../refs/pjt-papertrade/spec
//   PAPERTRADE_SPEC_DIR=/path/to/spec npm run sync-spec
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = resolve(process.env.PAPERTRADE_SPEC_DIR ?? resolve(root, "../refs/pjt-papertrade/spec"));
const dst = resolve(root, "test/spec");
const FILES = ["protocol.json", "instruments.json", "vectors"];

if (!existsSync(resolve(src, "protocol.json"))) {
  console.error(`spec not found at ${src} (set PAPERTRADE_SPEC_DIR)`);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const f of FILES) cpSync(resolve(src, f), resolve(dst, f), { recursive: true });
console.log(`synced ${FILES.join(", ")} from ${src} → test/spec`);
