import { DurableObject } from "cloudflare:workers";

/**
 * SQLite-backed Durable Object storing global HNHunt community votes & comments.
 */
export class HNHuntStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        item_id INTEGER NOT NULL,
        voter TEXT NOT NULL,
        dir INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, voter)
      );
      CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(item_id);

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        by TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id, ts DESC);
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const voter = request.headers.get("x-voter-id") || "anon";

    if (url.pathname === "/state" && request.method === "GET") {
      const deltas = {};
      for (const row of this.sql.exec("SELECT item_id, SUM(dir) AS net FROM votes GROUP BY item_id")) {
        if (row.net) deltas[row.item_id] = Number(row.net);
      }
      const myVotes = {};
      for (const row of this.sql.exec("SELECT item_id, dir FROM votes WHERE voter = ?", voter)) {
        if (row.dir) myVotes[row.item_id] = Number(row.dir);
      }
      const commentCounts = {};
      for (const row of this.sql.exec("SELECT item_id, COUNT(*) AS cnt FROM comments GROUP BY item_id")) {
        if (row.cnt) commentCounts[row.item_id] = Number(row.cnt);
      }
      return Response.json({ deltas, my_votes: myVotes, comment_counts: commentCounts });
    }

    if (url.pathname === "/item" && request.method === "GET") {
      const id = Number(url.searchParams.get("id") || 0);
      const netRow = [...this.sql.exec("SELECT COALESCE(SUM(dir), 0) AS net FROM votes WHERE item_id = ?", id)][0];
      const myRow = [...this.sql.exec("SELECT dir FROM votes WHERE item_id = ? AND voter = ?", id, voter)][0];
      const comments = [
        ...this.sql.exec(
          "SELECT id, by, text, ts FROM comments WHERE item_id = ? ORDER BY ts DESC, id DESC LIMIT 50",
          id
        ),
      ].map((r) => ({ id: Number(r.id), by: r.by, text: r.text, ts: Number(r.ts) }));
      return Response.json({
        delta: Number(netRow?.net || 0),
        my_vote: Number(myRow?.dir || 0),
        community_comments: comments,
      });
    }

    if (url.pathname === "/vote" && request.method === "POST") {
      const body = await request.json();
      const id = Number(body.id || 0);
      const dir = body.dir === 1 ? 1 : body.dir === -1 ? -1 : 0;
      if (!id || id <= 0) return Response.json({ error: "Invalid item id" }, { status: 400 });

      const now = Math.floor(Date.now() / 1000);
      if (dir === 0) {
        this.sql.exec("DELETE FROM votes WHERE item_id = ? AND voter = ?", id, voter);
      } else {
        this.sql.exec(
          "INSERT INTO votes (item_id, voter, dir, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, voter) DO UPDATE SET dir = excluded.dir, updated_at = excluded.updated_at",
          id,
          voter,
          dir,
          now
        );
      }
      const netRow = [...this.sql.exec("SELECT COALESCE(SUM(dir), 0) AS net FROM votes WHERE item_id = ?", id)][0];
      return Response.json({ id, delta: Number(netRow?.net || 0), my_vote: dir });
    }

    if (url.pathname === "/comment" && request.method === "POST") {
      const body = await request.json();
      const id = Number(body.id || 0);
      const author = String(body.author || "anon").trim().slice(0, 32) || "anon";
      const text = String(body.body || "").trim().slice(0, 1200);
      if (!id || !text) return Response.json({ error: "Missing id or comment body" }, { status: 400 });

      const now = Math.floor(Date.now() / 1000);
      this.sql.exec("INSERT INTO comments (item_id, by, text, ts) VALUES (?, ?, ?, ?)", id, author, text, now);
      const comments = [
        ...this.sql.exec(
          "SELECT id, by, text, ts FROM comments WHERE item_id = ? ORDER BY ts DESC, id DESC LIMIT 50",
          id
        ),
      ].map((r) => ({ id: Number(r.id), by: r.by, text: r.text, ts: Number(r.ts) }));
      return Response.json({ id, community_comments: comments });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// Fallback in-isolate store if Durable Object binding is absent
const memStore = { votes: new Map(), comments: new Map() };

function linkHeaderFor(prefix = "") {
  return [
    `<${prefix}/.well-known/api-catalog>; rel="api-catalog"`,
    `<${prefix}/.well-known/agent-skills/index.json>; rel="service-desc"`,
    `<${prefix}/.well-known/mcp/server-card.json>; rel="describedby"`,
    `<${prefix}/.well-known/agent-card.json>; rel="describedby"`,
    `<${prefix}/llms.txt>; rel="describedby"`,
    `<${prefix}/.well-known/ard.json>; rel="ard"`,
  ].join(", ");
}

const LINK_HEADER = linkHeaderFor("");

function withAgentHeaders(initHeaders = {}, extra = {}) {
  const h = new Headers(initHeaders);
  h.set("Link", LINK_HEADER);
  h.set("content-signal", "ai-train=yes, search=yes, ai-input=yes");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: withAgentHeaders({ "Content-Type": "application/json; charset=utf-8" }, extraHeaders),
  });
}

