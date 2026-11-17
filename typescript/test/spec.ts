import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SPEC_DIR = fileURLToPath(new URL("./spec/", import.meta.url));

export function loadSpec<T = any>(path: string): T {
  return JSON.parse(readFileSync(SPEC_DIR + path, "utf8")) as T;
}
