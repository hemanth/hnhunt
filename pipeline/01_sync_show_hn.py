#!/usr/bin/env python3
"""
Stage 1: Sync Show HN launches from:
  1. Official HN Firebase API (`/v0/showstories.json`) for real-time Show tab launches
  2. Algolia HN Search API (`tags=show_hn`) for rolling 45-day daily launches
  3. Algolia HN Search API (`points>=100` by year window) for All-Time Hall of Fame
  4. Concurrent thread comment enrichment (`items/<id>`) cached in `pipeline/cache/`
"""

import html
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "pipeline" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

STORIES_PATH = CACHE_DIR / "show_hn_stories.json"
THREADS_PATH = CACHE_DIR / "show_hn_threads.json"

ALGOLIA_DATE = "https://hn.algolia.com/api/v1/search_by_date"
ALGOLIA_TOP = "https://hn.algolia.com/api/v1/search"
ALGOLIA_ITEM = "https://hn.algolia.com/api/v1/items"
FIREBASE_SHOW = "https://hacker-news.firebaseio.com/v0/showstories.json"
FIREBASE_ITEM = "https://hacker-news.firebaseio.com/v0/item"

UA = {"User-Agent": "HNHuntDatasetBot/1.0 (+https://github.com/hemanth/hnhunt)"}