function wantsMarkdown(acceptHeader) {
  if (!acceptHeader || !acceptHeader.includes("text/markdown")) return false;
  const parts = acceptHeader.split(",").map((p) => p.trim());
  let mdQ = -1;
  let htmlQ = -1;
  for (const part of parts) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    let q = 1.0;
    for (const param of params) {
      if (param.startsWith("q=")) q = parseFloat(param.slice(2)) || q;
    }
    if (type.toLowerCase() === "text/markdown") mdQ = q;
    if (type.toLowerCase() === "text/html") htmlQ = q;
  }
  return mdQ >= 0 && (htmlQ < 0 || mdQ >= htmlQ);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveVoterId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const ua = (request.headers.get("User-Agent") || "").slice(0, 120);
  const hash = await sha256Hex(`hnhunt-v1:${ip}:${ua}`);
  return hash.slice(0, 24);
}

async function loadAssetJson(env, reqUrl, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, reqUrl).toString()));
  if (!res.ok) return null;
  return res.json();
}

async function callCommunityDO(env, request, doPath, method = "GET", bodyObj = null) {
  const voter = await deriveVoterId(request);
  if (env.COMMUNITY) {
    const id = env.COMMUNITY.idFromName("global-v1");
    const stub = env.COMMUNITY.get(id);
    const init = {
      method,
      headers: { "Content-Type": "application/json", "x-voter-id": voter },
    };
    if (bodyObj !== null) init.body = JSON.stringify(bodyObj);
    const res = await stub.fetch(`https://do.internal${doPath}`, init);
    return res.json();
  }

  // Graceful isolate-memory fallback
  if (doPath === "/state") {
    const deltas = {};
    const myVotes = {};
    for (const [key, dir] of memStore.votes.entries()) {
      const [itemId, v] = key.split(":");
      deltas[itemId] = (deltas[itemId] || 0) + dir;
      if (v === voter) myVotes[itemId] = dir;
    }
    const commentCounts = {};
    for (const [itemId, list] of memStore.comments.entries()) {
      commentCounts[itemId] = list.length;
    }
    return { deltas, my_votes: myVotes, comment_counts: commentCounts };
  }
  if (doPath.startsWith("/item")) {
    const itemId = Number(new URL(`https://do.internal${doPath}`).searchParams.get("id"));
    let delta = 0;
    let myVote = 0;
    for (const [key, dir] of memStore.votes.entries()) {
      const [iid, v] = key.split(":");
      if (Number(iid) === itemId) {
        delta += dir;
        if (v === voter) myVote = dir;
      }
    }
    return { delta, my_vote: myVote, community_comments: memStore.comments.get(itemId) || [] };
  }
  if (doPath === "/vote") {
    const id = Number(bodyObj.id);
    const dir = bodyObj.dir === 1 ? 1 : bodyObj.dir === -1 ? -1 : 0;
    const key = `${id}:${voter}`;
    if (dir === 0) memStore.votes.delete(key);
    else memStore.votes.set(key, dir);
    let delta = 0;
    for (const [k, d] of memStore.votes.entries()) {
      if (Number(k.split(":")[0]) === id) delta += d;
    }
    return { id, delta, my_vote: dir };
  }
  if (doPath === "/comment") {
    const id = Number(bodyObj.id);
    const list = memStore.comments.get(id) || [];
    list.unshift({
      id: Date.now(),
      by: String(bodyObj.author || "anon").slice(0, 32) || "anon",
      text: String(bodyObj.body || "").slice(0, 1200),
      ts: Math.floor(Date.now() / 1000),
    });
    memStore.comments.set(id, list.slice(0, 50));
    return { id, community_comments: memStore.comments.get(id) };
  }
  return {};
}

