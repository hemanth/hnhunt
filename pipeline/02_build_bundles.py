#!/usr/bin/env python3
"""
Stage 2: Transform raw Show HN records into:
  - `public/data/meta.json`
  - `public/data/feed.json` (compact fast index for browser & Worker)
  - `public/data/details/0..9.json` (maker notes + verbatim HN comments sharded by id % 10)
  - `public/data/hnhunt-dataset.json` (canonical full export for Hugging Face & researchers)
"""

import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "pipeline" / "cache"
DATA_DIR = ROOT / "public" / "data"
DETAILS_DIR = DATA_DIR / "details"

TOPIC_RULES: list[tuple[str, re.Pattern]] = [
    ("ai", re.compile(r"\b(ai|llm|llms|gpt|claude|gemini|onnx|agent|agents|mcp|rag|whisper|tts|embedding|neural|ml|model|diffusion|voice)\b", re.I)),
    ("devtools", re.compile(r"\b(sdk|api|ide|git|debug|linter|compiler|parser|benchmark|profiler|testing|webhook|regex|json|docker|kubernetes|k8s|ci|wasm|devtools?)\b", re.I)),
    ("cli", re.compile(r"\b(cli|tui|terminal|shell|bash|zsh|vim|neovim|tmux|ncurses|command[- ]line)\b", re.I)),
    ("data", re.compile(r"\b(sqlite|postgres|postgresql|duckdb|parquet|sql|database|analytics|vector|csv|etl|olap|redis|storage|graph)\b", re.I)),
    ("systems", re.compile(r"\b(rust|zig|c\+\+|kernel|linux|ebpf|os|allocator|vm|unikernel|embedded|wasm|simd|distributed|proxy)\b", re.I)),
    ("web", re.compile(r"\b(browser|css|html|javascript|typescript|react|svelte|canvas|webgl|webgpu|extension|chrome|cloudflare|static|rss|bookmark)\b", re.I)),
    ("design", re.compile(r"\b(font|typography|svg|figma|color|icon|icons|diagram|ui|canvas|shader|animation|video|photo|draw|sketch|editor)\b", re.I)),
    ("security", re.compile(r"\b(auth|oauth|passkey|encryption|crypto|e2ee|zero[- ]knowledge|privacy|vault|firewall|sandbox|scanner|ssh|tls)\b", re.I)),
    ("hardware", re.compile(r"\b(esp32|arduino|fpga|pcb|raspberry|sdr|radio|robot|sensor|3d[- ]print|keyboard|e-ink|hardware)\b", re.I)),
    ("games", re.compile(r"\b(game|puzzle|chess|wordle|multiplayer|arcade|pixel|rpg|roguelike|simulator|synth|music)\b", re.I)),
]

OPEN_SOURCE_HOSTS = {"github.com", "gitlab.com", "codeberg.org", "sr.ht", "git.sr.ht"}


