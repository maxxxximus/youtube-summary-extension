// chatgpt-inject.js
// Auto-injects the YouTube summary prompt into ChatGPT.
// Uses multiple fallback methods to work in Chrome, Brave, and Firefox.

(async () => {
  const data = await chrome.storage.local.get("yt_prompt");
  if (!data.yt_prompt) return;

  const prompt = data.yt_prompt;
  await chrome.storage.local.remove("yt_prompt");

  // Wait for ChatGPT input to appear (up to 15 seconds)
  const el = await waitFor(() =>
    document.querySelector("#prompt-textarea") ||
    document.querySelector("div[contenteditable='true'][data-id]") ||
    document.querySelector("div[contenteditable='true']") ||
    document.querySelector("textarea")
  , 15000);

  if (!el) return;

  el.focus();

  // Try all methods one by one until text appears
  const success = await tryMethod1(el, prompt) ||
                  await tryMethod2(el, prompt) ||
                  await tryMethod3(el, prompt);

  if (!success) {
    // Last resort: show a floating overlay with the prompt + copy button
    showFallbackOverlay(prompt);
  }
})();


// Method 1: execCommand insertText (works in Brave + Chrome)
async function tryMethod1(el, text) {
  try {
    el.focus();
    // Clear existing content first
    document.execCommand("selectAll", false, null);
    const result = document.execCommand("insertText", false, text);
    await wait(300);
    if (getContent(el).length > 10) return true;
  } catch {}
  return false;
}

// Method 2: Simulate paste via DataTransfer (works in Chrome, sometimes Brave)
async function tryMethod2(el, text) {
  try {
    el.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    }));
    await wait(400);
    if (getContent(el).length > 10) return true;
  } catch {}
  return false;
}

// Method 3: React fiber direct update (works when React exposes fiber)
async function tryMethod3(el, text) {
  try {
    const fiberKey = Object.keys(el).find(k =>
      k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
    );
    if (!fiberKey) return false;

    const fiber = el[fiberKey];
    let inst = fiber;
    while (inst) {
      if (inst.memoizedProps && typeof inst.memoizedProps.onChange === "function") {
        inst.memoizedProps.onChange({ target: { value: text } });
        await wait(300);
        if (getContent(el).length > 10) return true;
        break;
      }
      inst = inst.return;
    }
  } catch {}
  return false;
}

// Fallback: floating overlay with the prompt text and a copy button
function showFallbackOverlay(text) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed; top:20px; right:20px; z-index:99999;
    background:#1a1a2e; border:1px solid #10a37f; border-radius:12px;
    padding:16px; width:340px; box-shadow:0 4px 24px rgba(0,0,0,0.5);
    font-family:sans-serif; color:#fff;
  `;
  overlay.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">
      🎬 YouTube Summary — paste manually
    </div>
    <textarea readonly style="
      width:100%;height:100px;background:#111;border:1px solid #333;
      border-radius:6px;color:#ccc;font-size:11px;padding:8px;resize:none;
    ">${text.slice(0, 300)}...</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button id="yt-copy-btn" style="
        flex:1;padding:8px;background:#10a37f;border:none;border-radius:6px;
        color:#fff;font-weight:600;cursor:pointer;font-size:12px;
      ">📋 Copy full prompt</button>
      <button id="yt-close-btn" style="
        padding:8px 12px;background:#333;border:none;border-radius:6px;
        color:#ccc;cursor:pointer;font-size:12px;
      ">✕</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("yt-copy-btn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById("yt-copy-btn").textContent = "✅ Copied!";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      document.getElementById("yt-copy-btn").textContent = "✅ Copied!";
    }
  };
  document.getElementById("yt-close-btn").onclick = () => overlay.remove();
}

// Helpers
function getContent(el) {
  return el.value || el.innerText || el.textContent || "";
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitFor(fn, timeout = 10000) {
  return new Promise(resolve => {
    const el = fn();
    if (el) return resolve(el);
    const start = Date.now();
    const iv = setInterval(() => {
      const el = fn();
      if (el) { clearInterval(iv); resolve(el); }
      else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
    }, 200);
  });
}
