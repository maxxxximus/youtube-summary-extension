function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  const { yt_history = [] } = await chrome.storage.local.get("yt_history");
  return yt_history;
}

async function saveToHistory(videoId, title, transcript) {
  const history = await loadHistory();
  const entry = { videoId, title, transcript, date: new Date().toISOString() };
  const updated = [entry, ...history.filter((h) => h.videoId !== videoId)].slice(0, 20);
  await chrome.storage.local.set({ yt_history: updated });
  renderHistory(updated);
}

function renderHistory(history) {
  const list = document.getElementById("historyList");
  if (!history.length) {
    list.innerHTML = '<div class="history-empty">No transcripts yet</div>';
    return;
  }
  list.innerHTML = history
    .map(
      (h, i) => `
    <div class="history-item">
      <div class="history-item-info">
        <div class="history-title" title="${escHtml(h.title)}">${escHtml(h.title)}</div>
        <div class="history-date">${formatDate(h.date)} · ${Math.round(h.transcript.length / 5)} words</div>
      </div>
      <button class="history-copy" data-idx="${i}">Copy</button>
    </div>`
    )
    .join("");

  list.querySelectorAll(".history-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const h = history[idx];
      await navigator.clipboard.writeText(h.transcript);
      btn.textContent = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
    });
  });
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ── MAIN world: XHR intercept ─────────────────────────────────────────────────

// Runs in YouTube's MAIN world. Intercepts the XHR that YouTube makes when
// loading CC — that request has the signed pot= token attached by the player.
// We trigger caption load via player.setOption(), capture the full response.
function fetchTranscriptViaXHRIntercept() {
  return new Promise((resolve) => {
    let done = false;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    const finish = (result) => {
      if (done) return;
      done = true;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      clearTimeout(timer);
      try {
        const player = document.getElementById("movie_player");
        if (player) player.setOption("captions", "track", window.__ytExtPrevTrack || {});
      } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ error: "timeout" }), 12000);

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._isTimedtext = typeof url === "string" && url.includes("/api/timedtext");
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (this._isTimedtext) {
        this.addEventListener("load", function () {
          const text = this.responseText;
          if (!text || text.length < 100) return;

          // JSON3 format — full video, all events in one response
          try {
            const data = JSON.parse(text);
            const transcript = (data.events || [])
              .filter((e) => e.segs)
              .map((e) =>
                e.segs
                  .map((s) => (s.utf8 || "").replace(/\n/g, " "))
                  .join("")
                  .trim()
              )
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (transcript.length > 50) { finish({ transcript }); return; }
          } catch (_) {}

          // XML format fallback
          const parts = text.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
          if (parts.length) {
            const transcript = parts
              .map((t) =>
                t.replace(/<[^>]+>/g, "")
                  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
                  .replace(/\n/g, " ").trim()
              )
              .filter(Boolean)
              .join(" ");
            if (transcript.length > 50) { finish({ transcript }); return; }
          }
        });
      }
      return origSend.apply(this, args);
    };

    // Trigger YouTube to load captions (causes XHR with pot= token)
    try {
      const player = document.getElementById("movie_player");
      if (!player) { finish({ error: "no_player" }); return; }

      const resp = player.getPlayerResponse();
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) { finish({ error: "no_tracks" }); return; }

      const pick = (lang, manual) =>
        tracks.find((t) => t.languageCode === lang && (manual ? !t.kind : true));
      const track =
        pick("en", true) || pick("ru", true) || pick("uk", true) ||
        pick("en") || pick("ru") || pick("uk") ||
        tracks[0];

      window.__ytExtPrevTrack = player.getOption("captions", "track");
      player.setOption("captions", "track", {});
      setTimeout(() => {
        if (!done) player.setOption("captions", "track", { languageCode: track.languageCode });
      }, 150);
    } catch (e) {
      finish({ error: "player_error: " + e.message });
    }
  });
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function run() {
  const btn = document.getElementById("btnSummarize");
  btn.disabled = true;
  setStatus('<span class="loader"></span> Getting video info...');

  const tab = await getCurrentTab();

  if (!tab.url || !tab.url.includes("youtube.com/watch")) {
    setStatus("⚠️ Open a YouTube video first!", "error");
    btn.disabled = false;
    return;
  }

  // Step 1: videoId + title from isolated-world content script
  let videoInfo;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    videoInfo = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: "getVideoInfo" }, (res) => {
        if (chrome.runtime.lastError || !res) reject(new Error("Could not connect. Refresh the page."));
        else resolve(res);
      });
    });
  } catch (e) {
    setStatus("❌ " + e.message, "error");
    btn.disabled = false;
    return;
  }

  if (videoInfo.error) {
    setStatus("❌ " + videoInfo.error, "error");
    btn.disabled = false;
    return;
  }

  // Step 2: intercept YouTube's own XHR (has pot= token, full video transcript)
  setStatus('<span class="loader"></span> Loading captions...');

  let transcript = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: fetchTranscriptViaXHRIntercept,
    });
    const r = results?.[0]?.result;
    if (r?.transcript) {
      transcript = r.transcript;
    } else {
      console.log("[yt-ext] XHR intercept failed:", r?.error);
    }
  } catch (e) {
    console.log("[yt-ext] executeScript error:", e.message);
  }

  // Step 3: fallback — background.js
  if (!transcript) {
    setStatus('<span class="loader"></span> Trying fallback...');
    const bgResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "fetchTranscript", videoId: videoInfo.videoId, captionUrl: null },
        (res) => resolve(res || { error: "No response from background." })
      );
    });
    transcript = bgResult.transcript || null;
    if (!transcript) {
      setStatus("❌ " + (bgResult.error || "No transcript found."), "error");
      btn.disabled = false;
      return;
    }
  }

  // Save to history + storage
  await saveToHistory(videoInfo.videoId, videoInfo.title, transcript);
  const prompt = buildPrompt(videoInfo.title, transcript);
  await chrome.storage.local.set({ yt_prompt: prompt, yt_title: videoInfo.title });

  setStatus("✅ Done! Opening prompt page...", "success");
  setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL("relay.html") }), 500);
  btn.disabled = false;
}

function buildPrompt(title, transcript) {
  return `Please summarize the following YouTube video.

**Video title:** ${title}

**Instructions:**
- Write a concise summary (5-10 bullet points)
- Highlight the key ideas and takeaways
- Keep it clear and easy to understand

**Transcript:**
${transcript.slice(0, 14000)}`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById("btnSummarize").addEventListener("click", run);

document.getElementById("btnClearHistory").addEventListener("click", async () => {
  await chrome.storage.local.remove("yt_history");
  renderHistory([]);
});

// Load history on popup open
loadHistory().then(renderHistory);