function queryFeed(items, params = {}) {
  const windowMode = params.window || "week";
  const topic = params.topic || "all";
  const q = String(params.q || "").trim().toLowerCase();
  const sort = params.sort || "featured";
  const limit = Math.min(100, Math.max(1, Number(params.limit || 25)));
  const latestTs = items[0]?.ts || Math.floor(Date.now() / 1000);

  let out = items.filter((it) => {
    if (topic !== "all") {
      if (topic === "open-source") {
        if (!it.oss) return false;
      } else if (!it.tp || !it.tp.includes(topic)) {
        return false;
      }
    }
    if (q) {
      const hay = `${it.n} ${it.t} ${it.d} ${it.by} ${(it.tp || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    } else {
      if (windowMode === "today" && it.ts < latestTs - 36 * 3600 && !it.live) return false;
      if (windowMode === "week" && it.ts < latestTs - 7 * 86400) return false;
      if (windowMode === "month" && it.ts < latestTs - 30 * 86400) return false;
      if (windowMode === "gems" && (!it.gem || it.gem <= 0)) return false;
    }
    return true;
  });

  out.sort((a, b) => {
    if (windowMode === "gems" && sort === "featured") return b.gem - a.gem || b.p - a.p;
    if (windowMode === "all" && sort === "featured") return b.p - a.p || b.c - a.c;
    if (sort === "votes") return b.p - a.p || b.ts - a.ts;
    if (sort === "newest") return b.ts - a.ts || b.p - a.p;
    if (sort === "discussed") return b.c - a.c || b.p - a.p;
    return b.hot - a.hot || b.p - a.p;
  });

  return out.slice(0, limit).map((it) => ({
    id: it.id,
    product_name: it.n,
    tagline: it.t,
    url: it.u,
    hn_url: `https://news.ycombinator.com/item?id=${it.id}`,
    domain: it.d,
    maker: it.by,
    points: it.p,
    comments: it.c,
    launch_date: it.dt,
    is_open_source: Boolean(it.oss),
    topics: it.tp,
  }));
}

function buildSkillMarkdown(origin) {
  return `---
name: hnhunt
description: Query daily Show HN product launches, inspect maker notes and verbatim HN discussions, and vote or comment via REST or MCP.
---

# hnhunt Agent Skill

Base URL: \`${origin}\`
Hugging Face Dataset: \`https://huggingface.co/datasets/gnumanth/hnhunt\`

## Endpoints

- \`GET ${origin}/api/launches?window=today|week|month|gems|all&topic=ai|devtools|open-source&q=...&limit=25\`
- \`GET ${origin}/api/launches/{id}\`
- \`POST ${origin}/api/vote\` — JSON \`{"id": 50494144, "dir": 1}\` (\`1\`, \`-1\`, or \`0\`)
- \`POST ${origin}/api/comment\` — JSON \`{"id": 50494144, "author": "agent", "body": "..."}\`
- \`POST ${origin}/mcp\` — JSON-RPC 2.0 MCP endpoint (\`tools/list\`, \`tools/call\`)
`;
}

