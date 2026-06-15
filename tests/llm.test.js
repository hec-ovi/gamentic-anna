import { describe, it, expect } from "vitest";
import { mountBundle } from "@anna-ai/cli/test";
import { askAnna } from "../bundle/core.js";
import manifest from "../manifest.json" with { type: "json" };

describe("askAnna", () => {
  it("returns the LLM reply text and records the call", async () => {
    const FIXED = "A dungeon master narrates the world.";
    const h = await mountBundle({
      manifest,
      mocks: {
        "llm.complete": () => ({
          role: "assistant",
          content: { type: "text", text: FIXED },
          model: "mock",
          stopReason: "endTurn",
        }),
      },
    });

    const out = await askAnna(h.runtime, "Tell me about the world.");
    expect(out).toBe(FIXED);

    const rec = h.calls.lastOf("llm.complete");
    expect(rec).not.toBeNull();
    expect(rec.args.messages).toEqual([
      { role: "user", content: { type: "text", text: "Tell me about the world." } },
    ]);
    // Never cap output tokens: a cap truncates Anna's narration / structured output.
    expect(rec.args.maxTokens).toBeUndefined();
  });

  it("works against the harness default llm mock", async () => {
    const h = await mountBundle({ manifest });
    const out = await askAnna(h.runtime, "anything");
    expect(out).toContain("MOCK LLM");
  });

  it("rejects when host_api.llm permission is absent", async () => {
    const denied = {
      ...manifest,
      ui: {
        ...manifest.ui,
        host_api: { ...manifest.ui.host_api, llm: [] },
      },
    };
    const h = await mountBundle({ manifest: denied });
    await expect(askAnna(h.runtime, "x")).rejects.toThrow();
  });
});
