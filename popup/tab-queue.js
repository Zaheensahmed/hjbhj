// popup/tab-queue.js -- the work queue.
//
// Shortlisted roles, their destination, verdict and referral leads. "Open next"
// opens one destination in a foreground tab and marks it opened.
//
// Nothing here can mark an item submitted. That is yours, and only when you say
// so does anything reach the tracker. Marking it applied on Jobright afterwards
// is a separate, explicit step, and even then the extension only brings the
// card into view: it never answers that prompt for you.

import { getTriage, setQueueStatus, setShortlisted, addTrackerRecord } from "../shared/store.js";
import { nextToOpen, advanceOnOpen, queueSummary, toTrackerRecord, QUEUE_STATUSES } from "../engine/queue.js";
import { $, esc, show, flash } from "./ui.js";

const state = { store: null, entries: [], lastSubmitted: null };

export function initQueueTab() {
  $("q-refresh").onclick = () => load();
  $("q-open-next").onclick = () => openNext();
  load();
}

function entriesFrom(store) {
  return Object.values(store.shortlist || {}).map((s) => {
    const h = store.harvested[s.listingUrl] || null;
    const rec = h && h.record ? h.record : null;
    return {
      ...s,
      queueStatus: s.queueStatus || "queued",
      destinationUrl: (rec && rec.destinationUrl) || s.destinationUrl || s.listingUrl || null,
      resolvesOnOpen: rec ? Boolean(rec.resolvesOnOpen) : null,
      referralLeads: rec ? rec.insider.leads : (s.referralLead ? [s.referralLead] : []),
      harvested: h,
      blocked: h ? Boolean(h.blocked) : null
    };
  }).sort((a, b) =>
    QUEUE_STATUSES.indexOf(a.queueStatus) - QUEUE_STATUSES.indexOf(b.queueStatus) ||
    String(a.company || "").localeCompare(String(b.company || "")));
}

export async function load() {
  state.store = await getTriage();
  state.entries = entriesFrom(state.store);
  render();
}

async function openNext() {
  const next = nextToOpen(state.entries);
  if (!next) { $("q-status").textContent = "Nothing queued."; return; }
  if (!next.destinationUrl) {
    $("q-status").textContent = `${next.company} has no destination URL on record. Harvest it first, or open it from the board.`;
    return;
  }
  // Foreground, because the point is that you look at it.
  await chrome.tabs.create({ url: next.destinationUrl, active: true });
  await setQueueStatus(next.listingUrl, advanceOnOpen(next.queueStatus));
  $("q-status").textContent = `Opened ${next.company}. Marked opened, not submitted. Opening a link is not applying.`;
  await load();
}

function render() {
  const s = queueSummary(state.entries);
  $("q-status").textContent = state.entries.length
    ? `${s.total} shortlisted. ${s.queued} queued, ${s.opened} opened, ${s.submitted} submitted, ${s.skipped} skipped. ${s.withReferral} with a referral lead.`
    : "Nothing shortlisted yet. Tick cards in the Triage tab.";

  $("q-open-next").disabled = !nextToOpen(state.entries);

  $("q-out").innerHTML = state.entries.map((e, i) => `
    <div class="card ${e.queueStatus === "submitted" ? "green" : e.queueStatus === "skipped" ? "" : e.blocked ? "red" : "blue"}">
      <div><strong>${esc(e.company || "(no company)")}</strong> <span class="tagline">${esc(e.verdict || "")}</span></div>
      <div class="val">${esc(e.title || "")}</div>
      ${e.blocked ? `<div class="why" style="color:var(--red)">Blocked on the real requirements: ${esc((e.harvested.eligibility.blockers[0] || {}).filter || "")}</div>` : ""}
      ${e.referralLeads && e.referralLeads.length
        ? `<div class="referral">${e.referralLeads.map((l) => esc(l.text)).join(" / ")}</div>` : ""}
      <div class="meta">${e.destinationUrl
        ? `<a href="${esc(e.destinationUrl)}" target="_blank" rel="noreferrer">${esc(e.destinationUrl.slice(0, 54))}</a>${e.resolvesOnOpen ? ' <span class="blank">resolves on open</span>' : ""}`
        : `<span class="blank">no destination URL yet</span>`}</div>
      <div class="row">
        <select data-status="${i}">${QUEUE_STATUSES.map((st) => `<option value="${st}"${st === e.queueStatus ? " selected" : ""}>${st}</option>`).join("")}</select>
        <button class="small ghost" data-remove="${i}">Remove</button>
      </div>
      <div class="q-after" data-after="${i}"></div>
    </div>`).join("");

  wire();
}

function wire() {
  for (const sel of $("q-out").querySelectorAll("[data-status]")) {
    sel.onchange = async () => {
      const e = state.entries[Number(sel.dataset.status)];
      const status = sel.value;
      await setQueueStatus(e.listingUrl, status);

      if (status === "submitted") {
        // You said so. Write the tracker record first, then offer the Jobright
        // step as a separate action.
        const record = toTrackerRecord(e, e.harvested, new Date().toISOString().slice(0, 10));
        const { added } = await addTrackerRecord(record);
        const after = $("q-out").querySelector(`[data-after="${sel.dataset.status}"]`);
        after.innerHTML = `
          <div class="banner blue">
            <strong>Written to the tracker</strong> as <code>${esc(record.id)}</code> (${added ? "new record" : "updated"}),
            status Applied, dated ${esc(record.date_applied)}. Open the tracker and copy the JSON to fold it into data.json.
            ${record.account_email === "" ? "The account email is blank, because nothing here knows which one you used." : ""}
          </div>
          <div class="row">
            <button class="small" data-jobright="${esc(e.listingUrl)}" data-card="${esc((e.harvested && e.harvested.cardId) || "")}">Mark applied on Jobright</button>
          </div>
          <p class="note">That button brings the card into view on the board. It does not answer Jobright's "Did you apply?" prompt, and nothing here ever will. A false applied-record is worse than none.</p>`;
        wireAfter();
      }
      await load();
    };
  }

  for (const btn of $("q-out").querySelectorAll("[data-remove]")) {
    btn.onclick = async () => {
      const e = state.entries[Number(btn.dataset.remove)];
      await setShortlisted(e.listingUrl, null, false);
      await load();
    };
  }
  wireAfter();
}

function wireAfter() {
  for (const btn of $("q-out").querySelectorAll("[data-jobright]")) {
    btn.onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: "queue:focusCard", payload: { cardId: btn.dataset.card } });
      if (res && res.ok) flash(btn, "Card in view");
      else btn.textContent = `Could not focus the board: ${res && res.why ? res.why : "unknown"}`;
    };
  }
}
