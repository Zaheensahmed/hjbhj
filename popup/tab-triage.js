// popup/tab-triage.js -- Jobright stage 1: board triage.
//
// Reads the board's cards as structured data, runs engine/triage.js over them,
// and ranks. Stage 1 has no job description text, so the best verdict available
// is REVIEW. Nothing here clicks anything on the page except a scroll-into-view.

import { getTriage, dismissCard, restoreCard, setShortlisted } from "../shared/store.js";
import { toPlain } from "../rules/jobright-rules.js";
import { triageAll } from "../engine/triage.js";
import { $, esc, show, wireCopyText, flash } from "./ui.js";

const state = { tabId: null, scan: null, store: null, result: null, showDismissed: false };

export function initTriageTab({ tabId }) {
  state.tabId = tabId;
  $("tri-scan").onclick = () => runTriage();
  $("tri-show-dismissed").onchange = (ev) => { state.showDismissed = ev.target.checked; render(); };
}

export function isJobright(url) {
  try { return /(^|\.)jobright\.ai$/i.test(new URL(url).hostname); } catch { return false; }
}

async function inject(files) {
  await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files });
}

async function call(fnName, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    args: [fnName, arg === undefined ? null : arg],
    func: (name, payload) => {
      const api = globalThis.JAF_JR;
      if (!api || typeof api[name] !== "function") return { __error: "jobright content script not loaded" };
      return api[name](payload);
    }
  });
  return res ? res.result : null;
}

export async function runTriage() {
  $("tri-status").textContent = "Scanning the board.";
  await inject(["content/jobright-scan.js"]);
  const scan = await call("scanBoard", toPlain());

  if (!scan || scan.__error) {
    $("tri-status").textContent = `Could not read the board. ${scan && scan.__error ? scan.__error : ""}`;
    return;
  }
  state.scan = scan;
  state.store = await getTriage();
  state.result = triageAll(scan.cards, state.store);
  render();
}

function render() {
  if (!state.result) return;
  const { rows, counts } = state.result;
  const scan = state.scan;

  $("tri-status").textContent =
    `${counts.total} cards found, ${counts.shown} shown. ${counts.review} to review, ${counts.skip} skipped, ` +
    `${counts.flagged} flagged, ${counts.referralLeads} referral lead${counts.referralLeads === 1 ? "" : "s"}.`;

  const notes = [];
  if (!counts.total) {
    notes.push(`<div class="banner red"><strong>No cards found.</strong> The page had ${scan.pageTextLength} characters of text, so it loaded, but nothing matched a card shape. Strategy tried: <code>${esc(scan.strategy)}</code>. Scroll the board so cards are rendered, then scan again. If it still finds nothing, the selectors in <code>rules/jobright-rules.js</code> need correcting against the real markup.</div>`);
  } else if (scan.strategy === "text heuristic") {
    notes.push(`<div class="banner amber">Cards were found by the text heuristic, not by a known selector, so the class names have probably changed. Extraction still works but is likelier to miss fields. Worth updating <code>CARD_SELECTORS</code>.</div>`);
  }
  if (counts.incomplete) {
    notes.push(`<div class="banner amber">${counts.incomplete} card${counts.incomplete === 1 ? "" : "s"} had fields that could not be read. Each one lists which, and has a <strong>raw text</strong> button so you can correct the pattern.</div>`);
  }
  notes.push(`<div class="banner blue">Stage 1 reads structured fields only. There is no job description text yet, so graduation windows and institution restrictions are unchecked and nothing here can say apply. <strong>REVIEW is the ceiling.</strong></div>`);

  const body = rows.map((r, i) => rowHtml(r, i)).join("");
  const dismissedUrls = Object.keys(state.store.dismissed);

  $("tri-out").innerHTML = notes.join("") + (rows.length ? `
    <table class="triage">
      <thead><tr>
        <th style="width:26px"></th><th style="width:58px">Verdict</th><th>Role</th>
        <th style="width:72px">Term</th><th style="width:52px">Match</th><th style="width:30px"></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>` : "") + (dismissedUrls.length ? `
    <h3 class="subhead">Dismissed (${dismissedUrls.length})</h3>
    <div>${dismissedUrls.map((u) => `
      <div class="card">
        <div class="val">${esc(u)}</div>
        <div class="row"><button class="small" data-restore="${esc(u)}">Restore</button></div>
      </div>`).join("")}</div>` : "");

  wire();
}

