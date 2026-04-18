// content.js — runs inside YouTube page (has cookies + session)
// Extracts caption URL directly from the page data

if (!window.__ytSummaryInjected) {
  window.__ytSummaryInjected = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getVideoInfo") {
      getVideoInfo().then(sendResponse);
      return true;
    }
  });
}

async function getVideoInfo() {
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get("v");
  const title = document.title.replace(" - YouTube", "").trim();

  if (!videoId) return { error: "No YouTube video found. Open a video first!" };

  // --- Method 1: extract captionTracks from ytInitialPlayerResponse ---
  try {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const text = script.textContent;
      if (!text.includes("captionTracks")) continue;

      const match = text.match(/"captionTracks":(\[[\s\S]*?\])/);
      if (!match) continue;

      let json = match[1];
      json = json.slice(0, json.lastIndexOf("]") + 1);
      const tracks = JSON.parse(json);
      if (!tracks.length) continue;

      const track = pickBestTrack(tracks);
      if (track?.baseUrl) {
        return { videoId, title, captionUrl: track.baseUrl };
      }
    }
  } catch {}

  // --- Method 2: try window.ytInitialPlayerResponse ---
  try {
    const data = window.ytInitialPlayerResponse;
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks?.length) {
      const track = pickBestTrack(tracks);
      if (track?.baseUrl) {
        return { videoId, title, captionUrl: track.baseUrl };
      }
    }
  } catch {}

  // No caption URL found — pass videoId so background can try timedtext API
  return { videoId, title, captionUrl: null };
}

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode === "en" && !t.kind) ||
    tracks.find(t => t.languageCode === "ru" && !t.kind) ||
    tracks.find(t => t.languageCode === "uk" && !t.kind) ||
    tracks.find(t => t.languageCode === "en") ||
    tracks.find(t => t.languageCode === "ru") ||
    tracks.find(t => t.languageCode === "uk") ||
    tracks.find(t => t.kind === "asr") ||
    tracks[0]
  );
}
