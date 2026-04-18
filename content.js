// content.js — runs in ISOLATED world (no access to page JS vars)
// Only reads DOM/URL — caption extraction moved to popup.js (MAIN world)

if (!window.__ytSummaryInjected) {
  window.__ytSummaryInjected = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getVideoInfo") {
      const params = new URLSearchParams(window.location.search);
      const videoId = params.get("v");
      if (!videoId) {
        sendResponse({ error: "No YouTube video found. Open a video first!" });
      } else {
        const title = document.title.replace(" - YouTube", "").trim();
        sendResponse({ videoId, title });
      }
      return true;
    }
  });
}
