// Listen for message from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getTranscript") {
    extractTranscript().then(result => sendResponse(result));
    return true; // Keep channel open for async response
  }
});

async function extractTranscript() {
  try {
    // Get video ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get("v");
    if (!videoId) return { error: "No YouTube video found. Open a video first!" };

    // Get video title
    const title = document.title.replace(" - YouTube", "").trim();

    // Fetch transcript via YouTube's internal API
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const pageText = await pageResponse.text();

    // Extract caption tracks data
    const captionsMatch = pageText.match(/"captionTracks":(\[.*?\])/);
    if (!captionsMatch) return { error: "No transcript available for this video." };

    const captionTracks = JSON.parse(captionsMatch[1]);
    if (!captionTracks.length) return { error: "No transcript available for this video." };

    // Prefer English, fallback to first available
    const track =
      captionTracks.find(t => t.languageCode === "en") ||
      captionTracks.find(t => t.languageCode === "uk") ||
      captionTracks[0];

    const transcriptResponse = await fetch(track.baseUrl);
    const transcriptXml = await transcriptResponse.text();

    // Parse XML to plain text
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
