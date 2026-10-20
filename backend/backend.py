import sys
import json
import sqlite3
import random
import datetime
import urllib.request

from quotes_data import QUOTES, CATEGORY_ORDER

API_BASE = "https://dummyjson.com/quotes"
ONLINE_CATEGORY = "Online"
HTTP_TIMEOUT = 8
PAGE_SIZE = 50
MAX_PAGES = 60

DEFAULT_SETTINGS = {
    "theme": "aurora",
    "mode": "dark",
    "blur": "28",
    "default_category": "All",
    "auto_save": "1",
    "online_enabled": "0",
}

VALID_THEMES = {"aurora", "ocean", "sunset", "forest", "rose", "graphite"}
VALID_MODES = {"dark", "light"}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def open_db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS history ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "text TEXT NOT NULL,"
        "author TEXT NOT NULL,"
        "category TEXT NOT NULL,"
        "created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings ("
        "key TEXT PRIMARY KEY,"
        "value TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS library ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "text TEXT NOT NULL,"
        "author TEXT NOT NULL,"
        "category TEXT NOT NULL,"
        "source TEXT NOT NULL,"
        "created_at TEXT NOT NULL,"
        "UNIQUE(text, author))"
    )
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
    stamp = now_iso()
    conn.executemany(
        "INSERT OR IGNORE INTO library (text, author, category, source, created_at) VALUES (?, ?, ?, 'builtin', ?)",
        [(q["text"], q["author"], q["category"], stamp) for q in QUOTES],
    )
    conn.commit()
    return conn


def get_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {row["key"]: row["value"] for row in rows}


def insert_history(conn, text, author, category, created_at):
    cursor = conn.execute(
        "INSERT INTO history (text, author, category, created_at) VALUES (?, ?, ?, ?)",
        (text, author, category, created_at),
    )
    conn.commit()
    return cursor.lastrowid


def save_library(conn, text, author, category, source):
    cursor = conn.execute(
        "INSERT OR IGNORE INTO library (text, author, category, source, created_at) VALUES (?, ?, ?, ?, ?)",
        (text, author, category, source, now_iso()),
    )
    return cursor.rowcount > 0


