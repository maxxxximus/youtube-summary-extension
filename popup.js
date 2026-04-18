function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Runs in MAIN world — bypasses YouTube's CSP that blocks inline scripts
function extractCaptionUrl() {
  try {
    let data = window.ytInitialPlayerResponse;

    // On SPA navigation ytInitialPlayerResponse may be stale — try ytplayer.config too
    if (!data?.captions) {
      const raw = window.ytplayer?.config?.args?.raw_player_response;
      if (raw) {
        try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) {}
      }
    }

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;

    const manual = (lang) => tracks.find(t => t.languageCode === lang && !t.kind);
    const any    = (lang) => tracks.find(t => t.languageCode === lang);
    const track  =
      manual("en") || manual("ru") || manual("uk") ||
      any("en") || any("ru") || any("uk") ||
      tracks.find(t => t.kind === "asr") ||
      tracks[0];

    return track?.baseUrl || null;
  } catch (_) {
    return null;
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

  // Step 1: Get videoId + title from content script (isolated world — safe for DOM/URL)
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

  // Step 2: Extract captionUrl from page context (MAIN world — reads ytInitialPlayerResponse)
  // This bypasses YouTube's CSP which blocks inline scripts injected by content scripts
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: extractCaptionUrl,
    });
    videoInfo.captionUrl = results?.[0]?.result ?? null;
    console.log("[yt-ext] captionUrl from MAIN world:", videoInfo.captionUrl ? videoInfo.captionUrl.slice(0, 80) : null);
  } catch (e) {
    console.log("[yt-ext] MAIN world executeScript error:", e.message);
    videoInfo.captionUrl = null;
  }

  setStatus('<span class="loader"></span> Fetching transcript...');

  // Step 3: Ask background.js to fetch the transcript
  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: "fetchTranscript", videoId: videoInfo.videoId, captionUrl: videoInfo.captionUrl },
      res => resolve(res || { error: "No response from background." })
    );
  });

  if (result.error) {
    setStatus("❌ " + result.error, "error");
    btn.disabled = false;
    return;
  }

  // Step 4: Save to storage and open relay page
  const prompt = buildPrompt(videoInfo.title, result.transcript);
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
