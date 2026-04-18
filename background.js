// background.js — service worker
// Only fetches the caption file (URL comes from content.js which has YouTube cookies)

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
  let transcript = null;

  // Method 1: use captionUrl extracted by content.js (has cookies, most reliable)
  if (captionUrl) {
    transcript = await fetchCaptionXML(captionUrl);
  }

  // Method 2: timedtext API fallback
  if (!transcript) {
    transcript = await tryTimedtextAPI(videoId);
  }

  if (!transcript) {
    throw new Error("No transcript found. This video may not have subtitles enabled.");
  }

  return { transcript };
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
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kindParam}&fmt=json3`;
      const res = await fetchWithTimeout(url, 5000);
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
    } catch { continue; }
  }
  return null;
}

async function fetchCaptionXML(url) {
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
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
  } catch { return null; }
}

function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