def fetch_json(url):
    request = urllib.request.Request(
        url, headers={"User-Agent": "Quotist/1.1", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize(raw):
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("quote") or "").strip()
    author = str(raw.get("author") or "").strip() or "Unknown"
    if not text:
        return None
    return {"text": text, "author": author}


def fetch_online(conn):
    item = normalize(fetch_json(API_BASE + "/random"))
    if item is None:
        raise ValueError("Empty response")
    save_library(conn, item["text"], item["author"], ONLINE_CATEGORY, "online")
    conn.commit()
    item["category"] = ONLINE_CATEGORY
    item["source"] = "online"
    return item


def pick_local(conn, category, keyword, last):
    sql = "SELECT text, author, category, source FROM library"
    clauses = []
    params = []
    if category != "All":
        clauses.append("category = ?")
        params.append(category)
    if keyword:
        like = "%" + keyword + "%"
        clauses.append("(LOWER(text) LIKE ? OR LOWER(author) LIKE ?)")
        params.extend([like, like])
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return None
    candidates = [row for row in rows if row["text"] != last] or rows
    return dict(random.choice(candidates))


def library_stats(conn):
    rows = conn.execute("SELECT source, COUNT(*) AS n FROM library GROUP BY source").fetchall()
    counts = {row["source"]: row["n"] for row in rows}
    return {
        "total": sum(counts.values()),
        "builtin": counts.get("builtin", 0),
        "online": counts.get("online", 0),
    }


def action_categories(conn, payload):
    rows = conn.execute("SELECT DISTINCT category FROM library").fetchall()
    present = {row["category"] for row in rows}
    ordered = [name for name in CATEGORY_ORDER if name in present]
    extra = sorted(present - set(CATEGORY_ORDER))
    return ["All"] + ordered + extra


def action_settings_get(conn, payload):
    return get_settings(conn)


def action_settings_set(conn, payload):
    key = payload.get("key")
    value = str(payload.get("value"))
    if key not in DEFAULT_SETTINGS:
        raise ValueError("Unknown setting")
    if key == "theme" and value not in VALID_THEMES:
        raise ValueError("Unknown theme")
    if key == "mode" and value not in VALID_MODES:
        raise ValueError("Unknown mode")
    if key == "blur":
        value = str(max(0, min(60, int(float(value)))))
    if key in ("auto_save", "online_enabled") and value not in {"0", "1"}:
        raise ValueError("Invalid value")
    if key == "default_category" and value not in action_categories(conn, {}):
        raise ValueError("Unknown category")
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()
    return get_settings(conn)


def action_generate(conn, payload):
    settings = get_settings(conn)
    category = payload.get("category") or "All"
    keyword = (payload.get("keyword") or "").strip().lower()
    last = payload.get("last") or ""
    wants_online = (
        settings.get("online_enabled") == "1"
        and not keyword
        and category in ("All", ONLINE_CATEGORY)
    )
    quote = None
    offline_fallback = False
    if wants_online:
        try:
            quote = fetch_online(conn)
        except (OSError, ValueError):
            offline_fallback = True
    if quote is None:
        quote = pick_local(conn, category, keyword, last)
    if quote is None:
        raise ValueError("No quotes match this category and keyword. Try a different keyword.")
    quote["created_at"] = now_iso()
    quote["id"] = None
    quote["offline_fallback"] = offline_fallback
    if settings.get("auto_save") == "1":
        quote["id"] = insert_history(conn, quote["text"], quote["author"], quote["category"], quote["created_at"])
    return quote


def action_library_stats(conn, payload):
    return library_stats(conn)


def action_library_sync(conn, payload):
    added = 0
    skip = 0
    pages = 0
    partial = False
    try:
        while pages < MAX_PAGES:
            data = fetch_json("%s?limit=%d&skip=%d" % (API_BASE, PAGE_SIZE, skip))
            items = data.get("quotes") or []
            if not items:
                break
            for raw in items:
                item = normalize(raw)
                if item and save_library(conn, item["text"], item["author"], ONLINE_CATEGORY, "online"):
                    added += 1
            pages += 1
            skip += len(items)
            total = data.get("total")
            if isinstance(total, int) and skip >= total:
                break
    except (OSError, ValueError):
        conn.commit()
        if added == 0:
            raise ValueError("Could not reach the online source. Check your connection and try again.")
        partial = True
    conn.commit()
    return {"added": added, "partial": partial, "stats": library_stats(conn)}


def action_history_add(conn, payload):
    text = str(payload.get("text") or "").strip()
    author = str(payload.get("author") or "").strip()
    category = str(payload.get("category") or "").strip()
    if not text:
        raise ValueError("Nothing to save")
    created_at = str(payload.get("created_at") or now_iso())
    return {"id": insert_history(conn, text, author, category, created_at)}


def action_history_list(conn, payload):
    search = (payload.get("search") or "").strip()
    if search:
        like = "%" + search + "%"
        rows = conn.execute(
            "SELECT * FROM history WHERE text LIKE ? OR author LIKE ? OR category LIKE ? ORDER BY id DESC",
            (like, like, like),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM history ORDER BY id DESC").fetchall()
    return [dict(row) for row in rows]


def action_history_delete(conn, payload):
    conn.execute("DELETE FROM history WHERE id = ?", (int(payload.get("id")),))
    conn.commit()
    return True


def action_history_clear(conn, payload):
    conn.execute("DELETE FROM history")
    conn.commit()
    return True


ACTIONS = {
    "categories": action_categories,
    "settings_get": action_settings_get,
    "settings_set": action_settings_set,
    "generate": action_generate,
    "library_stats": action_library_stats,
    "library_sync": action_library_sync,
    "history_add": action_history_add,
    "history_list": action_history_list,
    "history_delete": action_history_delete,
    "history_clear": action_history_clear,
}


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    conn = open_db(sys.argv[1])
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            handler = ACTIONS.get(request.get("action"))
            if handler is None:
                raise ValueError("Unknown action")
            data = handler(conn, request.get("payload") or {})
            response = {"id": request_id, "ok": True, "data": data}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": str(exc)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
