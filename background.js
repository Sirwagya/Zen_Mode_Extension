const STORAGE_KEYS = {
  API_KEY: 'focusmate_api_key',
  TOPIC: 'focusmate_topic',
  BLOCKLIST: 'focusmate_blocklist',
  BREAK_MODE: 'focusmate_break_mode',
  TEMP_ALLOW: 'focusmate_temp_allow'
};

const DEFAULT_API_KEY = 'YOUR API KEY';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Generate a simple circular icon with a centered "Z" and set it as the action icon.
// This helps when packaged PNGs lack a visible foreground.
async function generateAndSetActionIcon() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return;
    const sizes = [128, 48, 16];
    const imageData = {};
    // Theme colors: black square background and green Z
    const GREEN = '#10b981';
    const BLACK = '#000000';

    for (const size of sizes) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);

      // Draw black square background
      ctx.fillStyle = BLACK;
      ctx.fillRect(0, 0, size, size);

      // Draw centered green 'Z'
      const fontSize = Math.floor(size * 0.70); // slightly larger for square
      ctx.font = `bold ${fontSize}px -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
      ctx.fillStyle = GREEN;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      // Use TextMetrics to vertically center precisely when available
      const text = 'Z';
      const metrics = ctx.measureText(text);
      const ascent = metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
      const descent = metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
      const textHeight = ascent + descent;
      const y = Math.round((size - textHeight) / 2 + ascent); // center baseline
      const x = Math.round(size / 2);
      ctx.fillText(text, x, y);

      imageData[size] = ctx.getImageData(0, 0, size, size);
    }

    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn('generateAndSetActionIcon failed', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [STORAGE_KEYS.BLOCKLIST]: ['youtube.com', 'instagram.com'],
    [STORAGE_KEYS.API_KEY]: DEFAULT_API_KEY,
    [STORAGE_KEYS.BREAK_MODE]: false,
    [STORAGE_KEYS.TEMP_ALLOW]: {}
  });
  // Ensure a visible toolbar icon even if provided PNGs are only backgrounds
  generateAndSetActionIcon().catch(() => {});
});

// Also try to set generated icon on startup of the service worker
generateAndSetActionIcon().catch(() => {});

// Badge feedback helper (avoids notifications permission)
async function badgePing(tabId, text, ms = 2500) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
    await chrome.action.setBadgeText({ text, tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), ms);
  } catch (e) {
    console.warn('Badge update failed', e);
  }
}

function domainMatch(url, list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.some(site => url.includes(site));
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function pruneTempAllow(map) {
  const now = Date.now();
  let changed = false;
  for (const [host, ts] of Object.entries(map)) {
    if (!Number.isFinite(ts) || ts <= now) {
      delete map[host];
      changed = true;
    }
  }
  return changed;
}

chrome.webNavigation.onCompleted.addListener(async details => {
  const { url, tabId, frameId } = details;
  if (frameId !== 0) return;
  const { focusmate_break_mode, focusmate_blocklist, focusmate_topic, focusmate_api_key, focusmate_temp_allow } = await chrome.storage.local.get();
  const host = getHostname(url);
  const tempAllow = focusmate_temp_allow || {};
  // Clean expired temp allows
  if (pruneTempAllow(tempAllow)) {
    chrome.storage.local.set({ [STORAGE_KEYS.TEMP_ALLOW]: tempAllow });
  }
  // Skip if temporarily allowed
  if (tempAllow[host] && tempAllow[host] > Date.now()) return;
  if (focusmate_break_mode) return;

  if (domainMatch(url, focusmate_blocklist)) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showBlock,
      args: ['This site is in your blocklist. Stay focused!']
    });
    badgePing(tabId, 'BLK');
    return;
  }

  if (!focusmate_topic) return;

  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: getPageContent });
    const text = result.title + ' ' + result.description;

    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': focusmate_api_key || DEFAULT_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Determine if this content is relevant to ${focusmate_topic}. Reply only with yes or no: ${text}` }] }]
      })
    });

    const data = await response.json();

    let replyText = '';
    try {
      replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.toLowerCase() || JSON.stringify(data).toLowerCase();
    } catch (e) {
      replyText = JSON.stringify(data).toLowerCase();
    }

    if (replyText.includes('no') && !replyText.includes('yes')) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showBlock,
        args: [`This page isn't related to your topic: ${focusmate_topic}`]
      });
      badgePing(tabId, 'IRR');
    } else {
      console.log('Gemini judged relevant or unclear:', replyText);
    }
  } catch (e) {
    console.warn('Gemini relevance check failed', e);
  }
});

function getPageContent() {
  const title = document.title;
  const description = document.querySelector('meta[name="description"]')?.content || '';
  return { title, description };
}

function showBlock(message) {
  if (document.getElementById('focus-blocker')) return; // prevent duplicates
  let div = document.createElement('div');
  div.id = 'focus-blocker';
  Object.assign(div.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    background: 'rgba(2,6,23,0.92)', // dark backdrop
    backdropFilter: 'blur(6px)',
    zIndex: 999999999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    color: '#e5e7eb',
    flexDirection: 'column',
    padding: '24px',
    boxSizing: 'border-box'
  });
  const btnStyle = `margin-top:12px;padding:10px 14px;background:#10b981;color:#06281a;border:none;border-radius:10px;cursor:pointer;font-weight:700;`;
  div.innerHTML = `<p style="max-width: 640px; text-align: center;">${message}</p><button id='allow' style="${btnStyle}">Allow 5 min</button>`;
  document.body.appendChild(div);
  document.getElementById('allow').onclick = () => {
    window.postMessage({ type: 'FOCUSMATE_ALLOW', minutes: 5 }, '*');
    div.remove();
  };
}

// Receive allow messages from content script
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg && msg.type === 'ALLOW_DOMAIN' && typeof msg.minutes === 'number' && msg.domain) {
    const minutes = Math.max(1, Math.min(120, Math.floor(msg.minutes)));
    chrome.storage.local.get(STORAGE_KEYS.TEMP_ALLOW, (data) => {
      const map = data[STORAGE_KEYS.TEMP_ALLOW] || {};
      map[msg.domain] = Date.now() + minutes * 60_000;
      chrome.storage.local.set({ [STORAGE_KEYS.TEMP_ALLOW]: map });
    });
  }
});