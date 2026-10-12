// popup/tab-triage.js -- Jobright stage 1: board triage.
//
// Reads the board's cards as structured data, runs engine/triage.js over them,
// and ranks. Stage 1 has no job description text, so the best verdict available
// is REVIEW. Nothing here clicks anything on the page except a scroll-into-view.

import { getTriage, dismissCard, restoreCard, setShortlisted, setHarvestStop, getHarvestProgress, getPrefs, setPrefs } from "../shared/store.js";
import { toPlain, HARVEST } from "../rules/jobright-rules.js";
import { triageAll } from "../engine/triage.js";
import { boardReport } from "../engine/assess.js";
import { $, esc, show, wireCopyText, flash } from "./ui.js";

const state = { tabId: null, scan: null, store: null, result: null, report: null, prefs: {}, showDismissed: false };

export function initTriageTab({ tabId }) {
  state.tabId = tabId;
  $("tri-scan").onclick = () => runTriage();
  $("tri-show-dismissed").onchange = (ev) => { state.showDismissed = ev.target.checked; render(); };
  $("tri-harvest-run").onclick = () => startHarvest();
  $("tri-harvest-stop").onclick = async () => {
    await setHarvestStop(true);
    $("tri-harvest-status").textContent = "Stop requested. The loop finishes the card it is on, keeps everything already read, and ends.";
  };
  $("tri-auto-queue").onchange = async (ev) => {
    state.prefs = { ...state.prefs, autoQueue: ev.target.checked };
    await setPrefs(state.prefs);
    await syncAutoQueue();
    render();
  };
  $("tri-queue-apply").onclick = async () => { await syncAutoQueue(true); render(); };
  pollProgress();
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
  state.prefs = await getPrefs();
  $("tri-auto-queue").checked = state.prefs.autoQueue !== false;
  state.result = triageAll(scan.cards, state.store);
  show("tri-harvest", scan.cards.length > 0);
  await syncAutoQueue();
  render();
}

/**
 * Auto-queue adds APPLY rows and nothing else. A REVIEW row means not yet
 * assessed, so it can never be queued, and nothing is queued at all while a
 * critical alarm stands.
 */
async function syncAutoQueue(force = false) {
  if (!state.result) return;
  state.report = buildReport();
  if (!force && state.prefs.autoQueue === false) return;
  if (!state.report.safeToQueue) return;

  for (const a of state.report.assessed) {
    if (!a.queueEligible) continue;
    const url = a.row.card.listingUrl;
    if (!url || state.store.shortlist[url]) continue;
    state.store = await setShortlisted(url, {
      title: a.row.card.title, company: a.row.card.company, listingUrl: url,
      verdict: a.verdict, referralLead: a.row.referralLead,
      destinationUrl: a.state.destinationUrl
    }, true);
  }
  state.result = triageAll(state.scan.cards, state.store);
  state.report = buildReport();
}

function buildReport() {
  return boardReport({
    rows: state.result.rows,
    harvestedByUrl: state.store.harvested || {},
    run: state.store.run,
    boardUrl: state.scan ? state.scan.url : null
  });
}

// -------------------------------------------------------------- stage 2

async function startHarvest() {
  if (!state.result) return;

  const rows = $("tri-harvest-shortlist").checked
    ? state.result.rows.filter((r) => r.shortlisted)
    : state.result.rows.filter((r) => r.verdict === "REVIEW");

  if (!rows.length) {
    $("tri-harvest-status").textContent = $("tri-harvest-shortlist").checked
      ? "Nothing is shortlisted yet."
      : "No cards came out as REVIEW, so there is nothing worth harvesting.";
    return;
  }

  const urlByCardId = {};
  for (const r of rows) urlByCardId[r.card.cardId] = r.card.listingUrl;

  await setHarvestStop(false);
  await inject(["content/jobright-harvest.js"]);

  $("tri-harvest-run").hidden = true;
  $("tri-harvest-stop").hidden = false;
  $("tri-harvest-status").textContent =
    `Starting on ${Math.min(rows.length, HARVEST.maxCards)} card${rows.length === 1 ? "" : "s"}` +
    `${rows.length > HARVEST.maxCards ? ` (capped from ${rows.length})` : ""}. ` +
    `Roughly ${Math.ceil(rows.length * (HARVEST.gapMinMs + HARVEST.gapMaxMs) / 2 / 60000)} to ${Math.ceil(rows.length * (HARVEST.gapMaxMs + HARVEST.renderTimeoutMs) / 60000)} minutes. You can close this popup.`;

  // Fire and forget: the loop lives in the page, so the popup closing is fine.
  call("harvest", { rules: toPlain(), cardIds: rows.map((r) => r.card.cardId), urlByCardId })
    .catch((err) => { $("tri-harvest-status").textContent = `Harvest could not start: ${err && err.message ? err.message : err}`; });

  $("tri-auto-queue").onchange = async (ev) => {
    state.prefs = { ...state.prefs, autoQueue: ev.target.checked };
    await setPrefs(state.prefs);
    await syncAutoQueue();
    render();
  };
  $("tri-queue-apply").onclick = async () => { await syncAutoQueue(true); render(); };
  pollProgress();
}