def strip_html(raw: str | None) -> str:
    if not raw:
        return ""
    txt = re.sub(r"<p\s*/?>", "\n\n", raw, flags=re.I)
    txt = re.sub(r"<br\s*/?>", "\n", txt, flags=re.I)
    txt = re.sub(r"<a\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", r"\1", txt, flags=re.I | re.S)
    txt = re.sub(r"<pre><code>(.*?)</code></pre>", lambda m: "\n" + html.unescape(m.group(1)).strip() + "\n", txt, flags=re.I | re.S)
    txt = re.sub(r"<[^>]+>", "", txt)
    txt = html.unescape(txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
    return txt


def fetch_algolia_pages(base_url: str, params: dict, max_pages: int = 10) -> list[dict]:
    hits = []
    session = requests.Session()
    session.headers.update(UA)
    for page in range(max_pages):
        q = {**params, "hitsPerPage": 100, "page": page}
        for attempt in range(3):
            try:
                resp = session.get(base_url, params=q, timeout=12)
                if resp.status_code == 200:
                    data = resp.json()
                    batch = data.get("hits") or []
                    hits.extend(batch)
                    if page + 1 >= (data.get("nbPages") or 0) or len(batch) < 100:
                        return hits
                    break
            except Exception:
                time.sleep(0.6 * (attempt + 1))
        time.sleep(0.08)
    return hits


def normalize_algolia_hit(h: dict, live_ids: set[int]) -> dict | None:
    try:
        oid = int(h["objectID"])
    except (KeyError, ValueError, TypeError):
        return None
    title = (h.get("title") or "").strip()
    if not title or "[dead]" in title.lower() or "[flagged]" in title.lower():
        return None
    created_i = int(h.get("created_at_i") or 0)
    if created_i <= 0:
        return None
    return {
        "id": oid,
        "title": title,
        "url": (h.get("url") or "").strip(),
        "author": (h.get("author") or "anon").strip(),
        "points": int(h.get("points") or 0),
        "num_comments": int(h.get("num_comments") or 0),
        "created_at_i": created_i,
        "story_text": strip_html(h.get("story_text")),
        "live_show_tab": oid in live_ids,
    }


def fetch_firebase_live_show() -> tuple[set[int], list[dict]]:
    session = requests.Session()
    session.headers.update(UA)
    try:
        ids = session.get(FIREBASE_SHOW, timeout=10).json() or []
    except Exception as exc:
        print(f"[warn] Firebase showstories fetch failed: {exc}")
        return set(), []

    live_ids = {int(x) for x in ids[:200] if isinstance(x, int)}

    def pull_one(item_id: int) -> dict | None:
        try:
            r = requests.get(f"{FIREBASE_ITEM}/{item_id}.json", headers=UA, timeout=8)
            if r.status_code != 200:
                return None
            it = r.json() or {}
            if it.get("dead") or it.get("deleted") or not it.get("title"):
                return None
            return {
                "id": int(it["id"]),
                "title": str(it["title"]).strip(),
                "url": str(it.get("url") or "").strip(),
                "author": str(it.get("by") or "anon").strip(),
                "points": int(it.get("score") or 0),
                "num_comments": int(it.get("descendants") or 0),
                "created_at_i": int(it.get("time") or 0),
                "story_text": strip_html(it.get("text")),
                "live_show_tab": True,
            }
        except Exception:
            return None

    items = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        for res in pool.map(pull_one, list(live_ids)[:120]):
            if res:
                items.append(res)
    return live_ids, items


def fetch_thread_comments(item_id: int, maker: str) -> dict | None:
    """Fetch top verbatim community & maker comments from Algolia items endpoint."""
    try:
        r = requests.get(f"{ALGOLIA_ITEM}/{item_id}", headers=UA, timeout=10)
        if r.status_code != 200:
            return None
        data = r.json() or {}
    except Exception:
        return None

    story_text = strip_html(data.get("text"))
    children = data.get("children") or []
    extracted = []

    for ch in children:
        author = (ch.get("author") or "").strip()
        txt = strip_html(ch.get("text"))
        if not author or not txt or len(txt) < 18:
            continue
        # Check for one top reply (often the maker answering!)
        sub_replies = []
        for sub in (ch.get("children") or [])[:3]:
            s_auth = (sub.get("author") or "").strip()
            s_txt = strip_html(sub.get("text"))
            if s_auth and s_txt and len(s_txt) >= 16:
                sub_replies.append(
                    {
                        "id": int(sub.get("id") or 0),
                        "by": s_auth,
                        "is_maker": s_auth == maker,
                        "text": s_txt[:600],
                        "ts": int(sub.get("created_at_i") or 0),
                    }
                )
                if s_auth == maker:
                    break
        extracted.append(
            {
                "id": int(ch.get("id") or 0),
                "by": author,
                "is_maker": author == maker,
                "text": txt[:750],
                "ts": int(ch.get("created_at_i") or 0),
                "reply_count": len(ch.get("children") or []),
                "replies": sub_replies[:1],
            }
        )

    # Prioritize maker top-level notes + lively community feedback
    extracted.sort(
        key=lambda c: (1 if c["is_maker"] else 0, min(c["reply_count"], 6), min(len(c["text"]), 420)),
        reverse=True,
    )
    return {
        "story_text": story_text[:1600] if story_text else "",
        "comments": extracted[:6],
        "fetched_at": int(time.time()),
    }


def main():
    existing: dict[int, dict] = {}
    if STORIES_PATH.exists():
        try:
            raw = json.loads(STORIES_PATH.read_text(encoding="utf-8"))
            for row in raw:
                existing[int(row["id"])] = row
        except Exception:
            existing = {}

    threads_cache: dict[str, dict] = {}
    if THREADS_PATH.exists():
        try:
            threads_cache = json.loads(THREADS_PATH.read_text(encoding="utf-8"))
        except Exception:
            threads_cache = {}

    now_ts = int(time.time())
    print("[1/4] Fetching live Show HN tab from Firebase...")
    live_ids, live_items = fetch_firebase_live_show()
    for row in existing.values():
        row["live_show_tab"] = row["id"] in live_ids
    for item in live_items:
        existing[item["id"]] = item
    print(f"      Live Show tab items: {len(live_items)}")

    # Rolling 35-day daily launches (captures Today, Yesterday, Week, Month completely)
    cutoff_35d = now_ts - 35 * 86400
    print("[2/4] Syncing rolling 35-day Show HN launches via Algolia...")
    recent_hits = fetch_algolia_pages(
        ALGOLIA_DATE,
        {"tags": "show_hn", "numericFilters": f"created_at_i>={cutoff_35d}"},
        max_pages=10,
    )
    for h in recent_hits:
        norm = normalize_algolia_hit(h, live_ids)
        if norm:
            prev = existing.get(norm["id"])
            if prev and prev.get("story_text") and not norm["story_text"]:
                norm["story_text"] = prev["story_text"]
            existing[norm["id"]] = norm
    print(f"      Rolling 35-day hits processed: {len(recent_hits)} (store total: {len(existing)})")

    # Bootstrap All-Time Iconic Show HN Hall of Fame if store is fresh (or FULL_BACKFILL=1)
    if len(existing) < 1800 or os.environ.get("FULL_BACKFILL") == "1":
        print("[3/4] Backfilling iconic Show HN Hall of Fame (2012-present, points>=120)...")
        year_windows = [
            (2012, 2016),
            (2016, 2019),
            (2019, 2021),
            (2021, 2023),
            (2023, 2024),
            (2024, 2025),
            (2025, 2026),
            (2026, 2027),
        ]
        for y0, y1 in year_windows:
            t0 = int(datetime(y0, 1, 1, tzinfo=timezone.utc).timestamp())
            t1 = int(datetime(y1, 1, 1, tzinfo=timezone.utc).timestamp())
            min_pts = 50 if y0 >= 2026 else 120
            whits = fetch_algolia_pages(
                ALGOLIA_TOP,
                {
                    "tags": "show_hn",
                    "numericFilters": f"created_at_i>={t0},created_at_i<{t1},points>={min_pts}",
                },
                max_pages=6,
            )
            for h in whits:
                norm = normalize_algolia_hit(h, live_ids)
                if norm:
                    existing[norm["id"]] = norm
            print(f"      Window {y0}-{y1}: +{len(whits)} hits -> {len(existing)} unique Show HNs")
    else:
        print("[3/4] Skipping historical backfill (already cached); syncing top 90-day movers...")
        cutoff_90d = now_ts - 90 * 86400
        movers = fetch_algolia_pages(
            ALGOLIA_TOP,
            {"tags": "show_hn", "numericFilters": f"created_at_i>={cutoff_90d},points>=15"},
            max_pages=4,
        )
        for h in movers:
            norm = normalize_algolia_hit(h, live_ids)
            if norm:
                existing[norm["id"]] = norm

    # Filter out extreme noise on older items (keep all last-14-day launches >= 2 pts; older >= 5 pts)
    cutoff_14d = now_ts - 14 * 86400
    filtered = [
        v
        for v in existing.values()
        if (v["created_at_i"] >= cutoff_14d and v["points"] >= 2)
        or v["live_show_tab"]
        or v["points"] >= 8
    ]
    filtered.sort(key=lambda r: (r["created_at_i"], r["points"]), reverse=True)

    # Enrich top & recent active threads with verbatim HN comments
    candidates = []
    for r in filtered:
        sid = str(r["id"])
        if r["num_comments"] <= 0:
            continue
        cached = threads_cache.get(sid)
        is_recent = r["created_at_i"] >= (now_ts - 5 * 86400)
        if not cached or (is_recent and now_ts - cached.get("fetched_at", 0) > 21600):
            if is_recent or r["points"] >= 40 or r["live_show_tab"]:
                candidates.append(r)

    candidates = sorted(
        candidates,
        key=lambda r: (1 if r["live_show_tab"] else 0, r["created_at_i"] >= cutoff_14d, r["points"]),
        reverse=True,
    )[:260]

    print(f"[4/4] Enriching {len(candidates)} active threads with verbatim maker & HN comments...")
    if candidates:
        with ThreadPoolExecutor(max_workers=14) as pool:
            fut_map = {pool.submit(fetch_thread_comments, r["id"], r["author"]): r for r in candidates}
            for fut in as_completed(fut_map):
                r = fut_map[fut]
                res = fut.result()
                if res is not None:
                    threads_cache[str(r["id"])] = res
                    if res.get("story_text") and not r.get("story_text"):
                        r["story_text"] = res["story_text"]

    STORIES_PATH.write_text(json.dumps(filtered, ensure_ascii=False), encoding="utf-8")
    THREADS_PATH.write_text(json.dumps(threads_cache, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(filtered)} Show HN launches & {len(threads_cache)} enriched threads -> {CACHE_DIR}")


if __name__ == "__main__":
    main()
