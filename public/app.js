(() => {
  const PAGE_SIZE = 45;

  const state = {
    meta: null,
    items: [],
    fullLoaded: false,
    fullLoading: null,
    window: "today",
    topic: "all",
    sort: "featured",
    q: "",
    limit: PAGE_SIZE,
    focusIdx: -1,
    activeId: null,
    // Community overlays synced with Worker SQLite Durable Object (fallback: localStorage)
    voteDeltas: {},      // id -> net community delta
    myVotes: {},         // id -> 1 | -1 | 0
    commentCounts: {},   // id -> extra community comments count
    localComments: {},   // id -> [{ id, by, text, ts }]
    shardCache: {},      // "0".."9" -> { id: { pitch, hn_comments } }
  };

  const els = {
    metaStat: document.getElementById("meta-stat"),
    searchInput: document.getElementById("search-input"),
    themeToggle: document.getElementById("theme-toggle"),
    sortSelect: document.getElementById("sort-select"),
    topicStrip: document.getElementById("topic-strip"),
    feedContainer: document.getElementById("feed-container"),
    loadMoreWrap: document.getElementById("load-more-wrap"),
    loadMoreBtn: document.getElementById("load-more-btn"),
    backdrop: document.getElementById("sheet-backdrop"),
    sheet: document.getElementById("product-sheet"),
    sheetCrumb: document.getElementById("sheet-crumb"),
    sheetClose: document.getElementById("sheet-close"),
    sheetBody: document.getElementById("sheet-body"),
  };

  // Load saved local state for instant optimistic UX and static-server fallback
  try {
    state.myVotes = JSON.parse(localStorage.getItem("hnhunt-my-votes") || "{}");
    state.localComments = JSON.parse(localStorage.getItem("hnhunt-local-comments") || "{}");
  } catch (_) {}

  function saveLocalFallback() {
    try {
      localStorage.setItem("hnhunt-my-votes", JSON.stringify(state.myVotes));
      localStorage.setItem("hnhunt-local-comments", JSON.stringify(state.localComments));
    } catch (_) {}
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function netScore(item) {
    const serverDelta = Number(state.voteDeltas[item.id] || 0);
    return item.p + serverDelta;
  }

  function totalComments(item) {
    const extra = Number(state.commentCounts[item.id] ?? (state.localComments[item.id]?.length || 0));
    return item.c + extra;
  }

  function monogramChar(name, domain) {
    const src = (name || domain || "H").replace(/^[^A-Za-z0-9]+/, "");
    return (src[0] || "H").toUpperCase();
  }

  function formatDayHeading(ymd, latestDate) {
    if (!ymd) return "Archive";
    const d = new Date(`${ymd}T00:00:00Z`);
    const ref = latestDate ? new Date(`${latestDate}T00:00:00Z`) : new Date();
    const diffDays = Math.round((ref - d) / 86400000);
    const formatted = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getUTCFullYear() !== ref.getUTCFullYear() ? "numeric" : undefined,
      timeZone: "UTC",
    });
    if (diffDays === 0) return `Today · ${formatted}`;
    if (diffDays === 1) return `Yesterday · ${formatted}`;
    return formatted;
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const sec = Math.max(1, Math.floor(Date.now() / 1000) - ts);
    if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    const days = Math.floor(sec / 86400);
    if (days < 30) return `${days}d ago`;
    const d = new Date(ts * 1000);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  async function ensureFullCatalog() {
    if (state.fullLoaded) return;
    if (state.fullLoading) return state.fullLoading;
    state.fullLoading = fetch("data/feed.json")
      .then((r) => r.json())
      .then((all) => {
        state.items = all;
        state.fullLoaded = true;
      })
      .catch(() => {})
      .finally(() => {
        state.fullLoading = null;
      });
    return state.fullLoading;
  }

  function getFilteredItems() {
    if (!state.items.length) return [];
    const latestTs = state.items[0]?.ts || Math.floor(Date.now() / 1000);
    const q = state.q.trim().toLowerCase();

    let list = state.items.filter((it) => {
      if (state.topic !== "all") {
        if (state.topic === "open-source") {
          if (!it.oss) return false;
        } else if (!it.tp || !it.tp.includes(state.topic)) {
          return false;
        }
      }

      if (q) {
        const hay = `${it.n} ${it.t} ${it.d} ${it.by} ${(it.tp || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      } else {
        if (state.window === "today") {
          // Rolling 36-hour window so Today always has rich daily launches across timezones
          if (it.ts < latestTs - 36 * 3600 && !it.live) return false;
        } else if (state.window === "week") {
          if (it.ts < latestTs - 7 * 86400) return false;
        } else if (state.window === "month") {
          if (it.ts < latestTs - 30 * 86400) return false;
        } else if (state.window === "gems") {
          if (!it.gem || it.gem <= 0) return false;
        }
      }
      return true;
    });

    const sortMode = state.sort;
    list.sort((a, b) => {
      if (state.window === "gems" && sortMode === "featured") {
        return b.gem - a.gem || netScore(b) - netScore(a);
      }
      if (state.window === "all" && sortMode === "featured") {
        return netScore(b) - netScore(a) || b.c - a.c;
      }
      if (sortMode === "votes") {
        return netScore(b) - netScore(a) || b.ts - a.ts;
      }
      if (sortMode === "newest") {
        return b.ts - a.ts || netScore(b) - netScore(a);
      }
      if (sortMode === "discussed") {
        return totalComments(b) - totalComments(a) || netScore(b) - netScore(a);
      }
      // Default Featured: group cleanly by day in Today/Week/Month, ranked by hot/netScore within day
      if (a.dt !== b.dt && (state.window === "today" || state.window === "week" || state.window === "month") && !q) {
        return a.dt < b.dt ? 1 : -1;
      }
      return b.hot - a.hot || netScore(b) - netScore(a);
    });

    return list;
  }

  function renderRow(item) {
    const myVote = Number(state.myVotes[item.id] || 0);
    const score = netScore(item);
    const comments = totalComments(item);
    const mono = monogramChar(item.n, item.d);
    const primaryTopic = (item.tp || []).find((t) => t !== "open-source") || "";

    return `
      <article class="launch-row" data-id="${item.id}" tabindex="0">
        <div class="product-monogram" aria-hidden="true">${esc(mono)}</div>
        <div class="launch-main">
          <div class="launch-title-line">
            <span class="launch-name">${esc(item.n)}</span>
            ${item.t ? `<span class="launch-tagline">${esc(item.t)}</span>` : ""}
          </div>
          <div class="launch-meta">
            <a href="${esc(item.u)}" target="_blank" rel="noopener noreferrer" class="meta-domain" data-stop="1">${esc(item.d)}</a>
            <span>·</span>
            <span>by ${esc(item.by)}</span>
            <span>·</span>
            <span>${esc(timeAgo(item.ts))}</span>
            ${item.oss ? `<span class="badge-oss">oss</span>` : ""}
            ${primaryTopic ? `<span class="badge-topic">${esc(primaryTopic)}</span>` : ""}
          </div>
        </div>
        <div class="launch-actions" data-stop="1">
          <button type="button" class="comment-pill" data-open="${item.id}" aria-label="${comments} comments on ${esc(item.n)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span>${comments}</span>
          </button>
          <div class="vote-stepper" role="group" aria-label="Vote on ${esc(item.n)}">
            <button type="button" class="vote-btn up ${myVote === 1 ? "voted" : ""}" data-vote="1" data-id="${item.id}" aria-label="Upvote ${esc(item.n)}" aria-pressed="${myVote === 1}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m18 15-6-6-6 6"></path>
              </svg>
            </button>
            <span class="vote-score" id="score-${item.id}">${score}</span>
            <button type="button" class="vote-btn down ${myVote === -1 ? "voted" : ""}" data-vote="-1" data-id="${item.id}" aria-label="Downvote ${esc(item.n)}" aria-pressed="${myVote === -1}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6"></path>
              </svg>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function renderFeed() {
    const filtered = getFilteredItems();
    const visible = filtered.slice(0, state.limit);

    if (!visible.length) {
      els.feedContainer.innerHTML = `<div class="empty-state">No Show HN launches matched this filter.</div>`;
      els.loadMoreWrap.hidden = true;
      return;
    }

    const latestDate = state.items[0]?.dt;
    const groupByDay =
      state.sort === "featured" &&
      !state.q.trim() &&
      (state.window === "today" || state.window === "week" || state.window === "month");

    if (groupByDay) {
      const groups = new Map();
      for (const it of visible) {
        if (!groups.has(it.dt)) groups.set(it.dt, []);
        groups.get(it.dt).push(it);
      }
      let html = "";
      for (const [dt, rows] of groups.entries()) {
        html += `
          <section class="day-section">
            <div class="day-header">
              <h2 class="day-title">${esc(formatDayHeading(dt, latestDate))}</h2>
              <span class="day-count">${rows.length} ${rows.length === 1 ? "launch" : "launches"}</span>
            </div>
            <div class="launch-list">
              ${rows.map(renderRow).join("")}
            </div>
          </section>
        `;
      }
      els.feedContainer.innerHTML = html;
    } else {
      const heading =
        state.q.trim()
          ? `Search results (${filtered.length})`
          : state.window === "gems"
            ? "Hidden Gems · High Maker & Community Signal"
            : state.window === "all"
              ? "Show HN Hall of Fame (2012–Present)"
              : "Launches";
      els.feedContainer.innerHTML = `
        <section class="day-section">
          <div class="day-header">
            <h2 class="day-title">${esc(heading)}</h2>
            <span class="day-count">${filtered.length.toLocaleString()} launches</span>
          </div>
          <div class="launch-list">
            ${visible.map(renderRow).join("")}
          </div>
        </section>
      `;
    }

    els.loadMoreWrap.hidden = filtered.length <= state.limit;
  }

  async function castVote(itemId, rawDir) {
    const id = Number(itemId);
    const prev = Number(state.myVotes[id] || 0);
    const next = prev === rawDir ? 0 : rawDir;
    const diff = next - prev;

    // Optimistic update
    state.myVotes[id] = next;
    state.voteDeltas[id] = Number(state.voteDeltas[id] || 0) + diff;
    saveLocalFallback();
    renderFeed();
    if (state.activeId === id) {
      updateSheetVoteUI(id);
    }

    try {
      const res = await fetch("api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, dir: next }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.delta === "number") {
          state.voteDeltas[id] = data.delta;
          state.myVotes[id] = data.my_vote;
          saveLocalFallback();
          renderFeed();
          if (state.activeId === id) updateSheetVoteUI(id);
        }
      }
    } catch (_) {
      // Static file server fallback already persisted in localStorage
    }
  }

  function updateSheetVoteUI(id) {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    const myVote = Number(state.myVotes[id] || 0);
    const scoreEl = document.getElementById("sheet-vote-score");
    const upBtn = document.getElementById("sheet-up-btn");
    const downBtn = document.getElementById("sheet-down-btn");
    if (scoreEl) scoreEl.textContent = String(netScore(item));
    if (upBtn) {
      upBtn.classList.toggle("voted", myVote === 1);
      upBtn.setAttribute("aria-pressed", String(myVote === 1));
    }
    if (downBtn) {
      downBtn.classList.toggle("voted", myVote === -1);
      downBtn.setAttribute("aria-pressed", String(myVote === -1));
    }
  }

  async function loadDetailShard(id) {
    const key = String(id % 10);
    if (!state.shardCache[key]) {
      try {
        const r = await fetch(`data/details/${key}.json`);
        state.shardCache[key] = r.ok ? await r.json() : {};
      } catch (_) {
        state.shardCache[key] = {};
      }
    }
    return state.shardCache[key][String(id)] || { pitch: "", hn_comments: [] };
  }

  async function openSheet(id) {
    let item = state.items.find((x) => x.id === Number(id));
    if (!item && !state.fullLoaded) {
      await ensureFullCatalog();
      item = state.items.find((x) => x.id === Number(id));
    }
    if (!item) return;

    state.activeId = item.id;
    els.sheetCrumb.textContent = `item #${item.id} · ${item.dt}`;
    els.backdrop.hidden = false;
    els.sheet.hidden = false;
    requestAnimationFrame(() => {
      els.backdrop.classList.add("open");
      els.sheet.classList.add("open");
    });

    const url = new URL(window.location.href);
    url.searchParams.set("item", String(item.id));
    window.history.replaceState({}, "", url);

    const detail = await loadDetailShard(item.id);
    let serverComments = null;
    try {
      const r = await fetch(`api/launches/${item.id}`);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.community_comments)) {
          serverComments = d.community_comments;
          state.commentCounts[item.id] = serverComments.length;
        }
        if (typeof d.delta === "number") state.voteDeltas[item.id] = d.delta;
        if (typeof d.my_vote === "number") state.myVotes[item.id] = d.my_vote;
      }
    } catch (_) {}

    if (state.activeId !== item.id) return;
    renderSheetContent(item, detail, serverComments || state.localComments[item.id] || []);
  }

  function renderSheetContent(item, detail, communityComments) {
    const myVote = Number(state.myVotes[item.id] || 0);
    const savedHandle = localStorage.getItem("hnhunt-handle") || "";
    const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;
    const hnComments = detail.hn_comments || [];

    const commHtml = [
      ...communityComments.map(
        (c) => `
          <div class="comment-card">
            <div class="comment-head">
              <span class="comment-author">${esc(c.by || "anon")}</span>
              <span class="source-tag">hnhunt</span>
              <span>·</span>
              <span>${esc(timeAgo(c.ts))}</span>
            </div>
            <div class="comment-body">${esc(c.text)}</div>
          </div>
        `
      ),
      ...hnComments.map(
        (c) => `
          <div class="comment-card">
            <div class="comment-head">
              <span class="comment-author">${esc(c.by)}</span>
              ${c.is_maker ? `<span class="maker-tag">maker</span>` : ""}
              <span class="source-tag">HN</span>
              <span>·</span>
              <span>${esc(timeAgo(c.ts))}</span>
            </div>
            <div class="comment-body">${esc(c.text)}</div>
            ${
              (c.replies || [])
                .map(
                  (rep) => `
                  <div class="comment-reply">
                    <div class="comment-head">
                      <span class="comment-author">${esc(rep.by)}</span>
                      ${rep.is_maker ? `<span class="maker-tag">maker</span>` : ""}
                      <span>·</span>
                      <span>${esc(timeAgo(rep.ts))}</span>
                    </div>
                    <div class="comment-body">${esc(rep.text)}</div>
                  </div>
                `
                )
                .join("")
            }
          </div>
        `
      ),
    ].join("");

    els.sheetBody.innerHTML = `
      <h2 class="sheet-title" id="sheet-title">${esc(item.n)}</h2>
      ${item.t ? `<p class="sheet-tagline">${esc(item.t)}</p>` : ""}
      <div class="sheet-meta-row">
        <span>by <strong>${esc(item.by)}</strong></span>
        <span>·</span>
        <span>${esc(item.d)}</span>
        ${item.oss ? `<span class="badge-oss">open source</span>` : ""}
        ${(item.tp || []).filter((t) => t !== "open-source").map((t) => `<span class="badge-topic">${esc(t)}</span>`).join("")}
      </div>

      <div class="sheet-cta-bar">
        <div class="cta-links">
          <a href="${esc(item.u)}" target="_blank" rel="noopener noreferrer" class="primary-link-btn">
            <span>Visit Product</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 17 17 7M7 7h10v10"></path>
            </svg>
          </a>
          <a href="${esc(hnUrl)}" target="_blank" rel="noopener noreferrer" class="ghost-link-btn">
            <span>HN Thread (${item.c})</span>
          </a>
        </div>

        <div class="vote-stepper" role="group" aria-label="Vote on ${esc(item.n)}">
          <button type="button" id="sheet-up-btn" class="vote-btn up ${myVote === 1 ? "voted" : ""}" data-vote="1" data-id="${item.id}" aria-label="Upvote" aria-pressed="${myVote === 1}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6"></path>
            </svg>
          </button>
          <span class="vote-score" id="sheet-vote-score">${netScore(item)}</span>
          <button type="button" id="sheet-down-btn" class="vote-btn down ${myVote === -1 ? "voted" : ""}" data-vote="-1" data-id="${item.id}" aria-label="Downvote" aria-pressed="${myVote === -1}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6"></path>
            </svg>
          </button>
        </div>
      </div>

      ${
        detail.pitch
          ? `
          <div class="maker-pitch-box">
            <div class="section-kicker">Maker Note</div>
            <div class="pitch-text">${esc(detail.pitch)}</div>
          </div>
        `
          : ""
      }

      <form class="comment-form" id="comment-form">
        <div class="section-kicker">Discuss</div>
        <textarea
          class="comment-textarea"
          id="comment-textarea"
          placeholder="Share technical feedback, ask the maker, or note an alternative..."
          maxlength="1200"
          required
        ></textarea>
        <div class="comment-form-row">
          <input
            type="text"
            class="handle-input"
            id="handle-input"
            placeholder="handle (optional)"
            maxlength="32"
            value="${esc(savedHandle)}"
          />
          <button type="submit" class="submit-comment-btn">Post comment</button>
        </div>
      </form>

      <div class="comments-section">
        <div class="section-kicker">Thread (${communityComments.length + hnComments.length})</div>
        ${commHtml || `<p class="comment-body">No comments cached yet — start the conversation above.</p>`}
      </div>
    `;

    const form = document.getElementById("comment-form");
    form?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const textEl = document.getElementById("comment-textarea");
      const handleEl = document.getElementById("handle-input");
      const body = (textEl?.value || "").trim();
      const author = (handleEl?.value || "").trim() || "anon";
      if (!body) return;

      try {
        if (handleEl?.value.trim()) localStorage.setItem("hnhunt-handle", handleEl.value.trim());
      } catch (_) {}

      const newEntry = { id: Date.now(), by: author, text: body, ts: Math.floor(Date.now() / 1000) };
      let updated = [newEntry, ...communityComments];

      try {
        const r = await fetch("api/comment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, author, body }),
        });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.community_comments)) {
            updated = d.community_comments;
          }
        } else {
          state.localComments[item.id] = updated;
          saveLocalFallback();
        }
      } catch (_) {
        state.localComments[item.id] = updated;
        saveLocalFallback();
      }

      state.commentCounts[item.id] = updated.length;
      renderFeed();
      renderSheetContent(item, detail, updated);
    });
  }

  function closeSheet() {
    if (!state.activeId) return;
    state.activeId = null;
    els.backdrop.classList.remove("open");
    els.sheet.classList.remove("open");
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    window.history.replaceState({}, "", url);
    setTimeout(() => {
      if (!state.activeId) {
        els.backdrop.hidden = true;
        els.sheet.hidden = true;
      }
    }, 200);
  }

  // Event Wiring
  document.querySelectorAll(".window-tabs .tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".window-tabs .tab").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      state.window = btn.dataset.window || "today";
      state.limit = PAGE_SIZE;
      state.focusIdx = -1;
      if (state.window === "all") {
        els.feedContainer.innerHTML = `<div class="loading-state">Loading 2012–present Show HN Hall of Fame…</div>`;
        await ensureFullCatalog();
      }
      renderFeed();
    });
  });

  els.topicStrip.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".topic-chip");
    if (!chip) return;
    els.topicStrip.querySelectorAll(".topic-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.topic = chip.dataset.topic || "all";
    state.limit = PAGE_SIZE;
    renderFeed();
  });

  els.sortSelect.addEventListener("change", () => {
    state.sort = els.sortSelect.value;
    state.limit = PAGE_SIZE;
    renderFeed();
  });

  let searchTimer = null;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.q = els.searchInput.value;
      state.limit = PAGE_SIZE;
      if (state.q.trim().length >= 2 && !state.fullLoaded) {
        await ensureFullCatalog();
      }
      renderFeed();
    }, 120);
  });

  els.loadMoreBtn.addEventListener("click", () => {
    state.limit += PAGE_SIZE;
    renderFeed();
  });

  els.feedContainer.addEventListener("click", (ev) => {
    const voteBtn = ev.target.closest("[data-vote]");
    if (voteBtn) {
      ev.stopPropagation();
      castVote(Number(voteBtn.dataset.id), Number(voteBtn.dataset.vote));
      return;
    }
    const openBtn = ev.target.closest("[data-open]");
    if (openBtn) {
      ev.stopPropagation();
      openSheet(Number(openBtn.dataset.open));
      return;
    }
    if (ev.target.closest("[data-stop]")) return;
    const row = ev.target.closest(".launch-row");
    if (row) openSheet(Number(row.dataset.id));
  });

  els.sheetBody.addEventListener("click", (ev) => {
    const voteBtn = ev.target.closest("[data-vote]");
    if (voteBtn) {
      castVote(Number(voteBtn.dataset.id), Number(voteBtn.dataset.vote));
    }
  });

  els.sheetClose.addEventListener("click", closeSheet);
  els.backdrop.addEventListener("click", closeSheet);

  els.themeToggle.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("hnhunt-theme", next);
    } catch (_) {}
  });

  // Minimal Keyboard Shortcuts: j/k, Enter, u/d, /, Esc
  document.addEventListener("keydown", (ev) => {
    const tag = (ev.target?.tagName || "").toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || tag === "select";

    if (ev.key === "Escape") {
      if (state.activeId) {
        closeSheet();
        return;
      }
      if (inInput) ev.target.blur();
      return;
    }

    if (inInput) return;

    if (ev.key === "/") {
      ev.preventDefault();
      els.searchInput.focus();
      return;
    }

    if (state.activeId) return;

    const rows = Array.from(document.querySelectorAll(".launch-row"));
    if (!rows.length) return;

    if (ev.key === "j" || ev.key === "k") {
      ev.preventDefault();
      state.focusIdx =
        ev.key === "j"
          ? Math.min(rows.length - 1, state.focusIdx + 1)
          : Math.max(0, state.focusIdx <= 0 ? 0 : state.focusIdx - 1);
      rows.forEach((r, idx) => r.classList.toggle("focused", idx === state.focusIdx));
      rows[state.focusIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }

    const focusedRow = rows[state.focusIdx];
    if (!focusedRow) return;
    const fid = Number(focusedRow.dataset.id);

    if (ev.key === "Enter") {
      ev.preventDefault();
      openSheet(fid);
    } else if (ev.key === "u") {
      ev.preventDefault();
      castVote(fid, 1);
    } else if (ev.key === "d") {
      ev.preventDefault();
      castVote(fid, -1);
    }
  });

  // WebMCP Registration for Browser-Native Autonomous Agents
  if (typeof navigator !== "undefined" && "modelContext" in navigator && navigator.modelContext?.registerTool) {
    try {
      navigator.modelContext.registerTool({
        name: "search_show_hn",
        description: "Search and filter Show HN product launches on hnhunt by query, window, or topic.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword, product, maker, or domain" },
            window: { type: "string", enum: ["today", "week", "month", "gems", "all"] },
            topic: { type: "string" },
          },
        },
        handler: async ({ query = "", window: win = "week", topic = "all" }) => {
          if (win === "all" || query) await ensureFullCatalog();
          state.q = query;
          state.window = win;
          state.topic = topic;
          renderFeed();
          return getFilteredItems().slice(0, 20);
        },
      });
    } catch (_) {}
  }

  // Boot Sequence
  async function init() {
    try {
      const [metaRes, recentRes] = await Promise.all([fetch("data/meta.json"), fetch("data/recent.json")]);
      state.meta = await metaRes.json();
      state.items = await recentRes.json();

      if (els.metaStat && state.meta?.total_launches) {
        els.metaStat.textContent = `${state.meta.total_launches.toLocaleString()} Show HNs · HF dataset`;
      }
      renderFeed();

      // Hydrate live community votes & comment counts from Worker Durable Object (non-blocking)
      fetch("api/state")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (!s) return;
          if (s.deltas) state.voteDeltas = s.deltas;
          if (s.my_votes) state.myVotes = { ...state.myVotes, ...s.my_votes };
          if (s.comment_counts) state.commentCounts = s.comment_counts;
          renderFeed();
        })
        .catch(() => {});

      // Check URL deep-link `?item=<id>`
      const itemParam = new URLSearchParams(window.location.search).get("item");
      if (itemParam) {
        openSheet(Number(itemParam));
      }
    } catch (err) {
      els.feedContainer.innerHTML = `<div class="empty-state">Unable to load Show HN feed bundle.</div>`;
    }
  }

  init();
})();
