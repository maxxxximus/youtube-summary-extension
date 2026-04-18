// background.js — runs as service worker, NOT subject to Brave Shields or page CSP
// All YouTube fetches happen here → works in Brave, Firefox, Chrome

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchTranscript") {
    fetchTranscript(request.videoId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async
  }
});

async function fetchTranscript(videoId) {
  // Fetch YouTube page from background (bypasses Brave Shields)
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!res.ok) throw new Error(`YouTube returned ${res.status}`);
  const html = await res.text();

  // Extract video title
  const titleMatch = html.match(/<title>(.*?)<\/title>/);
  const title = titleMatch
    ? titleMatch[1].replace(" - YouTube", "").replace(/&amp;/g, "&").trim()
    : "YouTube Video";

  // Extract caption tracks
  const captionsMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!captionsMatch) throw new Error("No transcript available for this video.");

  let captionTracks;
  try {
    captionTracks = JSON.parse(captionsMatch[1]);
  } catch {
    throw new Error("Could not parse caption data.");
  }

  if (!captionTracks.length) throw new Error("No transcript available for this video.");

  // Pick best track: English → Ukrainian → any auto-generated → first available
  const track =
    captionTracks.find(t => t.languageCode === "en" && !t.kind) ||
    captionTracks.find(t => t.languageCode === "en") ||
    captionTracks.find(t => t.languageCode === "uk") ||
    captionTracks.find(t => t.kind === "asr") ||
    captionTracks[0];

  // Fetch caption XML
  const captionRes = await fetch(track.baseUrl);
  if (!captionRes.ok) throw new Error("Could not fetch transcript data.");
  const xml = await captionRes.text();

  // Parse XML → plain text
  const texts = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
  const transcript = texts
    .map(t => t.replace(/<[^>]+>/g, ""))
    .map(t => t
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, " ")
      .trim()
    )
    .filter(Boolean)
    .join(" ");

  if (!transcript) throw new Error("Transcript is empty.");

  return { transcript, title };
}
