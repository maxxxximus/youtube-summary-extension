// background.js — service worker
// Fetches and parses YouTube transcripts using 3 methods in order of reliability

const TIMEOUT_MS = 8000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchTranscript") {
    fetchTranscript(request)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function fetchTranscript({ videoId, captionUrl }) {
  // Method 1: captionUrl from ytInitialPlayerResponse (extracted by popup in MAIN world)
  if (captionUrl) {
    const transcript = await fetchCaptionXML(captionUrl);
    if (transcript) return { transcript };
  }

  // Method 2: timedtext API (tries multiple languages + auto-generated, JSON3 + XML)
  const fromTimedtext = await tryTimedtextAPI(videoId);
  if (fromTimedtext) return { transcript: fromTimedtext };

  // Method 3: fetch YouTube watch page and parse ytInitialPlayerResponse from HTML
  const fromPage = await tryFetchFromPage(videoId);
  if (fromPage) return { transcript: fromPage };

  throw new Error("No transcript found. This video may not have subtitles enabled.");
}

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

      // Try JSON3 format
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}&fmt=json3`;
      const res = await fetchWithTimeout(url, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.events?.length) {
          const text = data.events
            .filter(e => e.segs)
            .flatMap(e => e.segs.map(s => s.utf8 || ""))
            .join(" ")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (text.length > 50) return text;
        }
      }

      // Try XML format as fallback for this lang/kind pair
      const xmlUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}`;
      const xmlRes = await fetchWithTimeout(xmlUrl, 5000);
      if (xmlRes.ok) {
        const xml = await xmlRes.text();
        if (xml.includes("<text")) {
          const text = parseXML(xml);
          if (text) return text;
        }
      }
    } catch { continue; }
  }
  return null;
}

// Fetches the YouTube watch page and extracts ytInitialPlayerResponse from the HTML
async function tryFetchFromPage(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}`,
      TIMEOUT_MS
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Match the JSON blob assigned to ytInitialPlayerResponse in the page script
    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;(?:var\s|const\s|let\s|<\/script>)/s);
    if (!match) return null;

    const data = JSON.parse(match[1]);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;

    for (const track of tracks) {
      if (!track.baseUrl) continue;
      const text = await fetchCaptionXML(track.baseUrl);
      if (text) return text;
    }
    return null;
  } catch { return null; }
}

async function fetchCaptionXML(url) {
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) return null;
    const xml = await res.text();
    return parseXML(xml);
  } catch { return null; }
}

function parseXML(xml) {
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

function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