async function pollProgress() {
  const p = await getHarvestProgress();
  if (!p) return;
  const running = !p.finishedAt;
  $("tri-harvest-run").hidden = running;
  $("tri-harvest-stop").hidden = !running;

  const bits = [`${p.done} harvested`, `${p.failed} failed`, `of ${p.total}`];
  if (p.current && running) bits.push(`on ${p.current}`);
  if (p.stoppedEarly) bits.push(`ended early: ${p.stopReason}`);
  if (p.refusals && p.refusals.length) bits.push(`${p.refusals.length} click${p.refusals.length === 1 ? "" : "s"} refused by policy`);
  $("tri-harvest-status").textContent = bits.join(", ") + ".";

  if (running) setTimeout(pollProgress, 2000);
  else if (state.result) {
    // The run is over: re-read what it stored, re-assess, then auto-queue.
    state.store = await getTriage();
    state.result = triageAll(state.scan.cards, state.store);
    await syncAutoQueue();
    render();
  }
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

  if (!state.report) state.report = buildReport();
  const report = state.report;
  const assessedByUrl = new Map(report.assessed.map((a) => [a.row.card.listingUrl, a]));

  const body = rows.map((r, i) => rowHtml(r, i, assessedByUrl.get(r.card.listingUrl))).join("");
  const dismissedUrls = Object.keys(state.store.dismissed);

  $("tri-out").innerHTML = notes.join("") + harvestReportHtml(report) + (rows.length ? `
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

/** The three steps that can fail, per card, as a traffic light. */
function stepsHtml(a) {
  if (!a) return "";
  const st = a.state;
  const dot = (ok, label, title) =>
    `<span class="step ${ok === null ? "s-none" : ok ? "s-ok" : "s-bad"}" title="${esc(title)}">${ok === null ? "\u2013" : ok ? "\u2713" : "\u2717"} ${esc(label)}</span>`;

  if (!st.attempted) return `<div class="steps"><span class="step s-none" title="The detail panel has never been read for this card.">not harvested</span></div>`;

  return `<div class="steps">
    ${dot(st.panelOpened, "panel", st.panelOpened ? "The detail panel opened and rendered." : `Panel did not open: ${st.failureReason}`)}
    ${dot(st.requiredFound, "required", st.requiredFound ? `${st.requiredCount} requirement lines found via the ${st.requiredFrom}.` : "No Required list was found in the panel, so eligibility tested nothing.")}
    ${dot(st.originalPostFound, "orig link", st.originalPostFound ? "An Original Job Post link was found." : "No Original Job Post link was found in the panel.")}
    ${dot(Boolean(st.destinationUrl), "destination", st.destinationUrl ? st.destinationUrl : "No href off jobright.ai. A jobright.ai URL is not a destination.")}
  </div>`;
}

function harvestReportHtml(report) {
  const c = report.counts;
  const alarms = report.alarms.map((a) => `<div class="banner ${a.severity === "critical" ? "red" : "amber"}"><strong>${a.severity === "critical" ? "Harvest is broken." : "Check this."}</strong> ${esc(a.text)}</div>`).join("");

  if (!report.ran && c.attempted === 0) {
    return alarms + `<div class="banner amber"><strong>Harvest has not run on this board.</strong> Every row below is stage 1 only: the card's own fields, no requirement text and no destination. Nothing can be queued from that.</div>`;
  }

  return alarms + `<div class="card ${report.safeToQueue ? "" : "red"}">
    <div><strong>Harvest state for this board</strong></div>
    <div class="meta">${report.ran ? `ran ${esc(report.startedAt || "")}${report.finishedAt ? `, finished ${esc(report.finishedAt)}` : ", still running"}` : "no run recorded in this session"}${report.stoppedEarly ? ` &middot; ended early: ${esc(report.stopReason || "")}` : ""}</div>
    <table class="steps-table">
      <tr><td>cards on board</td><td>${c.cardsOnBoard}</td><td></td></tr>
      <tr><td>harvest attempted</td><td>${c.attempted}</td><td class="sub">${c.panelFailed} failed</td></tr>
      <tr class="${c.panelOpened ? "" : "bad"}"><td>detail panel opened</td><td>${c.panelOpened}</td><td class="sub">of ${c.attempted}</td></tr>
      <tr class="${c.requiredFound ? "" : "bad"}"><td>Required text found</td><td>${c.requiredFound}</td><td class="sub">of ${c.panelOpened}${c.requiredFromFallback ? `, ${c.requiredFromFallback} via the Qualification block` : ""}</td></tr>
      <tr class="${c.originalPostFound ? "" : "bad"}"><td>Original Job Post link found</td><td>${c.originalPostFound}</td><td class="sub">of ${c.panelOpened}</td></tr>
      <tr class="${c.destinationResolved ? "" : "bad"}"><td>destination off jobright.ai</td><td>${c.destinationResolved}</td><td class="sub">of ${c.originalPostFound}</td></tr>
      <tr><td>blocked on real requirements</td><td>${c.blocked}</td><td></td></tr>
      <tr><td><strong>queue eligible</strong></td><td><strong>${c.queueEligible}</strong></td><td class="sub">APPLY ${c.apply} &middot; REVIEW ${c.review} &middot; SKIP ${c.skip}</td></tr>
    </table>
    <div class="why">REVIEW means not yet assessed. Only APPLY rows can be queued.</div>
  </div>`;
}