def parse_domain_and_repo(url: str) -> tuple[str, str, bool]:
    if not url:
        return "news.ycombinator.com", "", False
    try:
        p = urlparse(url)
        host = (p.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        path_parts = [seg for seg in (p.path or "").split("/") if seg]
        if host in OPEN_SOURCE_HOSTS and len(path_parts) >= 2:
            slug = f"{path_parts[0]}/{path_parts[1]}"
            slug = re.sub(r"\.git$", "", slug)
            return f"{host}/{slug}" if host != "github.com" else f"github.com/{slug}", slug, True
        is_oss = host in OPEN_SOURCE_HOSTS or host.endswith(".github.io")
        return host or "news.ycombinator.com", "", is_oss
    except Exception:
        return "news.ycombinator.com", "", False


def split_show_hn_title(raw_title: str, story_text: str, domain: str, repo_slug: str) -> tuple[str, str]:
    clean = re.sub(r"^\s*show\s+hn\s*[:\-–—]\s*", "", raw_title, flags=re.I).strip()
    clean = re.sub(r"\s+", " ", clean)

    # Explicit delimiter: `Product – Tagline` or `Product: Tagline` or `Product — Tagline`
    for pattern in [
        r"^([^–—]{2,44}?)\s+[–—]\s+(.{8,})$",
        r"^([^:\-]{2,40}?)\s+-\s+(.{8,})$",
        r"^([^:]{2,40}?):\s+(.{8,})$",
        r"^([^\(]{2,36}?)\s+\(([^)]{10,})\)$",
    ]:
        m = re.match(pattern, clean)
        if m:
            left, right = m.group(1).strip(), m.group(2).strip()
            # Avoid splitting if left side starts like a full narrative clause ("I built", "How we", "Why I")
            if not re.match(r"^(i |we |my |a |an |the |how |why |what |building |making )", left, re.I):
                return left, right[0].upper() + right[1:] if right else ""

    # Comma appositive: "Foo, a fast local..."
    m_comma = re.match(r"^([A-Z0-9][A-Za-z0-9._\-+ ]{1,30}),\s+((?:a|an|the|open[- ]source|minimal|fast|free|local)\b.{10,})$", clean)
    if m_comma:
        left, right = m_comma.group(1).strip(), m_comma.group(2).strip()
        return left, right[0].upper() + right[1:]

    # If the whole title is short (<= 36 chars), it IS the product name; pull tagline from story_text!
    if len(clean) <= 36:
        first_line = ""
        if story_text:
            first_sent = re.split(r"(?<=[.!?])\s+|\n+", story_text.strip())[0].strip()
            if 12 <= len(first_sent) <= 160 and not first_sent.startswith("http"):
                first_line = first_sent
        return clean, first_line or f"Launched on {domain}"

    # Otherwise it's a descriptive sentence ("I built a local-first PDF reader in Rust"):
    # Use repo name or clean domain brand if crisp, else keep full clean sentence as tagline + concise name
    if repo_slug:
        repo_name = repo_slug.split("/")[-1]
        return repo_name, clean
    base_host = domain.split("/")[0]
    if base_host not in ("news.ycombinator.com", "github.com", "youtube.com", "youtu.be", "pypi.org", "npmjs.com"):
        brand = base_host.split(".")[0]
        if 2 <= len(brand) <= 22 and brand not in ("app", "get", "use", "try", "docs", "blog", "demo"):
            pretty = brand[0].upper() + brand[1:]
            return pretty, clean

    return clean, ""


def classify_topics(text: str, is_oss: bool) -> list[str]:
    found = []
    if is_oss:
        found.append("open-source")
    for name, rx in TOPIC_RULES:
        if rx.search(text):
            found.append(name)
        if len(found) >= 4:
            break
    if not found:
        found.append("web")
    return found


def first_sentence_excerpt(story_text: str) -> str:
    if not story_text:
        return ""
    flat = re.sub(r"\s+", " ", story_text).strip()
    return flat[:220] + ("…" if len(flat) > 220 else "")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DETAILS_DIR.mkdir(parents=True, exist_ok=True)

    stories = json.loads((CACHE_DIR / "show_hn_stories.json").read_text(encoding="utf-8"))
    threads = json.loads((CACHE_DIR / "show_hn_threads.json").read_text(encoding="utf-8"))

    now_dt = datetime.now(timezone.utc)
    now_ts = int(now_dt.timestamp())

    dataset_rows = []
    feed_rows = []
    shards: dict[str, dict] = {str(i): {} for i in range(10)}
    topic_counts: Counter = Counter()
    oss_count = 0

    for s in stories:
        oid = int(s["id"])
        raw_title = s["title"]
        url = s.get("url") or f"https://news.ycombinator.com/item?id={oid}"
        tinfo = threads.get(str(oid)) or {}
        story_text = (tinfo.get("story_text") or s.get("story_text") or "").strip()

        domain, repo_slug, is_oss = parse_domain_and_repo(s.get("url") or "")
        if re.search(r"\b(open[- ]source|mit license|apache[- ]2|gpl|agpl)\b", f"{raw_title} {story_text}", re.I):
            is_oss = True
        if is_oss:
            oss_count += 1

        name, tagline = split_show_hn_title(raw_title, story_text, domain, repo_slug)
        topics = classify_topics(f"{raw_title} {tagline} {story_text[:300]} {domain}", is_oss)
        for tp in topics:
            topic_counts[tp] += 1

        created_i = int(s["created_at_i"])
        dt = datetime.fromtimestamp(created_i, tz=timezone.utc)
        launch_date = dt.strftime("%Y-%m-%d")

        pts = int(s["points"])
        n_com = int(s["num_comments"])
        live_tab = bool(s.get("live_show_tab"))

        # Balanced hunt score (rewards genuine maker discussion + traction; time-decayed for featured feed)
        age_hours = max(1.0, (now_ts - created_i) / 3600.0)
        hot_score = round((pts + 1.35 * n_com + (12 if live_tab else 0)) / ((age_hours + 6.0) ** 1.15) * 100.0, 3)

        # Hidden gem score: deep discussion relative to modest points (15 <= points <= 220)
        gem_score = 0.0
        if 10 <= pts <= 260 and n_com >= 6:
            gem_score = round((n_com / math.sqrt(pts + 4.0)) * (1.15 if is_oss else 1.0), 3)

        hn_comments = tinfo.get("comments") or []
        shard_key = str(oid % 10)
        if story_text or hn_comments:
            shards[shard_key][str(oid)] = {
                "pitch": story_text,
                "hn_comments": hn_comments,
            }

        # Compact feed item for fast client boot
        feed_rows.append(
            {
                "id": oid,
                "n": name,
                "t": tagline,
                "u": url,
                "d": domain,
                "by": s["author"],
                "p": pts,
                "c": n_com,
                "ts": created_i,
                "dt": launch_date,
                "tp": topics,
                "oss": 1 if is_oss else 0,
                "live": 1 if live_tab else 0,
                "hot": hot_score,
                "gem": gem_score,
            }
        )

        # Canonical dataset item for Hugging Face & researchers
        dataset_rows.append(
            {
                "id": oid,
                "product_name": name,
                "tagline": tagline,
                "raw_title": raw_title,
                "url": url,
                "hn_url": f"https://news.ycombinator.com/item?id={oid}",
                "domain": domain,
                "repo_slug": repo_slug,
                "is_open_source": is_oss,
                "topics": topics,
                "maker": s["author"],
                "hn_points": pts,
                "hn_comments": n_com,
                "created_at_unix": created_i,
                "launch_date": launch_date,
                "year": dt.year,
                "live_show_tab": live_tab,
                "gem_score": gem_score,
                "maker_pitch": story_text,
                "top_comment_by": hn_comments[0]["by"] if hn_comments else "",
                "top_comment_text": hn_comments[0]["text"] if hn_comments else "",
            }
        )

    # Sort canonical dataset by newest first, then points
    feed_rows.sort(key=lambda r: (r["ts"], r["p"]), reverse=True)
    dataset_rows.sort(key=lambda r: (r["created_at_unix"], r["hn_points"]), reverse=True)

    cutoff_35d = now_ts - 35 * 86400
    recent_ids = {r["id"] for r in feed_rows if r["ts"] >= cutoff_35d or r["live"] == 1}
    top_gems = sorted([r for r in feed_rows if r["gem"] > 0], key=lambda r: r["gem"], reverse=True)[:120]
    for g in top_gems:
        recent_ids.add(g["id"])
    recent_rows = [r for r in feed_rows if r["id"] in recent_ids]

    meta = {
        "generated_at": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_date": now_dt.strftime("%Y-%m-%d"),
        "total_launches": len(dataset_rows),
        "recent_launches": len(recent_rows),
        "open_source_launches": oss_count,
        "enriched_threads": sum(len(v) for v in shards.values()),
        "hf_dataset": "gnumanth/hnhunt",
        "topics": [{"id": k, "count": v} for k, v in topic_counts.most_common()],
    }

    (DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (DATA_DIR / "recent.json").write_text(json.dumps(recent_rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (DATA_DIR / "feed.json").write_text(json.dumps(feed_rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (DATA_DIR / "hnhunt-dataset.json").write_text(
        json.dumps(dataset_rows, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    for k, payload in shards.items():
        (DETAILS_DIR / f"{k}.json").write_text(
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
        )

    feed_kb = (DATA_DIR / "feed.json").stat().st_size / 1024
    print(f"Built bundles: {len(feed_rows)} launches ({feed_kb:.1f} KB feed.json), {meta['enriched_threads']} detail shards")


if __name__ == "__main__":
    main()
