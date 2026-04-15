// Pro Scraper v3.0 — Background Service Worker
'use strict';

// Relay content-script messages to popup (popup may be closed)
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg._from === 'content') {
    chrome.runtime.sendMessage(msg).catch(() => {
      if (['progress','done','error','started'].includes(msg.type)) {
        chrome.storage.local.set({ lastStatus: msg });
      }
    });
  }
  respond({ ok: true });
  return true;
});

// Clear stale state on navigation
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.storage.local.remove(['lastStatus']);
});
