#!/usr/bin/env python3
"""Stage 3: Validate generated JSON bundles and schema invariants."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"


def main():
    meta = json.loads((DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    feed = json.loads((DATA_DIR / "feed.json").read_text(encoding="utf-8"))
    dataset = json.loads((DATA_DIR / "hnhunt-dataset.json").read_text(encoding="utf-8"))

    assert len(feed) >= 200, f"Expected >= 200 launches in feed.json, got {len(feed)}"
    assert len(feed) == len(dataset), "feed.json and hnhunt-dataset.json row counts diverged"
    assert meta["total_launches"] == len(feed), "meta.json total_launches mismatch"

    seen = set()
    for row in feed:
        assert isinstance(row["id"], int) and row["id"] > 0
        assert row["id"] not in seen, f"Duplicate id {row['id']}"
        seen.add(row["id"])
        assert row["n"] and isinstance(row["n"], str)
        assert row["dt"] and len(row["dt"]) == 10

    for d in range(10):
        shard_file = DATA_DIR / "details" / f"{d}.json"
        assert shard_file.exists(), f"Missing detail shard {shard_file}"
        json.loads(shard_file.read_text(encoding="utf-8"))

    print(f"[ok] Validated {len(feed)} Show HN launches, 10 detail shards, generated_at={meta['generated_at']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[fail] Validation error: {exc}", file=sys.stderr)
        sys.exit(1)
