"""Beat coordinates are the transcript's order. Background render jobs allocate
(turn_index, seq) OUTSIDE the per-game turn lock, and the old read-then-insert let
two writers land at the same coordinates - on reload the rowid tiebreak re-sorted
the player's own whisper. seq now allocates inside the INSERT (atomic per
statement), a UNIQUE index pins it, and _migrate repairs pre-existing collisions
by re-sequencing each (game, turn) group in insertion order.
"""
import threading

from app import db, repo


def _mk_game(client, world):
    return client.post("/games", json=world).json()["game_id"]


def test_concurrent_add_beat_never_collides(client, fake_llm, world):
    gid = _mk_game(client, world)
    with db.get_conn() as conn:
        turn = repo.next_turn_index(conn, gid)
    errors = []

    def _land(i):
        try:
            with db.get_conn() as conn:
                repo.add_beat(conn, gid, "narrator", None, "image", f"shot {i}",
                              "crypt entrance", turn_index=turn)
        except Exception as exc:  # noqa: BLE001 - collected for the assertion
            errors.append(exc)

    threads = [threading.Thread(target=_land, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert errors == []
    with db.get_conn() as conn:
        seqs = [r["seq"] for r in conn.execute(
            "SELECT seq FROM beats WHERE game_id=? AND turn_index=? ORDER BY seq",
            (gid, turn)).fetchall()]
    assert len(seqs) == 8 and len(set(seqs)) == 8   # every writer got its own seat


def test_whisper_turn_orders_echo_before_reply(client, fake_llm, world):
    gid = _mk_game(client, world)
    with db.get_conn() as conn:
        cid = repo.get_characters(conn, gid)[0]["id"]
    client.post(f"/games/{gid}/action", json={"segments": [
        {"type": "whisper", "target": cid, "mode": "say", "text": "trust me"}]})
    private = [b for b in client.get(f"/games/{gid}/beats").json()["beats"]
               if b["private_with"]]
    assert len(private) >= 2
    assert private[0]["speaker"] == "player"        # the echo leads its own exchange
    # the sorted endpoint puts the reply strictly after it
    assert (private[1]["turn_index"], private[1]["seq"]) > (private[0]["turn_index"], private[0]["seq"])


def test_migration_repairs_coordinate_collisions(client, fake_llm, world):
    gid = _mk_game(client, world)
    with db.get_conn() as conn:
        # forge a pre-migration DB: drop the unique index, land three beats at the
        # SAME coordinates (the old race), in a known insertion order
        conn.execute("DROP INDEX idx_beats_coord")
        for i, text in enumerate(("first", "second", "third")):
            conn.execute(
                "INSERT INTO beats (id, game_id, turn_index, seq, speaker, kind, text, location) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (f"dup-{i}", gid, 7, 2, "narrator", "narration", text, "crypt entrance"))
    db.init_db()                                    # a restart runs _migrate
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, seq FROM beats WHERE game_id=? AND turn_index=7 ORDER BY seq",
            (gid,)).fetchall()
        assert [r["id"] for r in rows] == ["dup-0", "dup-1", "dup-2"]  # insertion order kept
        assert len({r["seq"] for r in rows}) == 3                      # now distinct
        # the unique index is back: a forged duplicate cannot return
        import sqlite3
        import pytest as _pytest
        with _pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO beats (id, game_id, turn_index, seq, speaker, kind, text, location) "
                "VALUES ('dup-x', ?, 7, ?, 'narrator', 'narration', 'x', 'crypt entrance')",
                (gid, rows[0]["seq"]))
