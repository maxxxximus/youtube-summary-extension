// content.js — runs inside YouTube page
// Content scripts are ISOLATED from page JS context,
// so we inject a script tag into the page to read ytInitialPlayerResponse

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

  // Inject script into PAGE context to access ytInitialPlayerResponse
  const captionUrl = await getCaptionUrlFromPage();

  return { videoId, title, captionUrl };
}

function getCaptionUrlFromPage() {
  return new Promise((resolve) => {
    // Listen for response from injected script
    const handler = (e) => {
      if (e.data?.type === "YT_CAPTION_URL") {
        window.removeEventListener("message", handler);
        resolve(e.data.url || null);
      }
    };
    window.addEventListener("message", handler);

    // Timeout fallback
    setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null);
    }, 3000);

    // Inject script into page context (has access to window.ytInitialPlayerResponse)
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        try {
          const data = window.ytInitialPlayerResponse;
          const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

          if (!tracks.length) {
            window.postMessage({ type: "YT_CAPTION_URL", url: null }, "*");
            return;
          }

          // Pick best track
          const pick = (lang, kind) => tracks.find(t => t.languageCode === lang && (kind === undefined || !t.kind));
          const track =
            pick("en", "manual") ||
            pick("ru", "manual") ||
            pick("uk", "manual") ||
            tracks.find(t => t.languageCode === "en") ||
            tracks.find(t => t.languageCode === "ru") ||
            tracks.find(t => t.languageCode === "uk") ||
            tracks.find(t => t.kind === "asr") ||
            tracks[0];

          window.postMessage({ type: "YT_CAPTION_URL", url: track?.baseUrl || null }, "*");
        } catch(e) {
          window.postMessage({ type: "YT_CAPTION_URL", url: null }, "*");
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  });
}
