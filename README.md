# hnhunt

Minimal daily product board for Show HN launches from Hacker News, backed by a daily Hugging Face dataset.

Live: [h3manth.com/fun/hnhunt](https://h3manth.com/fun/hnhunt/) · Dataset: [gnumanth/hnhunt](https://huggingface.co/datasets/gnumanth/hnhunt)

```bash
uv sync
```

## Quick start

```bash
uv run python -m http.server 8096 --directory public
```

`public/` runs standalone against precomputed JSON shards in `public/data/`, or on Cloudflare Workers with a SQLite Durable Object (`HNHuntStore`) for global up/down voting, comments, Markdown content negotiation, and MCP tools.

## Daily dataset sync

```bash
uv run python pipeline/01_sync_show_hn.py
uv run python pipeline/02_build_bundles.py
uv run python pipeline/03_validate.py
uv run python pipeline/04_publish_hf.py
```

`01_sync_show_hn.py` pulls live `/v0/showstories` from Firebase plus rolling daily launches and Hall-of-Fame threads from Algolia. `02_build_bundles.py` splits raw `Show HN:` titles into clean `product_name` and `tagline` fields, resolves open-source repo slugs, and writes `public/data/`. `04_publish_hf.py` publishes Parquet and JSONL shards to `gnumanth/hnhunt`. `.github/workflows/daily-update.yml` runs the full loop every day at `06:00 UTC`.

## Load the dataset

```python
from datasets import load_dataset

ds = load_dataset("gnumanth/hnhunt", split="train")
print(ds[0]["product_name"], ds[0]["tagline"], ds[0]["url"])
```

Or query directly with DuckDB:

```sql
SELECT launch_date, product_name, tagline, domain, hn_points
FROM 'hf://datasets/gnumanth/hnhunt/data/train-00000-of-00001.parquet'
WHERE is_open_source = true
ORDER BY created_at_unix DESC
LIMIT 15;
```

## Deploy

```bash
npx wrangler deploy
```

Deploys static assets, REST endpoints (`/api/launches`, `/api/vote`, `/api/comment`), Markdown content negotiation (`Accept: text/markdown`), and the `/mcp` server.

## Keyboard shortcuts

- `j` / `k` — move through launches
- `u` / `d` — upvote or downvote focused launch
- `Enter` — open maker note and comment drawer
- `/` — focus search
- `Esc` — close drawer

## License

MIT © [Hemanth.HM](https://h3manth.com)
