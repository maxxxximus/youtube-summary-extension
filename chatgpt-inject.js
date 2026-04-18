// chatgpt-inject.js
// Runs on chatgpt.com — checks if there's a pending prompt in storage,
// waits for the input to appear, pastes it automatically, then clears storage.

(async () => {
  const data = await chrome.storage.local.get("yt_prompt");
  if (!data.yt_prompt) return; // Nothing to inject

  const prompt = data.yt_prompt;

  // Clear immediately so it doesn't re-inject on next ChatGPT visit
  await chrome.storage.local.remove("yt_prompt");

  // Wait for ChatGPT's input field to appear (it loads dynamically)
  const el = await waitFor(() =>
    document.querySelector("#prompt-textarea") ||
    document.querySelector("div[contenteditable='true']") ||
    document.querySelector("textarea")
  , 15000);

  if (!el) return; // Gave up waiting

  el.focus();

  // Simulate a paste event — works with React's synthetic event system
  const dt = new DataTransfer();
  dt.setData("text/plain", prompt);
  el.dispatchEvent(new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true
  }));

  // Fallback: if paste didn't work, try execCommand
  setTimeout(() => {
    if (el.innerText.trim().length < 10) {
      el.focus();
      document.execCommand("insertText", false, prompt);
    }
  }, 500);

})();

// Polls every 200ms until the element appears or timeout
function waitFor(fn, timeout = 10000) {
  return new Promise(resolve => {
    const start = Date.now();
    const interval = setInterval(() => {
      const result = fn();
      if (result) {
        clearInterval(interval);
        resolve(result);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}
