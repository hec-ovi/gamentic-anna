// Post-turn art pickup under Anna. There is no SSE inside the Anna iframe, and the
// engine renders a turn's art after the reply (fire-and-forget), so the frontend polls
// a short decaying burst to slot late art in. The burst must run ONLY under Anna
// (annaMode); elsewhere the EventSource push already covers late media.
import { test, expect, vi, afterEach } from "vitest";
import { pollBurst } from "../src/app/mediastream.js";
import { state } from "../src/app/ctx.js";

afterEach(() => {
  vi.useRealTimers();
  state.annaMode = false;
  state.active = null;
});

test("pollBurst is a no-op outside Anna (SSE handles late art there)", () => {
  vi.useFakeTimers();
  state.annaMode = false;
  pollBurst({ id: "g1" });
  expect(vi.getTimerCount()).toBe(0);
});

test("under Anna, pollBurst schedules a decaying poll burst that goes inert once the game leaves", () => {
  vi.useFakeTimers();
  state.annaMode = true;
  const g = { id: "g1" };
  pollBurst(g);
  expect(vi.getTimerCount()).toBeGreaterThan(3); // a series of polls is queued
  // the player navigates away mid-burst: each queued tick must no-op (state.active!==g),
  // not throw or hit the network
  state.active = null;
  expect(() => vi.runAllTimers()).not.toThrow();
});
