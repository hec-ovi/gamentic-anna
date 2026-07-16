// Late-beat delivery: a background render can land its image beat AT a turn_index the
// client already fetched (the render's next_turn_index read raced the turn that owned
// it). /beats?since= is exclusive, so the poll asks one turn BEHIND the high-water mark
// and relies on the id seen-set to drop the overlap - never a duplicate, never a lost
// image.

import { test, expect, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup.js";
import { pullBeats } from "../src/app/mediastream.js";
import { state } from "../src/app/ctx.js";
import { makeBeat } from "./fixtures.js";

const API = "http://localhost:8000";

afterEach(() => {
  state.active = null;
  state.view = "menu";
});

function game(over = {}) {
  return {
    id: "g-test",
    state: null,
    beats: [],
    generating: false,
    lastTurnIndex: 5,
    revealQueue: [],
    ...over,
  };
}

test("the poll asks one turn behind the high-water mark", async () => {
  let since = null;
  server.use(
    http.get(`${API}/games/:id/beats`, ({ request }) => {
      since = new URL(request.url).searchParams.get("since");
      return HttpResponse.json({ beats: [] });
    }),
  );
  const g = game();
  state.active = g;
  await pullBeats(g);
  expect(since).toBe("4"); // lastTurnIndex 5 -> since=4 (exclusive query = fetch >= 5)
});

test("an image beat landing at an already-fetched turn_index still arrives, deduped by id", async () => {
  const known = makeBeat({ id: "b-known", turn_index: 5, text: "You look around." });
  const late = makeBeat({
    id: "b-late-image",
    turn_index: 5, // SAME turn the client already has - the old exclusive poll lost it
    kind: "image",
    image_url: "/media/g-test/view-t5.png",
    text: "The hall as it stands",
  });
  server.use(
    http.get(`${API}/games/:id/beats`, () => HttpResponse.json({ beats: [known, late] })),
  );
  const g = game({
    beats: [{ id: "b-known", turnIndex: 5, seq: 0, kind: "narration", text: "You look around." }],
  });
  state.active = g;
  await pullBeats(g);
  const ids = g.beats.map((b) => b.id);
  expect(ids).toContain("b-late-image"); // the late image beat arrived
  expect(ids.filter((id) => id === "b-known")).toHaveLength(1); // no duplicate
});
