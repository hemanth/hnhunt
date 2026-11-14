#!/usr/bin/env python3
"""
Stage 4: Publish / update the `gnumanth/hnhunt` dataset on Hugging Face Hub
(`data/train-00000-of-00001.parquet` + `hnhunt.jsonl` + Dataset Card `README.md`).
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import CommitOperationAdd, HfApi

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"
REPO_ID = os.environ.get("HF_DATASET_REPO", "gnumanth/hnhunt")
LIVE_URL = os.environ.get("HNHUNT_PUBLIC_URL", "https://h3manth.com/fun/hnhunt")


def get_hf_token() -> str | None:
    tok = os.environ.get("HF_TOKEN", "").strip()
    if tok:
        return tok
    tok_file = Path.home() / ".cache" / "huggingface" / "token"
    if tok_file.exists():
        return tok_file.read_text(encoding="utf-8").strip()
    return None


def size_cat(n: int) -> str:
    if n < 1000:
        return "n<1K"
    if n < 10000:
        return "1K<n<10K"
    return "10K<n<100K"


def build_dataset_card(meta: dict, n_rows: int) -> str:
    gen_date = meta.get("generated_date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    oss = meta.get("open_source_launches", 0)
    return f"""---
license: mit
task_categories:
  - text-retrieval
  - tabular-classification
  - feature-extraction
language:
  - en
tags:
  - hacker-news
  - show-hn
  - startups
  - open-source
  - developer-tools
  - product-launches
pretty_name: HNHunt — Daily Enriched Show HN Product Launches Dataset
size_categories:
  - {size_cat(n_rows)}
configs:
  - config_name: default
    data_files:
      - split: train
        path: data/train-00000-of-00001.parquet
---

# HNHunt Dataset (`{REPO_ID}`)

**{n_rows:,}** normalized **Show HN** product launches (**{oss:,}** open-source) synced from Hacker News via the official Firebase & Algolia APIs through **{gen_date}** — **updated automatically every day via GitHub Actions**.

Live product board: **[hnhunt]({LIVE_URL})** · Source & pipeline: **[github.com/hemanth/hnhunt](https://github.com/hemanth/hnhunt)**

## What's Inside

- **Clean Product Name & Tagline Splitting**: Separates raw `"Show HN: Product – One-line pitch"` titles into structured `product_name` and `tagline` fields, falling back to maker `story_text` excerpts when titles omit a pitch.
- **Open-Source & Repository Resolution**: Extracts canonical `domain`, `repo_slug` (`owner/repo` across GitHub, GitLab, Codeberg, sourcehut), and `is_open_source`.
- **Maker Pitches & Verbatim Community Signal**: Includes `maker_pitch`, `top_comment_by`, `top_comment_text`, `gem_score` (high discussion-to-points technical launches), and deterministic topic tags (`ai`, `devtools`, `open-source`, `cli`, `data`, `systems`, `web`, `design`, `security`, `hardware`, `games`).

## Quick Start (Python `datasets`)

```python
from datasets import load_dataset

ds = load_dataset("{REPO_ID}", split="train")
for row in ds.select(range(5)):
    print(row["launch_date"], row["product_name"], "—", row["tagline"], f"({{row['hn_points']}} pts)")
```

## Query Directly with DuckDB

```sql
SELECT launch_date, product_name, tagline, domain, hn_points, hn_comments
FROM 'hf://datasets/{REPO_ID}/data/train-00000-of-00001.parquet'
WHERE is_open_source = true
ORDER BY created_at_unix DESC
LIMIT 20;
```

## Schema

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `int64` | Hacker News item ID |
| `product_name` | `string` | Parsed product or project name |
| `tagline` | `string` | Parsed one-line pitch |
| `raw_title` | `string` | Original `Show HN:` submission title |
| `url` | `string` | External product or repository URL |
| `hn_url` | `string` | Hacker News thread URL |
| `domain` | `string` | Normalized host or `github.com/owner/repo` |
| `repo_slug` | `string` | `owner/repo` when hosted on GitHub/GitLab/Codeberg/sr.ht |
| `is_open_source` | `bool` | Whether hosted on a code forge or explicitly open-source licensed |
| `topics` | `list<string>` | Classified topic tags |
| `maker` | `string` | HN username of the creator |
| `hn_points` | `int32` | Upvote score on Hacker News |
| `hn_comments` | `int32` | Total comment count on Hacker News |
| `created_at_unix` | `int64` | Launch Unix timestamp (UTC) |
| `launch_date` | `string` | UTC calendar date (`YYYY-MM-DD`) |
| `year` | `int32` | UTC launch year |
| `live_show_tab` | `bool` | Present on live HN `/show` frontpage at sync time |
| `gem_score` | `float64` | High discussion-to-points hidden-gem score |
| `maker_pitch` | `string` | Maker's plain-text Show HN note (if provided) |
| `top_comment_by` | `string` | Author of featured thread comment |
| `top_comment_text` | `string` | Featured verbatim HN comment |

## License

MIT © [Hemanth HM](https://h3manth.com)
"""


def main():
    token = get_hf_token()
    meta = json.loads((DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    dataset = json.loads((DATA_DIR / "hnhunt-dataset.json").read_text(encoding="utf-8"))

    schema = pa.schema(
        [
            ("id", pa.int64()),
            ("product_name", pa.string()),
            ("tagline", pa.string()),
            ("raw_title", pa.string()),
            ("url", pa.string()),
            ("hn_url", pa.string()),
            ("domain", pa.string()),
            ("repo_slug", pa.string()),
            ("is_open_source", pa.bool_()),
            ("topics", pa.list_(pa.string())),
            ("maker", pa.string()),
            ("hn_points", pa.int32()),
            ("hn_comments", pa.int32()),
            ("created_at_unix", pa.int64()),
            ("launch_date", pa.string()),
            ("year", pa.int32()),
            ("live_show_tab", pa.bool_()),
            ("gem_score", pa.float64()),
            ("maker_pitch", pa.string()),
            ("top_comment_by", pa.string()),
            ("top_comment_text", pa.string()),
        ]
    )

    tmp_pq = ROOT / "pipeline" / "cache" / "hf_train.parquet"
    tmp_pq.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pylist(dataset, schema=schema)
    pq.write_table(tbl, tmp_pq, compression="zstd")
    pq_bytes = tmp_pq.read_bytes()

    jsonl_bytes = "\n".join(json.dumps(r, ensure_ascii=False) for r in dataset).encode("utf-8")
    readme_bytes = build_dataset_card(meta, len(dataset)).encode("utf-8")

    api = HfApi(token=token)
    print(f"[1/2] Ensuring dataset repo {REPO_ID} exists on Hugging Face Hub...")
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", private=False, exist_ok=True)

    print(
        f"[2/2] Uploading Parquet ({len(pq_bytes)/1024:.1f} KB), JSONL ({len(jsonl_bytes)/1024:.1f} KB), and Dataset Card..."
    )
    api.create_commit(
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=f"Daily Show HN dataset sync ({meta.get('generated_date')}, {len(dataset):,} launches)",
        operations=[
            CommitOperationAdd(path_in_repo="README.md", path_or_fileobj=readme_bytes),
            CommitOperationAdd(path_in_repo="data/train-00000-of-00001.parquet", path_or_fileobj=pq_bytes),
            CommitOperationAdd(path_in_repo="hnhunt.jsonl", path_or_fileobj=jsonl_bytes),
        ],
    )
    print(f"Published dataset -> https://huggingface.co/datasets/{REPO_ID}")


if __name__ == "__main__":
    main()
