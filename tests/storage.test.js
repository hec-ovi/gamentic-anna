import { describe, it, expect } from "vitest";
import { mountBundle } from "@anna-ai/cli/test";
import { saveState, loadState } from "../bundle/core.js";
import manifest from "../manifest.json" with { type: "json" };

describe("storage primitives", () => {
  it("round-trips a value and records set then get", async () => {
    const h = await mountBundle({ manifest });
    const v = { turn: 1, scene: "a misty forest", player: { hp: 10 } };

    const setResult = await saveState(h.runtime, "game:test", v);
    expect(setResult).toBeNull();

    const got = await loadState(h.runtime, "game:test");
    expect(got).toEqual(v);

    // Exactly one set and one get were recorded, with the right args.
    const sets = h.calls.byNs("storage.set");
    expect(sets).toHaveLength(1);
    expect(sets[0].args).toEqual({ key: "game:test", value: v });

    const gets = h.calls.byNs("storage.get");
    expect(gets).toHaveLength(1);
    expect(gets[0].args).toEqual({ key: "game:test" });

    // The set was recorded before the get.
    const lastSet = h.calls.lastOf("storage.set");
    const lastGet = h.calls.lastOf("storage.get");
    expect(lastSet.seq).toBeLessThan(lastGet.seq);
  });

  it("returns null for a missing key", async () => {
    const h = await mountBundle({ manifest });
    const got = await loadState(h.runtime, "game:does-not-exist");
    expect(got).toBeNull();
  });

  it("rejects when host_api.storage permission is absent", async () => {
    // Shallow-clone ui + host_api so the imported manifest JSON is never mutated.
    const denied = {
      ...manifest,
      ui: {
        ...manifest.ui,
        host_api: { ...manifest.ui.host_api, storage: [] },
      },
    };
    const h = await mountBundle({ manifest: denied });
    await expect(saveState(h.runtime, "k", { a: 1 })).rejects.toThrow();

    // Sanity: the imported manifest still grants storage (clone did not mutate it).
    expect(manifest.ui.host_api.storage).toEqual(["get", "set", "delete", "list"]);
  });
});
