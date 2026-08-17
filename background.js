// background.js — MV3 service worker
//
// Keeps a simple session counter of hidden posts in chrome.storage.local so
// popup.html can read it. "Session" here = since the browser/extension was
// last restarted; reset it manually via the popup's reset button, or add
// your own boundary (e.g. clear on browser startup) later.

const STORAGE_KEY = "authenticHubSessionCount";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AI_POST_HIDDEN") {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const next = (res[STORAGE_KEY] || 0) + 1;
      chrome.storage.local.set({ [STORAGE_KEY]: next });
    });
  }
  if (message?.type === "RESET_COUNT") {
    chrome.storage.local.set({ [STORAGE_KEY]: 0 }, () => sendResponse({ ok: true }));
    return true; // async sendResponse
  }
});