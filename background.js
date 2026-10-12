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

import { getProfile, setProfile, putHarvested, setRun } from "./shared/store.js";
import { parsePanel } from "./engine/harvest.js";
import { parsePosting } from "./engine/posting.js";
import { checkEligibility } from "./engine/eligibility.js";

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

const handlers = {
  "harvest:start": async (payload) => {
    await setRun({ phase: "running", total: payload.total, done: 0, failed: 0, startedAt: new Date().toISOString() });
    return { ok: true };
  },
  "harvest:record": handleRecord,
  "harvest:progress": async (payload) => {
    await setRun({ phase: "running", ...payload, updatedAt: new Date().toISOString() });
    return { ok: true };
  },
  "harvest:end": async (payload) => {
    await setRun({ phase: "done", ...payload, finishedAt: new Date().toISOString() });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg.payload || {})
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
  return true; // keeps the channel open for the async reply
});
