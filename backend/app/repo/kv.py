"""app_kv: install-wide durable key/value state (the player-facing images switch,
per-asset heal counters). Tiny by design; anything per-game belongs on its table."""


def kv_get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM app_kv WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def kv_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO app_kv (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def kv_delete(conn, key: str) -> None:
    conn.execute("DELETE FROM app_kv WHERE key=?", (key,))


def kv_delete_prefix(conn, prefix: str) -> None:
    conn.execute("DELETE FROM app_kv WHERE key LIKE ?", (prefix.replace("%", "") + "%",))


def kv_increment(conn, key: str) -> int:
    """Atomic counter bump; returns the new value."""
    conn.execute("INSERT INTO app_kv (key, value) VALUES (?, '1') "
                 "ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)",
                 (key,))
    row = conn.execute("SELECT value FROM app_kv WHERE key=?", (key,)).fetchone()
    return int(row["value"]) if row else 0
