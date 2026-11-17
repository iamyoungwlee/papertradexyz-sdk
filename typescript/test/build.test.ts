import { describe, expect, it } from "vitest";
import { BuildCheckError, checkLiveBuild, compareSigningScheme, discoverBuild, parseTypedDataChunk } from "../src/index.js";
import { TYPED_DATA_CHUNK, fakeSite } from "./site.js";

describe("build check", () => {
  it("live bundle (build e465c69ba182) matches the SDK", () => {
    const parsed = parseTypedDataChunk(TYPED_DATA_CHUNK);
    expect(Object.keys(parsed.types)).toContain("OpenPosition");
    expect(compareSigningScheme(parsed)).toEqual({ compatible: true, differences: [] });
  });

  it("detects a changed type, domain and salt", () => {
    const changed = TYPED_DATA_CHUNK
      .replace("{name:`leverage`,type:`uint32`}", "{name:`leverage`,type:`uint16`}")
      .replace("name:`String`,version:`1`", "name:`String`,version:`2`")
      .replace("papertrade:intent-id:v2", "papertrade:intent-id:v3");
    const r = compareSigningScheme(parseTypedDataChunk(changed));
    expect(r.compatible).toBe(false);
    const text = r.differences.join("\n");
    expect(text).toContain("type OpenPosition");
    expect(text).toContain("domain exchange");
    expect(text).toContain("salt");
  });

  it("discovers the build id and checks the live chunk", async () => {
    expect(await discoverBuild({ fetch: fakeSite() })).toEqual({ buildId: "e465c69ba182", typedDataPath: "/assets/typed-data-XyZ.js" });
    expect((await checkLiveBuild({ fetch: fakeSite() })).compatible).toBe(true);
  });

  it("discovery failure is a BuildCheckError", async () => {
    const f = (async () => new Response("<html></html>")) as unknown as typeof fetch;
    await expect(discoverBuild({ fetch: f })).rejects.toBeInstanceOf(BuildCheckError);
  });
});
