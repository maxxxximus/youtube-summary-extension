function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Runs in YouTube's MAIN world.
// Intercepts the XHR that YouTube itself makes when loading CC subtitles —
// that XHR has the signed pot= token attached by the player automatically.
// We trigger the caption load via player.setOption(), capture the response,
// then restore everything. This is the only reliable method because the pot
// token is generated dynamically by YouTube's player scripts at request time.
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
      // Restore player CC state to what it was before
      try {
        const player = document.getElementById("movie_player");
        if (player) player.setOption("captions", "track", window.__ytExtPrevTrack || {});
      } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ error: "timeout" }), 12000);

    // Intercept XHR — capture timedtext responses
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._isTimedtext = typeof url === "string" && url.includes("/api/timedtext");
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (this._isTimedtext) {
        this.addEventListener("load", function () {
          const text = this.responseText;
          if (!text || text.length < 100) return; // skip empty / tiny responses

          // JSON3 format (fmt=json3)
          try {
            const data = JSON.parse(text);
            const transcript = (data.events || [])
              .filter((e) => e.segs)
              .flatMap((e) => e.segs.map((s) => s.utf8 || ""))
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (transcript.length > 50) { finish({ transcript }); return; }
          } catch (_) {}

          // XML format fallback
          const xmlParts = text.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
          if (xmlParts.length) {
            const transcript = xmlParts
              .map((t) =>
                t.replace(/<[^>]+>/g, "")
                  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ").trim()
              )
              .filter(Boolean)
              .join(" ");
            if (transcript.length > 50) { finish({ transcript }); return; }
          }
        });
      }
      return origSend.apply(this, args);
    };

    // Trigger YouTube to load captions (this causes the XHR with pot= token)
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

      // Save current CC state so we can restore it after
      window.__ytExtPrevTrack = player.getOption("captions", "track");

      // Force-reload: turn off then switch to target language — triggers new XHR
      player.setOption("captions", "track", {});
      setTimeout(() => {
        if (!done) player.setOption("captions", "track", { languageCode: track.languageCode });
      }, 150);
    } catch (e) {
      finish({ error: "player_error: " + e.message });
    }
  });
}

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

  // Step 2: intercept YouTube's own XHR for captions (has pot= token)
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

  // Step 3: fallback — background.js methods
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

document.getElementById("btnSummarize").addEventListener("click", run);
