// background.js — runs as service worker, NOT subject to Brave Shields or page CSP

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchTranscript") {
    fetchTranscript(request.videoId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function fetchTranscript(videoId) {
  const title = await getTitle(videoId);

  // Try Method 1: parse captionTracks from YouTube page HTML
  let transcript = await tryFromPageHTML(videoId);

  // Try Method 2: YouTube timedtext API (direct, no page parsing needed)
  if (!transcript) {
    transcript = await tryTimedtextAPI(videoId);
  }

  if (!transcript) {
    throw new Error("No transcript found. The video may not have subtitles/captions enabled.");
  }

  return { transcript, title };
}

// --- Method 1: extract captionTracks from YouTube page ---
async function tryFromPageHTML(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // [\s\S] matches newlines too — fixes multiline captionTracks
    const match = html.match(/"captionTracks":(\[[\s\S]*?\])/);
    if (!match) return null;

    // YouTube sometimes has trailing commas or broken JSON — clean it up
    let json = match[1];
    // Trim at the last valid closing bracket
    const lastBracket = json.lastIndexOf("]");
    json = json.slice(0, lastBracket + 1);

    const tracks = JSON.parse(json);
    if (!tracks.length) return null;

    const track = pickBestTrack(tracks);
    return await fetchCaptionXML(track.baseUrl);
  } catch {
    return null;
  }
}

// --- Method 2: YouTube timedtext API (simpler, no page parsing) ---
async function tryTimedtextAPI(videoId) {
  const languages = ["en", "uk", "ru"];
  for (const lang of languages) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.events || !data.events.length) continue;

      const transcript = data.events
        .filter(e => e.segs)
        .flatMap(e => e.segs.map(s => s.utf8 || ""))
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (transcript.length > 50) return transcript;
    } catch {
      continue;
    }
  }

  // Also try auto-generated (asr)
  try {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.events?.length) {
        const transcript = data.events
          .filter(e => e.segs)
          .flatMap(e => e.segs.map(s => s.utf8 || ""))
          .join(" ")
          .replace(/\n/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (transcript.length > 50) return transcript;
      }
    }
  } catch {}

  return null;
}

// --- Helpers ---

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode === "en" && !t.kind) ||
    tracks.find(t => t.languageCode === "en") ||
    tracks.find(t => t.languageCode === "uk") ||
    tracks.find(t => t.kind === "asr") ||
    tracks[0]
  );
}

async function fetchCaptionXML(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const xml = await res.text();

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

  return transcript.length > 50 ? transcript : null;
}

async function getTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await res.text();
    const m = html.match(/<title>(.*?)<\/title>/);
    return m ? m[1].replace(" - YouTube", "").replace(/&amp;/g, "&").trim() : "YouTube Video";
  } catch {
    return "YouTube Video";
  }
}
