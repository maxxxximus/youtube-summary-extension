// content.js — only gets video ID and title from the page, nothing else
// All heavy lifting (fetch) is done in background.js

if (!window.__ytSummaryInjected) {
  window.__ytSummaryInjected = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getVideoInfo") {
      const params = new URLSearchParams(window.location.search);
      const videoId = params.get("v");
      const title = document.title.replace(" - YouTube", "").trim();

      if (!videoId) {
        sendResponse({ error: "No YouTube video found. Open a video first!" });
      } else {
        sendResponse({ videoId, title });
      }
    }
    return false;
  });
}
