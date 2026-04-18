function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Runs in YouTube's MAIN world via executeScript.
// Fetches the caption XML directly from the page context — same-origin request,
// cookies included automatically. Bypasses both CSP and background cookie issues.
async function fetchTranscriptInPage() {
  try {
    let data = window.ytInitialPlayerResponse;

    // SPA navigation: ytInitialPlayerResponse may be stale, try ytplayer.config
    if (!data?.captions) {
      const raw = window.ytplayer?.config?.args?.raw_player_response;
      if (raw) {
        try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) {}
      }
    }

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return { error: "no_tracks" };

    const manual = (lang) => tracks.find(t => t.languageCode === lang && !t.kind);
    const any    = (lang) => tracks.find(t => t.languageCode === lang);
    const track  =
      manual("en") || manual("ru") || manual("uk") ||
      any("en") || any("ru") || any("uk") ||
      tracks.find(t => t.kind === "asr") ||
      tracks[0];

    if (!track?.baseUrl) return { error: "no_baseUrl" };

    // Same-origin fetch — YouTube cookies sent automatically, no CORS issues
    const res = await fetch(track.baseUrl);
    if (!res.ok) return { error: `fetch_${res.status}` };
    const xml = await res.text();

    // Parse XML with DOMParser (available in page context)
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const textEls = Array.from(doc.querySelectorAll("text"));
    if (!textEls.length) return { error: "empty_xml" };

    const transcript = textEls
      .map(el => (el.textContent || "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/\n/g, " ").trim()
      )
      .filter(Boolean)
      .join(" ");

    return transcript.length > 50
      ? { transcript }
      : { error: "too_short" };
  } catch (e) {
    return { error: e.message };
  }
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

  // Step 1: Get videoId + title from content script (isolated world)
  let videoInfo;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    videoInfo = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: "getVideoInfo" }, res => {
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

  // Step 2: Fetch transcript directly in YouTube's MAIN world.
  // This is the primary method — same-origin fetch uses YouTube cookies automatically.
  setStatus('<span class="loader"></span> Fetching transcript...');

  let transcript = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: fetchTranscriptInPage,
    });
    const pageResult = results?.[0]?.result;
    if (pageResult?.transcript) {
      transcript = pageResult.transcript;
      console.log("[yt-ext] MAIN world success, len=", transcript.length);
    } else {
      console.log("[yt-ext] MAIN world failed:", pageResult?.error);
    }
  } catch (e) {
    console.log("[yt-ext] MAIN world executeScript error:", e.message);
  }

  // Step 3: Fallback — background.js (timedtext API + innertube + page HTML)
  if (!transcript) {
    setStatus('<span class="loader"></span> Trying fallback methods...');
    const bgResult = await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { action: "fetchTranscript", videoId: videoInfo.videoId, captionUrl: null },
        res => resolve(res || { error: "No response from background." })
      );
    });
    if (bgResult.transcript) {
      transcript = bgResult.transcript;
    } else {
      setStatus("❌ " + (bgResult.error || "No transcript found."), "error");
      btn.disabled = false;
      return;
    }
  }

  // Step 4: Save and open relay page
  const prompt = buildPrompt(videoInfo.title, transcript);
  await chrome.storage.local.set({ yt_prompt: prompt, yt_title: videoInfo.title });

  setStatus("✅ Done! Opening prompt page...", "success");
  setTimeout(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("relay.html") });
  }, 500);

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