function rowHtml(r, i, a) {
  const c = r.card;
  const verdict = a ? a.verdict : r.verdict;
  const skip = verdict === "SKIP";
  const reasons = r.reasons.filter((x) => x.kind !== "verdict");
  const cls = verdict === "APPLY" ? "v-apply" : verdict === "SKIP" ? "v-skip" : "v-review";

  return `<tr class="${skip ? "skip" : ""}">
    <td><input type="checkbox" data-short="${i}"${r.shortlisted ? " checked" : ""}${a && !a.queueEligible ? " disabled" : ""} title="${a && !a.queueEligible ? "Cannot be queued: " + esc(a.reasons[0].text) : "Shortlist for the work queue"}"></td>
    <td><span class="verdict ${cls}">${esc(verdict)}</span>
      <div class="sub">${r.score}</div></td>
    <td>
      <a class="lbl" data-card="${esc(c.cardId)}">${esc(c.title || "(no title read)")}</a>
      <div class="sub">${esc(c.company || "(no company read)")}${c.location ? " &middot; " + esc(c.location) : ""}${c.arrangement ? " &middot; " + esc(c.arrangement) : ""}${c.jobType ? " &middot; " + esc(c.jobType) : ""}</div>
      <div class="sub">${c.pay ? esc(c.pay) + " &middot; " : ""}${c.applicants != null ? c.applicants + " applicants &middot; " : ""}${c.posted ? esc(c.posted.raw) + (c.posted.reposted ? " (reposted)" : "") : ""}${c.earlyApplicant ? " &middot; early applicant" : ""}</div>
      ${c.tags.length ? `<div class="sub">tags: ${c.tags.map(esc).join(", ")}</div>` : ""}
      ${c.applyButtons.length ? `<div class="sub">apply affordance present: ${c.applyButtons.map(esc).join(", ")}. Never clicked.</div>` : ""}
      ${stepsHtml(a)}
      ${a && a.verdict !== "APPLY" ? `<div class="why">${esc(a.reasons[0].text)}</div>` : ""}
      <ul class="reasons">${reasons.map((x) => `<li class="r-${esc(x.kind)}">${esc(x.text)}</li>`).join("")}</ul>
      ${r.referralLead ? `<div class="referral">Referral lead: ${esc(r.referralLead.text)}</div>` : ""}
      ${harvestedHtml(state.store.harvested[c.listingUrl])}
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

function harvestedHtml(h) {
  if (!h) return "";
  if (h.harvestStatus !== "ok") {
    return `<div class="harvested bad">Harvest failed: ${esc(h.why || "unknown")}</div>`;
  }
  const r = h.record;
  const e = h.eligibility;
  const sub = r.match.subscores;
  return `<div class="harvested">
    <div><strong>Harvested.</strong> ${r.match.overall != null ? r.match.overall + "% overall" : "no overall match read"}
      &middot; experience ${fmt(sub.experienceLevel)} &middot; skill ${fmt(sub.skill)} &middot; education ${fmt(sub.educationMatch)}</div>
    ${e.blocked
      ? `<div class="h-blocked"><strong>BLOCKED on the real requirements.</strong>${e.blockers.map((b) => `<div>${esc(b.filter)}<blockquote>${esc(b.sentence)}</blockquote><em>${esc(b.why)}</em></div>`).join("")}</div>`
      : e.flags.length
        ? `<div class="h-flags">${e.flags.map((f) => `<div>${esc(f.filter)}<blockquote>${esc(f.sentence)}</blockquote><em>${esc(f.argue)}</em></div>`).join("")}</div>`
        : `<div class="h-clear">No blockers in the Required or Preferred text.</div>`}
    ${r.insider.leads.length ? `<div class="referral">${r.insider.leads.map((l) => esc(l.text) + " " + l.people.map((p) => esc(p.name) + (p.affiliation ? ` (${esc(p.affiliation)})` : "")).join(", ")).join(" / ")}</div>` : ""}
    <div class="sub">required ${r.required.length} &middot; preferred ${r.preferred.length} &middot; responsibilities ${r.responsibilities.length} &middot; benefits ${r.benefits.length}</div>
    ${r.benefits.some((b) => /relocat|housing/i.test(b)) ? `<div class="sub">relocation or housing: ${r.benefits.filter((b) => /relocat|housing/i.test(b)).map(esc).join("; ")}</div>` : ""}
    ${r.qualificationTags.length ? `<div class="sub">tags you hold (low confidence): ${r.qualificationTags.filter((t) => t.marked).map((t) => esc(t.text)).join(", ") || "none detected"}</div>` : ""}
    <div class="sub">destination: ${r.destinationUrl ? `<a href="${esc(r.destinationUrl)}" target="_blank" rel="noreferrer">${esc(r.destinationUrl.slice(0, 60))}</a>` : "none"}${r.resolvesOnOpen ? ` <span class="blank">resolves on open</span>` : ""}</div>
    ${r.missing.length ? `<div class="blank">could not read: ${r.missing.map(esc).join(", ")}</div>` : ""}
  </div>`;
}

const fmt = (v) => (v == null ? "not read" : typeof v === "number" ? v + "%" : String(v));

function wire() {
  const container = $("tri-out");
  wireCopyText(container);

  for (const box of container.querySelectorAll("[data-short]")) {
    box.onchange = async () => {
      const r = state.result.rows[Number(box.dataset.short)];
      const a = state.report.assessed.find((x) => x.row.card.listingUrl === r.card.listingUrl);
      if (box.checked && a && !a.queueEligible) {
        $("tri-status").textContent = `Not queueable: ${a.reasons[0].text}`;
        box.checked = false;
        return;
      }
      if (!r.card.listingUrl) {
        $("tri-status").textContent = "That card has no listing URL, so there is nothing stable to key a shortlist entry to.";
        box.checked = false;
        return;
      }
      state.store = await setShortlisted(r.card.listingUrl, {
        title: r.card.title, company: r.card.company, listingUrl: r.card.listingUrl,
        verdict: a ? a.verdict : r.verdict, referralLead: r.referralLead,
        destinationUrl: a ? a.state.destinationUrl : null
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
