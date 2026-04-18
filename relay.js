const promptBox    = document.getElementById("promptBox");
const videoTitle   = document.getElementById("videoTitle");
const statusEl     = document.getElementById("status");
const btnChatGPT   = document.getElementById("btnChatGPT");
const btnCopy      = document.getElementById("btnCopy");

// Load prompt from storage
chrome.storage.local.get(["yt_prompt", "yt_title"], (data) => {
  if (!data.yt_prompt) {
    promptBox.value = "No prompt found. Go back to YouTube and click the extension button.";
    videoTitle.textContent = "";
    return;
  }
  promptBox.value = data.yt_title ? `📹 ${data.yt_title}` : "";
  videoTitle.textContent = data.yt_title || "";
  promptBox.value = data.yt_prompt;
});

// Copy prompt to clipboard
btnCopy.addEventListener("click", async () => {
  const text = promptBox.value;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    showStatus("✅ Copied to clipboard!");
  } catch {
    // Fallback: select all text in textarea
    promptBox.select();
    document.execCommand("copy");
    showStatus("✅ Copied! (fallback)");
  }
});

// Open ChatGPT — prompt auto-injects via chatgpt-inject.js
btnChatGPT.addEventListener("click", async () => {
  const text = promptBox.value;
  if (!text) return;

  // Save prompt back to storage so chatgpt-inject.js picks it up
  await chrome.storage.local.set({ yt_prompt: text });

  showStatus("✅ Opening ChatGPT — prompt will auto-paste!");
  window.open("https://chatgpt.com/", "_blank");
});

function showStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { statusEl.textContent = ""; }, 4000);
}
