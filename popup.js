function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function run() {
  const btn = document.getElementById("btnSummarize");
  btn.disabled = true;
  setStatus('<span class="loader"></span> Getting video info...');

  const tab = await getCurrentTab();

  if (!tab.url || !tab.url.includes("youtube.com/watch")) {
    setStatus("⚠️ Open a YouTube video first!", "error");
    btn.disabled = false;
    return;
  }

  // Step 1: Get video ID from content script
  let videoInfo;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    videoInfo = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: "getVideoInfo" }, res => {
        if (chrome.runtime.lastError || !res) reject(new Error("Could not connect. Refresh the page."));
        else resolve(res);
      });
    });
  } catch (e) {
    setStatus("❌ " + e.message, "error");
    btn.disabled = false;
    return;
  }

  if (videoInfo.error) {
    setStatus("❌ " + videoInfo.error, "error");
    btn.disabled = false;
    return;
  }

  setStatus('<span class="loader"></span> Fetching transcript...');

  // Step 2: Ask background.js to fetch transcript (bypasses Brave Shields)
  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: "fetchTranscript", videoId: videoInfo.videoId },
      res => resolve(res || { error: "No response from background." })
    );
  });

  if (result.error) {
    setStatus("❌ " + result.error, "error");
    btn.disabled = false;
    return;
  }

  // Step 3: Save to storage and open relay page
  const prompt = buildPrompt(result.title, result.transcript);
  await chrome.storage.local.set({ yt_prompt: prompt, yt_title: result.title });

  setStatus("✅ Done! Opening prompt page...", "success");

  setTimeout(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("relay.html") });
  }, 500);

  btn.disabled = false;
}

function buildPrompt(title, transcript) {
  return `Please summarize the following YouTube video.

**Video title:** ${title}

**Instructions:**
- Write a concise summary (5-10 bullet points)
- Highlight the key ideas and takeaways
- Keep it clear and easy to understand

**Transcript:**
${transcript.slice(0, 14000)}`;
}

document.getElementById("btnSummarize").addEventListener("click", run);
