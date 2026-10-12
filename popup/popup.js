// popup/popup.js -- the shell. Loads the profile, switches tabs, and hands off.
//
// The page tab injects and fills. The paste tab does not. Keeping them in
// separate modules means a break in one cannot take the other down.

import { getProfile, getLearned, getPrefs } from "../shared/store.js";
import { $, setStatus } from "./ui.js";
import { initPageTab, runPage } from "./tab-page.js";
import { initPasteTab } from "./tab-paste.js";
import { initTriageTab, runTriage, isJobright } from "./tab-triage.js";
import { initQueueTab, load as loadQueue } from "./tab-queue.js";

function switchTab(name) {
  if (name === "queue") loadQueue();
  for (const btn of $("tabs").querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = panel.id !== "panel-" + name;
  }
  $("status").hidden = name !== "page";
}

(async function boot() {
  for (const btn of $("tabs").querySelectorAll("button")) {
    btn.onclick = () => switchTab(btn.dataset.tab);
  }

  // The badge carries harvest progress. Opening the popup is the point at
  // which you have seen it, so it clears here. The worker owns it.
  chrome.runtime.sendMessage({ type: "badge:clear" }).catch(() => {});

  let profile = await getProfile();
  if (!profile) {
    const res = await fetch(chrome.runtime.getURL("data/profile.json"));
    profile = await res.json();
  }
  const learned = await getLearned();
  const prefs = await getPrefs();

  // The paste tab has no dependency on the page, so it is ready either way.
  initPasteTab(profile);
  initQueueTab();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("This page is not a website the extension can read. The paste tab still works.", "red");
    switchTab("paste");
    return;
  }

  initTriageTab({ tabId: tab.id });

  // A Jobright board has no application form on it, so scanning it as one would
  // only produce noise. Go straight to triage instead.
  if (isJobright(tab.url)) {
    switchTab("triage");
    setStatus("Jobright board detected.", null);
    try {
      await runTriage();
    } catch (err) {
      $("tri-status").textContent = `Triage failed: ${err && err.message ? err.message : err}`;
    }
    return;
  }

  initPageTab({ profile, learned, prefs, tabId: tab.id });
  try {
    await runPage({});
  } catch (err) {
    setStatus(`Scan failed: ${err && err.message ? err.message : err}. The paste tab still works.`, "red");
  }
})();
