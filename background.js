// background.js — service worker

const TIMEOUT_MS = 8000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchTranscript") {
    fetchTranscript(request)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function fetchTranscript({ videoId, captionUrl }) {
  console.log("[yt-ext] fetchTranscript", { videoId, captionUrl: captionUrl ? captionUrl.slice(0, 80) : null });

  // Method 1: captionUrl from ytInitialPlayerResponse (MAIN world via popup)
  if (captionUrl) {
    console.log("[yt-ext] trying Method 1: captionUrl XML");
    const t = await fetchCaptionXML(captionUrl);
    if (t) { console.log("[yt-ext] Method 1 OK, len=", t.length); return { transcript: t }; }
    console.log("[yt-ext] Method 1 failed");
  }

  // Method 2: timedtext API (JSON3 + XML, multiple langs)
  console.log("[yt-ext] trying Method 2: timedtext API");
  const t2 = await tryTimedtextAPI(videoId);
  if (t2) { console.log("[yt-ext] Method 2 OK, len=", t2.length); return { transcript: t2 }; }
  console.log("[yt-ext] Method 2 failed");

  // Method 3: YouTube innertube (internal API — most reliable, no HTML parsing)
  console.log("[yt-ext] trying Method 3: innertube API");
  const t3 = await tryInnertubeAPI(videoId);
  if (t3) { console.log("[yt-ext] Method 3 OK, len=", t3.length); return { transcript: t3 }; }
  console.log("[yt-ext] Method 3 failed");

  // Method 4: fetch watch page HTML + bracket-count JSON extraction
  console.log("[yt-ext] trying Method 4: fetch page HTML");
  const t4 = await tryFetchFromPage(videoId);
  if (t4) { console.log("[yt-ext] Method 4 OK, len=", t4.length); return { transcript: t4 }; }
  console.log("[yt-ext] Method 4 failed — giving up");

  throw new Error("No transcript found. This video may not have subtitles enabled.");
}

// ── Method 2 ─────────────────────────────────────────────────────────────────

async function tryTimedtextAPI(videoId) {
  const attempts = [
    { lang: "en", kind: "" },
    { lang: "ru", kind: "" },
    { lang: "uk", kind: "" },
    { lang: "en", kind: "asr" },
    { lang: "ru", kind: "asr" },
    { lang: "uk", kind: "asr" },
  ];

  for (const { lang, kind } of attempts) {
    try {
      const kindParam = kind ? `&kind=${kind}` : "";

      // JSON3
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}&fmt=json3`;
      const res = await fetchWith(url, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.events?.length) {
          const text = data.events
            .filter(e => e.segs)
            .flatMap(e => e.segs.map(s => s.utf8 || ""))
            .join(" ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
          if (text.length > 50) return text;
        }
      }

      // XML fallback
      const xmlUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}`;
      const xmlRes = await fetchWith(xmlUrl, 5000);
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

// ── Method 3 ─────────────────────────────────────────────────────────────────

async function tryInnertubeAPI(videoId) {
  try {
    const res = await fetchWith(
      "https://www.youtube.com/youtubei/v1/player",
      TIMEOUT_MS,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": "1",
          "X-YouTube-Client-Version": "2.20231121.06.00",
          "User-Agent": UA,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20231121.06.00",
              hl: "en",
              gl: "US",
            },
          },
        }),
      }
    );
    if (!res.ok) { console.log("[yt-ext] innertube HTTP", res.status); return null; }
    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    console.log("[yt-ext] innertube tracks:", tracks.length, tracks.map(t => t.languageCode + (t.kind ? "/" + t.kind : "")));
    if (!tracks.length) return null;

    for (const track of tracks) {
      if (!track.baseUrl) continue;
      const text = await fetchCaptionXML(track.baseUrl);
      if (text) return text;
    }
    return null;
  } catch (e) { console.log("[yt-ext] innertube error:", e.message); return null; }
}

// ── Method 4 ─────────────────────────────────────────────────────────────────

async function tryFetchFromPage(videoId) {
  try {
    const res = await fetchWith(
      `https://www.youtube.com/watch?v=${videoId}`,
      TIMEOUT_MS,
      { headers: { "User-Agent": UA } }
    );
    if (!res.ok) return null;
    const html = await res.text();

    const data = extractJSONFromHTML(html, "ytInitialPlayerResponse");
    if (!data) { console.log("[yt-ext] page: ytInitialPlayerResponse not found in HTML"); return null; }

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    console.log("[yt-ext] page tracks:", tracks.length);
    if (!tracks.length) return null;

    for (const track of tracks) {
      if (!track.baseUrl) continue;
      const text = await fetchCaptionXML(track.baseUrl);
      if (text) return text;
    }
    return null;
  } catch (e) { console.log("[yt-ext] page error:", e.message); return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Bracket-counting JSON extraction — works regardless of minification
function extractJSONFromHTML(html, key) {
  const keyIdx = html.indexOf(key);
  if (keyIdx === -1) return null;
  const start = html.indexOf("{", keyIdx);
  if (start === -1) return null;

  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function fetchCaptionXML(url) {
  try {
    const res = await fetchWith(url, TIMEOUT_MS);
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
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ").trim()
    )
    .filter(Boolean)
    .join(" ");
  return transcript.length > 50 ? transcript : null;
}

function fetchWith(url, ms = TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal, ...options }).finally(() => clearTimeout(timer));
}