function buildMarkdownHome(origin, meta, recent) {
  const topToday = queryFeed(recent || [], { window: "today", sort: "featured", limit: 15 });
  const lines = topToday.map(
    (it, i) =>
      `${i + 1}. **[${it.product_name}](${it.url})** — ${it.tagline || it.domain} · \`${it.points} pts\` · \`${it.comments} comments\` · by \`${it.maker}\` ([HN #${it.id}](${it.hn_url}))`
  );

  return `---
title: "hnhunt — Show HN, hunted daily."
description: "Minimal daily product board and Hugging Face dataset for Show HN launches from Hacker News."
url: "${origin}/"
dataset: "https://huggingface.co/datasets/gnumanth/hnhunt"
updated_at: "${meta?.generated_at || ""}"
total_launches: ${meta?.total_launches || 0}
---

# hnhunt — Show HN, hunted daily.

Minimal daily product discovery, up/down voting, and maker discussions for **Show HN** launches on Hacker News.
Backed by the daily-updating Parquet & JSONL dataset [\`gnumanth/hnhunt\`](https://huggingface.co/datasets/gnumanth/hnhunt) (${(meta?.total_launches || 0).toLocaleString()} launches).

## Featured Today

${lines.join("\n")}

## API & MCP Quick Reference

- Search launches: \`GET ${origin}/api/launches?window=today&topic=open-source&limit=20\`
- Inspect launch + comments: \`GET ${origin}/api/launches/{id}\`
- Vote up/down: \`POST ${origin}/api/vote\` with \`{"id": <item_id>, "dir": 1 | -1 | 0}\`
- Post comment: \`POST ${origin}/api/comment\` with \`{"id": <item_id>, "author": "<name>", "body": "<text>"}\`
- MCP JSON-RPC: \`POST ${origin}/mcp\`
- OpenAPI 3.1: \`${origin}/openapi.json\`
`;
}

