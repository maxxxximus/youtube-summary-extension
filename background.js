// background.js — service worker, bypasses Brave Shields

const FETCH_TIMEOUT_MS = 8000; // 8 seconds max per request

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchTranscript") {
    fetchTranscript(request.videoId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// Fetch with timeout using AbortController
async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTranscript(videoId) {
  // Run title + transcript fetch in parallel to save time
  const [title, transcript] = await Promise.all([
    getTitle(videoId),
    getTranscript(videoId)
  ]);

  if (!transcript) {
    throw new Error("No transcript found. The video may not have subtitles enabled.");
  }

  return { transcript, title };
}

async function getTranscript(videoId) {
  // Method 1: timedtext API — fastest, try first
  const t1 = await tryTimedtextAPI(videoId);
  if (t1) return t1;

  // Method 2: parse captionTracks from page HTML
  const t2 = await tryFromPageHTML(videoId);
  if (t2) return t2;

  return null;
}

// --- Method 1: YouTube timedtext API ---
async function tryTimedtextAPI(videoId) {
  const attempts = [
    { lang: "en",  kind: ""    },
    { lang: "ru",  kind: ""    },
    { lang: "uk",  kind: ""    },
    { lang: "en",  kind: "asr" },
    { lang: "ru",  kind: "asr" },
    { lang: "uk",  kind: "asr" },
  ];

  for (const { lang, kind } of attempts) {
    try {
      const kindParam = kind ? `&kind=${kind}` : "";
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}&fmt=json3`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (!res.ok) continue;

      const data = await res.json();
      if (!data.events?.length) continue;

      const text = data.events
        .filter(e => e.segs)
        .flatMap(e => e.segs.map(s => s.utf8 || ""))
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 50) return text;
    } catch {
      continue;
    }
  }
  return null;
}

// --- Method 2: parse captionTracks from YouTube page HTML ---
async function tryFromPageHTML(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      },
      8000
    );
    if (!res.ok) return null;
    const html = await res.text();

    const match = html.match(/"captionTracks":(\[[\s\S]*?\])/);
    if (!match) return null;

    let json = match[1];
    json = json.slice(0, json.lastIndexOf("]") + 1);

    const tracks = JSON.parse(json);
    if (!tracks.length) return null;

    const track = pickBestTrack(tracks);
    return await fetchCaptionXML(track.baseUrl);
  } catch {
    return null;
  }
}

// --- Helpers ---

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode === "en" && !t.kind) ||
    tracks.find(t => t.languageCode === "ru" && !t.kind) ||
    tracks.find(t => t.languageCode === "uk" && !t.kind) ||
    tracks.find(t => t.languageCode === "en") ||
    tracks.find(t => t.languageCode === "ru") ||
    tracks.find(t => t.kind === "asr") ||
    tracks[0]
  );
}

async function fetchCaptionXML(url) {
  try {
    const res = await fetchWithTimeout(url, {}, 5000);
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
  } catch {
    return null;
  }
}

async function getTitle(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" } },
      5000
    );
    const html = await res.text();
    const m = html.match(/<title>(.*?)<\/title>/);
    return m ? m[1].replace(" - YouTube", "").replace(/&amp;/g, "&").trim() : "YouTube Video";
  } catch {
    return "YouTube Video";
  }
}
