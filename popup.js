const PROMPT_TEMPLATE = (title, transcript) => `
Please summarize the following YouTube video.

**Video title:** ${title}

**Instructions:**
- Write a concise summary (5-10 bullet points)
- Highlight the key ideas and takeaways
- Keep it clear and easy to understand

**Transcript:**
${transcript.slice(0, 12000)}
`.trim();

function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getTranscript() {
  setStatus('<span class="loader"></span> Extracting transcript...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes("youtube.com/watch")) {
    setStatus("⚠️ Open a YouTube video first!", "error");
    return null;
  }

  // Inject content script if not loaded
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  }).catch(() => {}); // Already loaded — ignore error

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { action: "getTranscript" }, response => {
      if (chrome.runtime.lastError || !response) {
        setStatus("❌ Could not connect. Refresh the YouTube page.", "error");
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// Open ChatGPT with the prompt
document.getElementById("btnChatGPT").addEventListener("click", async () => {
  document.getElementById("btnChatGPT").disabled = true;

  const result = await getTranscript();
  if (!result) { document.getElementById("btnChatGPT").disabled = false; return; }
  if (result.error) {
    setStatus("❌ " + result.error, "error");
    document.getElementById("btnChatGPT").disabled = false;
    return;
  }

  const prompt = PROMPT_TEMPLATE(result.title, result.transcript);

  // Copy prompt to clipboard
  await navigator.clipboard.writeText(prompt);

  // Open ChatGPT
  chrome.tabs.create({ url: "https://chatgpt.com/" });

  setStatus("✅ Prompt copied! Paste it in ChatGPT (Ctrl+V)", "success");
  document.getElementById("btnChatGPT").disabled = false;
});

// Copy transcript only
document.getElementById("btnCopy").addEventListener("click", async () => {
  document.getElementById("btnCopy").disabled = true;

  const result = await getTranscript();
  if (!result) { document.getElementById("btnCopy").disabled = false; return; }
  if (result.error) {
    setStatus("❌ " + result.error, "error");
    document.getElementById("btnCopy").disabled = false;
    return;
  }

  await navigator.clipboard.writeText(result.transcript);
  setStatus("✅ Transcript copied to clipboard!", "success");
  document.getElementById("btnCopy").disabled = false;
});
