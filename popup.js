const PROMPT_TEMPLATE = (title, transcript) => `Please summarize the following YouTube video.

**Video title:** ${title}

**Instructions:**
- Write a concise summary (5-10 bullet points)
- Highlight the key ideas and takeaways
- Keep it clear and easy to understand

**Transcript:**
${transcript.slice(0, 12000)}`;

function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.innerHTML = msg;
}

async function getTranscriptFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || !tab.url.includes("youtube.com/watch")) {
    setStatus("⚠️ Open a YouTube video first!", "error");
    return null;
  }

  // Inject content script fresh every time (safe with duplicate guard)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (e) { /* already injected */ }

  // Small delay to ensure script is ready
  await new Promise(r => setTimeout(r, 200));

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { action: "getTranscript" }, response => {
      if (chrome.runtime.lastError || !response) {
        setStatus("❌ Could not connect. Refresh the YouTube page and try again.", "error");
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// Copy text using a hidden textarea (more reliable than clipboard API in extensions)
function copyToClipboard(text) {
  return new Promise((resolve) => {
    navigator.clipboard.writeText(text).then(resolve).catch(() => {
      // Fallback: textarea trick
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        resolve();
      } catch (e) {
        resolve();
      }
      document.body.removeChild(ta);
    });
  });
}

// ✨ Summarize with ChatGPT
document.getElementById("btnChatGPT").addEventListener("click", async () => {
  const btn = document.getElementById("btnChatGPT");
  btn.disabled = true;
  setStatus('<span class="loader"></span> Extracting transcript...');

  const result = await getTranscriptFromTab();
  if (!result) { btn.disabled = false; return; }
  if (result.error) {
    setStatus("❌ " + result.error, "error");
    btn.disabled = false;
    return;
  }

  setStatus('<span class="loader"></span> Copying prompt...');
  const prompt = PROMPT_TEMPLATE(result.title, result.transcript);

  await copyToClipboard(prompt);

  // Store in localStorage as backup
  try { localStorage.setItem("yt_summary_prompt", prompt); } catch(e){}

  setStatus("✅ Done! ChatGPT is opening...<br><b>Press Ctrl+V (or ⌘+V) to paste!</b>", "success");

  // Small delay so user sees the message before popup closes
  setTimeout(() => {
    chrome.tabs.create({ url: "https://chatgpt.com/" });
  }, 800);

  btn.disabled = false;
});

// 📋 Copy transcript only
document.getElementById("btnCopy").addEventListener("click", async () => {
  const btn = document.getElementById("btnCopy");
  btn.disabled = true;
  setStatus('<span class="loader"></span> Extracting transcript...');

  const result = await getTranscriptFromTab();
  if (!result) { btn.disabled = false; return; }
  if (result.error) {
    setStatus("❌ " + result.error, "error");
    btn.disabled = false;
    return;
  }

  await copyToClipboard(result.transcript);
  setStatus("✅ Transcript copied to clipboard!", "success");
  btn.disabled = false;
});
