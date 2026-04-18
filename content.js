async function extractTranscript() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get("v");
    if (!videoId) return { error: "No YouTube video found. Open a video first!" };

    const title = document.title.replace(" - YouTube", "").trim();

    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const pageText = await pageResponse.text();

    const captionsMatch = pageText.match(/"captionTracks":(\[.*?\])/);
    if (!captionsMatch) return { error: "No transcript available for this video." };

    const captionTracks = JSON.parse(captionsMatch[1]);
    if (!captionTracks.length) return { error: "No transcript available for this video." };

    const track =
      captionTracks.find(t => t.languageCode === "en") ||
      captionTracks.find(t => t.languageCode === "uk") ||
      captionTracks[0];

    const transcriptResponse = await fetch(track.baseUrl);
    const transcriptXml = await transcriptResponse.text();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(transcriptXml, "text/xml");
    const textNodes = xmlDoc.getElementsByTagName("text");

    let transcript = "";
    for (let node of textNodes) {
      const text = node.textContent
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      if (text) transcript += text + " ";
    }

    return { transcript: transcript.trim(), title };
  } catch (e) {
    return { error: "Error: " + e.message };
  }
}

// Remove old listeners to avoid duplicates on re-injection
if (!window.__summaryListenerAdded) {
  window.__summaryListenerAdded = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getTranscript") {
      extractTranscript().then(result => sendResponse(result));
      return true;
    }
  });
}