function rowHtml(r, i) {
  const c = r.card;
  const skip = r.verdict === "SKIP";
  const reasons = r.reasons.filter((x) => x.kind !== "verdict");

  return `<tr class="${skip ? "skip" : ""}">
    <td><input type="checkbox" data-short="${i}"${r.shortlisted ? " checked" : ""} title="Shortlist for the work queue"></td>
    <td><span class="verdict ${skip ? "v-skip" : "v-review"}">${esc(r.verdict)}</span>
      <div class="sub">${r.score}</div></td>
    <td>
      <a class="lbl" data-card="${esc(c.cardId)}">${esc(c.title || "(no title read)")}</a>
      <div class="sub">${esc(c.company || "(no company read)")}${c.location ? " &middot; " + esc(c.location) : ""}${c.arrangement ? " &middot; " + esc(c.arrangement) : ""}${c.jobType ? " &middot; " + esc(c.jobType) : ""}</div>
      <div class="sub">${c.pay ? esc(c.pay) + " &middot; " : ""}${c.applicants != null ? c.applicants + " applicants &middot; " : ""}${c.posted ? esc(c.posted.raw) + (c.posted.reposted ? " (reposted)" : "") : ""}${c.earlyApplicant ? " &middot; early applicant" : ""}</div>
      ${c.tags.length ? `<div class="sub">tags: ${c.tags.map(esc).join(", ")}</div>` : ""}
      ${c.applyButtons.length ? `<div class="sub">apply affordance present: ${c.applyButtons.map(esc).join(", ")}. Never clicked.</div>` : ""}
      <ul class="reasons">${reasons.map((x) => `<li class="r-${esc(x.kind)}">${esc(x.text)}</li>`).join("")}</ul>
      ${r.referralLead ? `<div class="referral">Referral lead: ${esc(r.referralLead.text)}</div>` : ""}
      <div class="row">
        ${c.listingUrl ? `<a class="sub" href="${esc(c.listingUrl)}" target="_blank" rel="noreferrer">listing</a>` : `<span class="blank">no listing URL read</span>`}
        <button class="small ghost" data-copy-text="${esc(c.rawText)}">Raw text</button>
      </div>
    </td>
    <td class="sub">${c.startTerm ? esc(c.startTerm.label) : "<span class='blank'>unknown</span>"}</td>
    <td class="sub">${c.matchPercent != null ? c.matchPercent + "%" : ""}${c.matchLabel ? `<div>${esc(c.matchLabel)}</div>` : ""}</td>
    <td>${c.listingUrl ? `<button class="small ghost" data-dismiss="${i}" title="Dismiss, persisted by listing URL">x</button>` : ""}</td>
  </tr>`;
}

function wire() {
  const container = $("tri-out");
  wireCopyText(container);

  for (const box of container.querySelectorAll("[data-short]")) {
    box.onchange = async () => {
      const r = state.result.rows[Number(box.dataset.short)];
      if (!r.card.listingUrl) {
        $("tri-status").textContent = "That card has no listing URL, so there is nothing stable to key a shortlist entry to.";
        box.checked = false;
        return;
      }
      state.store = await setShortlisted(r.card.listingUrl, {
        title: r.card.title, company: r.card.company, listingUrl: r.card.listingUrl,
        verdict: r.verdict, referralLead: r.referralLead, destinationUrl: null
      }, box.checked);
      state.result = triageAll(state.scan.cards, state.store);
    };
  }

  for (const btn of container.querySelectorAll("[data-dismiss]")) {
    btn.onclick = async () => {
      const r = state.result.rows[Number(btn.dataset.dismiss)];
      state.store = await dismissCard(r.card.listingUrl, r.verdict === "SKIP" ? r.reasons.find((x) => x.kind === "skip")?.code || "" : "manual");
      state.result = triageAll(state.scan.cards, state.store);
      render();
    };
  }

  for (const btn of container.querySelectorAll("[data-restore]")) {
    btn.onclick = async () => {
      state.store = await restoreCard(btn.dataset.restore);
      state.result = triageAll(state.scan.cards, state.store);
      render();
    };
  }

  for (const a of container.querySelectorAll("a.lbl[data-card]")) {
    a.onclick = (ev) => { ev.preventDefault(); call("focusCard", a.dataset.card); };
  }
}
