#!/usr/bin/env python3
"""
Render crisp 1200x630 Open Graph card (`public/og.png`) from real Show HN launches.
"""

import html
import json
import subprocess
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"
OUT_PNG = ROOT / "public" / "og.png"
TMP_HTML = ROOT / "pipeline" / "cache" / "og_card.html"
TMP_RAW = ROOT / "pipeline" / "cache" / "og_raw.png"


def main():
    meta = json.loads((DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    recent = json.loads((DATA_DIR / "recent.json").read_text(encoding="utf-8"))

    # Pick 3 crisp, well-formed recent launches with taglines
    picks = [r for r in recent if r.get("t") and 8 <= len(r["n"]) <= 28 and r["p"] >= 15][:3]
    if len(picks) < 3:
        picks = [r for r in recent if r.get("t")][:3]

    rows_html = ""
    for idx, r in enumerate(picks, 1):
        ch = html.escape((r["n"][0] if r["n"] else "H").upper())
        name = html.escape(r["n"])
        tag = html.escape(r["t"][:68] + ("…" if len(r["t"]) > 68 else ""))
        dom = html.escape(r["d"][:36])
        pts = int(r["p"])
        coms = int(r["c"])
        rows_html += f"""
        <div class="row">
          <div class="mono">{ch}</div>
          <div class="main">
            <div class="line1"><span class="nm">{name}</span> <span class="tg">{tag}</span></div>
            <div class="meta">{dom} · by {html.escape(r['by'])}</div>
          </div>
          <div class="acts">
            <span class="com">{coms}</span>
            <span class="vot">▲ {pts}</span>
          </div>
        </div>
        """

    total = f"{meta['total_launches']:,}"
    doc = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{
    width: 1200px;
    height: 630px;
    overflow: hidden;
    background: #f6f5f0;
    color: #141416;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{
    width: 1200px;
    height: 630px;
    padding: 52px 64px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border: 1px solid rgba(20,20,22,0.08);
  }}
  .top {{
    display: flex;
    align-items: center;
    justify-content: space-between;
  }}
  .brand {{
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 24px;
    font-weight: 750;
    letter-spacing: -0.03em;
  }}
  .pill {{
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 14px;
    color: #484851;
    background: #ffffff;
    border: 1.5px solid rgba(20,20,22,0.14);
    border-radius: 999px;
    padding: 7px 15px;
    display: flex;
    align-items: center;
    gap: 8px;
  }}
  .dot {{ width: 8px; height: 8px; border-radius: 50%; background: #d94e1f; }}
  .hero h1 {{
    font-size: 62px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.05;
  }}
  .hero h1 em {{
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
  }}
  .hero p {{
    margin-top: 10px;
    font-size: 22px;
    color: #484851;
  }}
  .card {{
    background: #ffffff;
    border: 1.5px solid rgba(20,20,22,0.14);
    border-radius: 16px;
    overflow: hidden;
  }}
  .row {{
    display: grid;
    grid-template-columns: 46px 1fr auto;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(20,20,22,0.10);
  }}
  .row:last-child {{ border-bottom: none; }}
  .mono {{
    width: 46px;
    height: 46px;
    border-radius: 10px;
    background: #f6f5f0;
    border: 1px solid rgba(20,20,22,0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 18px;
    font-weight: 700;
  }}
  .line1 {{
    font-size: 19px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }}
  .nm {{ font-weight: 700; color: #141416; margin-right: 6px; }}
  .tg {{ color: #484851; }}
  .meta {{
    margin-top: 3px;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 13px;
    color: #656570;
  }}
  .acts {{
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 14px;
    font-weight: 600;
  }}
  .com {{
    padding: 7px 12px;
    border-radius: 8px;
    border: 1px solid rgba(20,20,22,0.14);
    color: #484851;
  }}
  .vot {{
    padding: 7px 13px;
    border-radius: 8px;
    background: rgba(217,78,31,0.10);
    color: #d94e1f;
    border: 1px solid rgba(217,78,31,0.28);
  }}
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <svg width="32" height="32" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="7" fill="#141416" />
          <path d="M9.5 22V10h2.7v4.7h7.6V10h2.7v12h-2.7v-4.8h-7.6V22H9.5z" fill="#f6f5f0" />
          <circle cx="24.5" cy="7.5" r="2.8" fill="#d94e1f" />
        </svg>
        <span>hnhunt</span>
      </div>
      <div class="pill"><span class="dot"></span><span>{total} Show HNs · gnumanth/hnhunt</span></div>
    </div>

    <div class="hero">
      <h1>Show HN, <em>hunted daily.</em></h1>
      <p>Minimal daily product discovery, voting, and maker threads from Hacker News.</p>
    </div>

    <div class="card">
      {rows_html}
    </div>
  </div>
</body>
</html>
"""
    TMP_HTML.parent.mkdir(parents=True, exist_ok=True)
    TMP_HTML.write_text(doc, encoding="utf-8")

    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    subprocess.run(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=2",
            "--window-size=1200,630",
            f"--screenshot={TMP_RAW}",
            f"file://{TMP_HTML}",
        ],
        check=True,
    )

    im = Image.open(TMP_RAW).convert("RGB").resize((1200, 630), resample=Image.Resampling.LANCZOS)
    im.save(OUT_PNG, format="PNG", optimize=True)
    print(f"Generated {OUT_PNG} ({OUT_PNG.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