export default {
  async fetch(request, env) {
    const prefix = (request.headers.get("X-Forwarded-Prefix") || "").replace(/\/+$/, "");
    const res = await handleRequest(request, env, prefix);
    if (!prefix) return res;
    const headers = new Headers(res.headers);
    headers.set("Link", linkHeaderFor(prefix));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};

async function handleRequest(request, env, prefix = "") {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withAgentHeaders() });
    }

    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}${prefix}`;
    const { pathname } = url;

    // 1. Standard Crawl + Content Signals
    if (pathname === "/robots.txt") {
      const body = `User-agent: *\nAllow: /\nContent-Signal: ai-train=yes, search=yes, ai-input=yes\nSitemap: ${origin}/sitemap.xml\n`;
      return new Response(body, {
        headers: withAgentHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    if (pathname === "/sitemap.xml") {
      const meta = await loadAssetJson(env, request.url, "/data/meta.json");
      const lastmod = meta?.generated_date || "2026-11-14";
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>${origin}/llms.txt</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>
</urlset>`;
      return new Response(xml, {
        headers: withAgentHeaders({ "Content-Type": "application/xml; charset=utf-8" }),
      });
    }

    // 2. Agent Discovery Manifests (`/.well-known/*`, `/llms.txt`, `/auth.md`, `/openapi.json`)
    if (pathname === "/llms.txt") {
      const meta = await loadAssetJson(env, request.url, "/data/meta.json");
      const txt = `# hnhunt

> Minimal daily product board for Show HN launches from Hacker News, backed by a daily Hugging Face dataset.

- Total indexed Show HN launches: ${(meta?.total_launches || 0).toLocaleString()}
- Last synced: ${meta?.generated_at || "daily"}
- Hugging Face Dataset: https://huggingface.co/datasets/gnumanth/hnhunt
- GitHub Repository: https://github.com/hemanth/hnhunt

## Machine-Readable Endpoints
- [API Launches Feed](${origin}/api/launches?window=today): Filterable JSON feed (\`window\`, \`topic\`, \`q\`, \`sort\`, \`limit\`)
- [OpenAPI 3.1 Spec](${origin}/openapi.json): Full REST schema for searching, voting, and commenting
- [MCP Server](${origin}/mcp): JSON-RPC 2.0 Model Context Protocol endpoint
- [Agent Card](${origin}/.well-known/agent-card.json): A2A v1.0.0 capability manifest
- [Full JSON Dataset](${origin}/data/hnhunt-dataset.json): Canonical Show HN export
`;
      return new Response(txt, {
        headers: withAgentHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    if (pathname === "/auth.md") {
      const md = `# Authentication & Rate Limits (hnhunt)\n\nRead and search endpoints (\`/api/launches\`, \`/data/*\`, \`/mcp\` read tools) are **public and require no API key**.\n\nCommunity voting (\`POST /api/vote\`) and commenting (\`POST /api/comment\`) use privacy-preserving edge request fingerprinting (one reversible vote per launch per client).\n`;
      return new Response(md, {
        headers: withAgentHeaders({ "Content-Type": "text/markdown; charset=utf-8" }),
      });
    }

    if (pathname === "/.well-known/api-catalog") {
      return new Response(
        JSON.stringify(
          {
            linkset: [
              {
                anchor: origin,
                "service-desc": [{ href: `${origin}/openapi.json`, type: "application/json" }],
                "service-doc": [{ href: `${origin}/llms.txt`, type: "text/plain" }],
                status: [{ href: `${origin}/data/meta.json`, type: "application/json" }],
              },
            ],
          },
          null,
          2
        ),
        { headers: withAgentHeaders({ "Content-Type": "application/linkset+json; charset=utf-8" }) }
      );
    }

    if (pathname === "/.well-known/mcp/server-card.json") {
      return jsonResp({
        $schema: "https://modelcontextprotocol.io/schemas/server-card/v1.json",
        name: "hnhunt-mcp",
        version: "1.0.0",
        description: "Search daily Show HN launches, inspect maker threads, and vote or comment.",
        transport: { type: "http", endpoint: `${origin}/mcp` },
        capabilities: { tools: true, resources: true, prompts: false },
      });
    }

    if (pathname === "/.well-known/ard.json" || pathname === "/.well-known/ai-catalog.json") {
      return new Response(
        JSON.stringify(
          {
            entries: [
              {
                identifier: "urn:air:h3manth.com:hnhunt:mcp",
                displayName: "hnhunt MCP Server",
                type: "application/mcp-server-card+json",
                url: `${origin}/.well-known/mcp/server-card.json`,
                representativeQueries: [
                  "Find today's top Show HN product launches",
                  "Search open-source developer tools launched on Show HN",
                  "Read maker notes and comments for a Show HN project",
                ],
              },
              {
                identifier: "urn:air:h3manth.com:hnhunt:agent",
                displayName: "hnhunt A2A Agent",
                type: "application/agent-card+json",
                url: `${origin}/.well-known/agent-card.json`,
                representativeQueries: [
                  "Discover daily Show HN launches and hidden gems",
                  "Upvote or comment on a Show HN launch",
                ],
              },
              {
                identifier: "urn:air:h3manth.com:hnhunt:skills",
                displayName: "hnhunt Agent Skills",
                type: "application/agent-skills+json",
                url: `${origin}/.well-known/agent-skills/index.json`,
                representativeQueries: [
                  "Query the daily Hugging Face Show HN dataset",
                  "Filter Show HN launches by topic or time window",
                ],
              },
            ],
          },
          null,
          2
        ),
        { headers: withAgentHeaders({ "Content-Type": "application/ai-catalog+json; charset=utf-8" }) }
      );
    }

    if (pathname === "/.well-known/agent-card.json") {
      return jsonResp({
        $schema: "https://a2a-protocol.org/schemas/agent-card/v1.0.0.json",
        schemaVersion: "1.0.0",
        name: "hnhunt",
        description: "Daily Show HN product discovery, voting, discussion, and dataset agent.",
        url: origin,
        version: "1.0.0",
        dataset: "https://huggingface.co/datasets/gnumanth/hnhunt",
        capabilities: {
          tools: [
            {
              name: "search_launches",
              description: "Search and filter Show HN launches",
              parameters: {
                type: "object",
                properties: {
                  window: { type: "string", enum: ["today", "week", "month", "gems", "all"] },
                  topic: { type: "string" },
                  q: { type: "string" },
                  limit: { type: "integer" },
                },
              },
            },
            {
              name: "get_launch",
              description: "Fetch maker pitch and discussion comments for a Show HN item ID",
              parameters: {
                type: "object",
                properties: { id: { type: "integer" } },
                required: ["id"],
              },
            },
          ],
        },
        communication: {
          preferredChannel: "https",
          endpoints: { query: `${origin}/api/launches`, mcp: `${origin}/mcp` },
        },
      });
    }

    if (pathname === "/.well-known/agent-skills/hnhunt/SKILL.md") {
      return new Response(buildSkillMarkdown(origin), {
        headers: withAgentHeaders({ "Content-Type": "text/markdown; charset=utf-8" }),
      });
    }

    if (pathname === "/.well-known/agent-skills/index.json") {
      const skillBody = buildSkillMarkdown(origin);
      const digest = await sha256Hex(skillBody);
      return jsonResp({
        version: "0.2.0",
        skills: [
          {
            name: "hnhunt",
            description: "Search daily Show HN launches, read maker notes, and vote or comment.",
            entrypoint: "/.well-known/agent-skills/hnhunt/SKILL.md",
            sha256: digest,
          },
        ],
      });
    }

    if (pathname === "/.well-known/oauth-protected-resource") {
      return jsonResp({
        resource: origin,
        authorization_servers: [origin],
        scopes_supported: ["read", "search", "vote", "comment"],
        bearer_methods_supported: ["header"],
      });
    }

    if (pathname === "/.well-known/http-message-signatures-directory") {
      return jsonResp({
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            kid: "hnhunt-agent-key-1",
            use: "sig",
            alg: "Ed25519",
          },
        ],
      });
    }

    if (pathname === "/openapi.json") {
      return jsonResp({
        openapi: "3.1.0",
        info: {
          title: "hnhunt API",
          version: "1.0.0",
          description: "Minimal daily Show HN product board & dataset API.",
        },
        servers: [{ url: origin }],
        paths: {
          "/api/launches": {
            get: {
              summary: "List and filter Show HN product launches",
              parameters: [
                { name: "window", in: "query", schema: { type: "string", enum: ["today", "week", "month", "gems", "all"] } },
                { name: "topic", in: "query", schema: { type: "string" } },
                { name: "q", in: "query", schema: { type: "string" } },
                { name: "sort", in: "query", schema: { type: "string", enum: ["featured", "votes", "newest", "discussed"] } },
                { name: "limit", in: "query", schema: { type: "integer", default: 25 } },
              ],
              responses: { "200": { description: "Array of Show HN launches" } },
            },
          },
          "/api/launches/{id}": {
            get: {
              summary: "Get full Show HN launch details, maker note, and thread comments",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
              responses: { "200": { description: "Launch detail object" } },
            },
          },
          "/api/vote": {
            post: {
              summary: "Upvote (1), downvote (-1), or clear vote (0) on a Show HN launch",
              responses: { "200": { description: "Updated net vote delta" } },
            },
          },
          "/api/comment": {
            post: {
              summary: "Post a community comment on a Show HN launch",
              responses: { "200": { description: "Updated community comment thread" } },
            },
          },
        },
      });
    }

    // 3. REST API (`/api/*`)
    if (pathname === "/api/state" && request.method === "GET") {
      const data = await callCommunityDO(env, request, "/state");
      return jsonResp(data, 200, { "Cache-Control": "no-store" });
    }

    if (pathname === "/api/launches" && request.method === "GET") {
      const windowMode = url.searchParams.get("window") || "today";
      const q = url.searchParams.get("q") || "";
      const bundlePath = windowMode === "all" || q ? "/data/feed.json" : "/data/recent.json";
      const [items, commState] = await Promise.all([
        loadAssetJson(env, request.url, bundlePath),
        callCommunityDO(env, request, "/state"),
      ]);
      const rows = queryFeed(items || [], {
        window: windowMode,
        topic: url.searchParams.get("topic") || "all",
        q,
        sort: url.searchParams.get("sort") || "featured",
        limit: url.searchParams.get("limit") || 25,
      }).map((r) => ({
        ...r,
        community_delta: Number(commState?.deltas?.[r.id] || 0),
        net_score: r.points + Number(commState?.deltas?.[r.id] || 0),
      }));
      return jsonResp({ count: rows.length, launches: rows });
    }

    const itemMatch = pathname.match(/^\/api\/launches\/(\d+)$/);
    if (itemMatch && request.method === "GET") {
      const id = Number(itemMatch[1]);
      const [feed, shard, doItem] = await Promise.all([
        loadAssetJson(env, request.url, "/data/feed.json"),
        loadAssetJson(env, request.url, `/data/details/${id % 10}.json`),
        callCommunityDO(env, request, `/item?id=${id}`),
      ]);
      const item = (feed || []).find((x) => x.id === id);
      if (!item) return jsonResp({ error: "Launch not found" }, 404);
      const detail = (shard || {})[String(id)] || { pitch: "", hn_comments: [] };
      return jsonResp(
        {
          id: item.id,
          product_name: item.n,
          tagline: item.t,
          url: item.u,
          hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
          domain: item.d,
          maker: item.by,
          hn_points: item.p,
          delta: doItem.delta || 0,
          net_score: item.p + (doItem.delta || 0),
          my_vote: doItem.my_vote || 0,
          launch_date: item.dt,
          is_open_source: Boolean(item.oss),
          topics: item.tp,
          maker_pitch: detail.pitch || "",
          community_comments: doItem.community_comments || [],
          hn_comments: detail.hn_comments || [],
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }

    if (pathname === "/api/vote" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const out = await callCommunityDO(env, request, "/vote", "POST", body);
      return jsonResp(out, out.error ? 400 : 200, { "Cache-Control": "no-store" });
    }

    if (pathname === "/api/comment" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const out = await callCommunityDO(env, request, "/comment", "POST", body);
      return jsonResp(out, out.error ? 400 : 200, { "Cache-Control": "no-store" });
    }

    // 4. Live JSON-RPC 2.0 MCP Server (`/mcp`)
    if (pathname === "/mcp" && request.method === "POST") {
      const rpc = await request.json().catch(() => ({}));
      const { id = null, method, params = {} } = rpc;

      if (method === "initialize") {
        return jsonResp({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "hnhunt-mcp", version: "1.0.0" },
          },
        });
      }

      if (method === "tools/list") {
        return jsonResp({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "search_launches",
                description: "Search and filter daily Show HN product launches.",
                inputSchema: {
                  type: "object",
                  properties: {
                    window: { type: "string", enum: ["today", "week", "month", "gems", "all"] },
                    topic: { type: "string" },
                    q: { type: "string" },
                    sort: { type: "string", enum: ["featured", "votes", "newest", "discussed"] },
                    limit: { type: "integer" },
                  },
                },
              },
              {
                name: "get_launch",
                description: "Get full Show HN launch details, maker pitch, and verbatim comments.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                  required: ["id"],
                },
              },
              {
                name: "vote_launch",
                description: "Upvote (1) or downvote (-1) a Show HN product launch.",
                inputSchema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    dir: { type: "integer", enum: [1, -1, 0] },
                  },
                  required: ["id", "dir"],
                },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        const name = params.name;
        const args = params.arguments || {};
        if (name === "search_launches") {
          const items = await loadAssetJson(env, request.url, args.window === "all" || args.q ? "/data/feed.json" : "/data/recent.json");
          const rows = queryFeed(items || [], args);
          return jsonResp({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] } });
        }
        if (name === "get_launch" && args.id) {
          const lid = Number(args.id);
          const [feed, shard, doItem] = await Promise.all([
            loadAssetJson(env, request.url, "/data/feed.json"),
            loadAssetJson(env, request.url, `/data/details/${lid % 10}.json`),
            callCommunityDO(env, request, `/item?id=${lid}`),
          ]);
          const item = (feed || []).find((x) => x.id === lid);
          const detail = (shard || {})[String(lid)] || {};
          return jsonResp({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify({ item, ...detail, ...doItem }, null, 2) }] },
          });
        }
        if (name === "vote_launch" && args.id !== undefined) {
          const out = await callCommunityDO(env, request, "/vote", "POST", { id: Number(args.id), dir: Number(args.dir) });
          return jsonResp({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
        }
      }

      if (method === "resources/list") {
        return jsonResp({
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              { uri: "https://huggingface.co/datasets/gnumanth/hnhunt", name: "HNHunt Hugging Face Dataset", mimeType: "application/vnd.apache.parquet" },
              { uri: `${origin}/data/hnhunt-dataset.json`, name: "HNHunt Full JSON Dataset", mimeType: "application/json" },
              { uri: `${origin}/llms.txt`, name: "HNHunt LLM Guide", mimeType: "text/plain" },
            ],
          },
        });
      }

      return jsonResp({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }, 404);
    }

    // 5. Markdown Content Negotiation (`Accept: text/markdown`) on `/` and `/index.html`
    const accept = request.headers.get("Accept") || "";
    if ((pathname === "/" || pathname === "/index.html") && wantsMarkdown(accept)) {
      const [meta, recent, htmlRes] = await Promise.all([
        loadAssetJson(env, request.url, "/data/meta.json"),
        loadAssetJson(env, request.url, "/data/recent.json"),
        env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString())),
      ]);
      const rawHtml = await htmlRes.text();
      const md = buildMarkdownHome(origin, meta, recent);
      return new Response(md, {
        status: 200,
        headers: withAgentHeaders({
          "Content-Type": "text/markdown; charset=utf-8",
          Vary: "Accept",
          "x-markdown-tokens": String(Math.ceil(md.length / 4)),
          "x-original-tokens": String(Math.ceil(rawHtml.length / 4)),
          "Cache-Control": "public, max-age=300",
        }),
      });
    }

    // 6. Edge-SSR Semantic Feed on `/` and `/index.html` for Non-JS Search & LLM Crawlers (OAI-SearchBot, ClaudeBot, PerplexityBot, Googlebot)
    if (pathname === "/" || pathname === "/index.html") {
      const [meta, recent, assetRes] = await Promise.all([
        loadAssetJson(env, request.url, "/data/meta.json"),
        loadAssetJson(env, request.url, "/data/recent.json"),
        env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString())),
      ]);
      let html = await assetRes.text();
      if (recent && Array.isArray(recent)) {
        const top = queryFeed(recent, { window: "today", sort: "featured", limit: 20 });
        const esc = (s) =>
          String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        const itemsHtml = top
          .map(
            (it) =>
              `<li><a href="${esc(it.url)}"><strong>${esc(it.product_name)}</strong></a> — ${esc(it.tagline || it.domain)} (<span>${it.points} HN pts, ${it.comments} comments, by ${esc(it.maker)}</span> · <a href="${esc(it.hn_url)}">Show HN thread</a>)</li>`
          )
          .join("");
        const ssrBlock = `<div class="loading-state" id="loading-state">Loading daily Show HN feed…</div><noscript><section aria-label="Featured Show HN Launches"><h2>Featured Show HN Launches (${(meta?.total_launches || recent.length).toLocaleString()} indexed in gnumanth/hnhunt)</h2><ul>${itemsHtml}</ul></section></noscript><div class="sr-only" data-ssr-crawler-index="true"><h2>Today's Top Show HN Product Launches (${esc(meta?.generated_date || "")})</h2><ul>${itemsHtml}</ul></div>`;
        html = html.replace(
          '<div class="loading-state" id="loading-state">Loading daily Show HN feed…</div>',
          ssrBlock
        );
      }
      return new Response(html, {
        status: 200,
        headers: withAgentHeaders(assetRes.headers, {
          "Content-Type": "text/html; charset=utf-8",
          Vary: "Accept",
        }),
      });
    }

    // 7. Static Assets with Universal Agent Discovery Headers on HTML
    const assetRes = await env.ASSETS.fetch(request);
    const ct = assetRes.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers: withAgentHeaders(assetRes.headers, { Vary: "Accept" }),
      });
    }
    return assetRes;
}
