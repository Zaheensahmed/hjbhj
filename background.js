// background.js -- the service worker.
//
// Two jobs:
//   1. seed the profile into chrome.storage.local on install
//   2. own the harvest pipeline's tail: a content script cannot import engine/,
//      so it ships raw panel text here, and this worker parses it, runs
//      eligibility against the real Required and Preferred text, and stores the
//      record keyed by listing URL.
//
// There is no content_scripts block in the manifest and nothing registered
// here, so no code of ours can run on page load. Injection happens only from
// the popup, which only exists because you clicked the toolbar button.

import { getProfile, setProfile, putHarvested, setRun, getTriage } from "./shared/store.js";
import { parsePanel } from "./engine/harvest.js";
import { parsePosting } from "./engine/posting.js";
import { checkEligibility } from "./engine/eligibility.js";
import { harvestSummaryMessage, earlyTerminationMessage } from "./engine/queue.js";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getProfile();
  if (existing) return; // never clobber edits
  const res = await fetch(chrome.runtime.getURL("data/profile.json"));
  await setProfile(await res.json());
});

async function loadProfile() {
  const p = await getProfile();
  if (p) return p;
  const res = await fetch(chrome.runtime.getURL("data/profile.json"));
  return res.json();
}

/**
 * One harvested card. Parsed, checked for eligibility, and stored immediately,
 * so a run that stops halfway still leaves everything it read.
 */
async function handleRecord(payload) {
  const key = payload.listingUrl || `card:${payload.pageUrl}#${payload.cardId}`;

  if (payload.status !== "ok") {
    await putHarvested(key, {
      cardId: payload.cardId,
      listingUrl: payload.listingUrl || null,
      harvestStatus: "harvest failed",
      why: payload.why || null
    });
    return { stored: key, status: "failed" };
  }

  const profile = await loadProfile();
  const record = parsePanel({ ...payload.raw, jobrightUrl: payload.listingUrl });

  // Eligibility runs against the Required and Preferred bullets, which is the
  // text that actually carries graduation windows and enrollment rules. Stage 1
  // had none of this.
  const posting = parsePosting({
    text: record.eligibilityInput,
    title: record.header.title || "",
    host: "jobright-detail"
  });
  const eligibility = checkEligibility(profile, posting);

  await putHarvested(key, {
    cardId: payload.cardId,
    listingUrl: payload.listingUrl || null,
    pageUrl: payload.pageUrl,
    harvestStatus: "ok",
    throttled: Boolean(payload.throttled),
    renderMs: payload.renderMs || null,
    record,
    eligibility,
    blocked: eligibility.blocked
  });

  return { stored: key, status: "ok", blocked: eligibility.blocked };
}

// ------------------------------------------------------- badge and notifications
//
// The content script cannot call chrome.notifications or chrome.action, so it
// messages here. This worker owns both.

const NOTIFICATION_ID = "jaf-harvest";
let harvestTabId = null;
let harvestWindowId = null;

async function setBadge(text, anyFailed) {
  try {
    await chrome.action.setBadgeText({ text: String(text || "") });
    await chrome.action.setBadgeBackgroundColor({ color: anyFailed ? "#d97706" : "#16a34a" });
  } catch { /* the action may not be ready during startup */ }
}

async function setBadgeTitle(title) {
  // The badge fits about four characters, so "12/40" can clip. The full
  // progress always lives in the tooltip.
  try { await chrome.action.setTitle({ title: title || "Fill this application" }); } catch { /* ignore */ }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
      priority: 1
    });
  } catch { /* notifications may be denied at the OS level */ }
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIFICATION_ID) return;
  try {
    if (harvestTabId != null) await chrome.tabs.update(harvestTabId, { active: true });
    if (harvestWindowId != null) await chrome.windows.update(harvestWindowId, { focused: true });
    await chrome.notifications.clear(NOTIFICATION_ID);
  } catch { /* the tab may be gone */ }
});

/** Counts for the completion message, read from what was actually stored. */
async function harvestCounts() {
  const t = await getTriage();
  const records = Object.values(t.harvested || {});
  const ok = records.filter((r) => r.harvestStatus === "ok");
  return {
    reviewed: ok.length,
    worthApplying: ok.filter((r) => !r.blocked).length,
    skipped: ok.filter((r) => r.blocked).length,
    failed: records.filter((r) => r.harvestStatus !== "ok").length
  };
}

const handlers = {
  "harvest:start": async (payload, sender) => {
    harvestTabId = sender && sender.tab ? sender.tab.id : null;
    harvestWindowId = sender && sender.tab ? sender.tab.windowId : null;
    await setRun({ phase: "running", total: payload.total, done: 0, failed: 0, startedAt: new Date().toISOString() });
    await setBadge(`0/${payload.total}`, false);
    await setBadgeTitle(`Harvesting 0 of ${payload.total}`);
    return { ok: true };
  },
  "harvest:record": handleRecord,
  "harvest:progress": async (payload) => {
    await setRun({ phase: "running", ...payload, updatedAt: new Date().toISOString() });
    await setBadge(`${payload.done}/${payload.total}`, payload.failed > 0);
    await setBadgeTitle(
      `Harvesting ${payload.done} of ${payload.total}` +
      (payload.failed ? `, ${payload.failed} failed` : "")
    );
    return { ok: true };
  },
  "harvest:end": async (payload) => {
    await setRun({ phase: "done", ...payload, finishedAt: new Date().toISOString() });
    const counts = await harvestCounts();
    await setBadge(counts.failed ? String(counts.failed) : "", counts.failed > 0);
    await setBadgeTitle(counts.failed ? `${counts.failed} cards failed to harvest` : "Fill this application");

    if (payload.stoppedEarly) {
      await notify("Jobright triage stopped", earlyTerminationMessage({
        reason: payload.stopReason || "unknown",
        done: payload.done || 0,
        total: payload.total || 0,
        failed: payload.failed || 0
      }));
    } else {
      await notify("Jobright triage done", harvestSummaryMessage(counts));
    }
    return { ok: true, counts };
  },
  "badge:clear": async () => {
    await setBadge("", false);
    await setBadgeTitle(null);
    try { await chrome.notifications.clear(NOTIFICATION_ID); } catch { /* ignore */ }
    return { ok: true };
  },
  "queue:focusCard": async (payload) => {
    // Brings the Jobright card into view so YOU can mark it applied. The
    // extension never answers that prompt itself.
    if (harvestTabId == null) return { ok: false, why: "no Jobright tab recorded in this session" };
    try {
      await chrome.tabs.update(harvestTabId, { active: true });
      if (harvestWindowId != null) await chrome.windows.update(harvestWindowId, { focused: true });
      await chrome.scripting.executeScript({
        target: { tabId: harvestTabId },
        args: [payload.cardId],
        func: (cardId) => {
          const api = globalThis.JAF_JR;
          return api && api.focusCard ? api.focusCard(cardId) : false;
        }
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, why: String(err && err.message ? err.message : err) };
    }
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg.payload || {}, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
  return true; // keeps the channel open for the async reply
});
