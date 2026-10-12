// popup/tab-page.js -- the page tab: scan the live form, match, fill, report.
//
// This is the only path that injects anything. engine/ runs here in the popup,
// in a module context, so engine/ stays free of DOM and chrome.* and can be
// tested in node.

import { getLearned, learnAnswer, forgetAnswer, setPrefs, bumpUse } from "../shared/store.js";
import { parsePosting } from "../engine/posting.js";
import { checkEligibility } from "../engine/eligibility.js";
import { assemble } from "../engine/assembler.js";
import { matchFields } from "../engine/matcher.js";
import { normLabel, derivePattern } from "../engine/normalize.js";
import { $, esc, show, setStatus, eligibilityHtml, roleHtml, assembledHtml, wireCopyText } from "./ui.js";

const state = {
  tabId: null, profile: null, learned: {}, prefs: {},
  scan: null, posting: null, eligibility: null, assembled: null, matched: null,
  roleOverride: null, overrideBlocked: false
};

export function initPageTab({ profile, learned, prefs, tabId }) {
  state.profile = profile;
  state.learned = learned;
  state.prefs = prefs;
  state.tabId = tabId;

  $("generic-org").checked = Boolean(prefs.useGenericOrgName);
  $("rescan").onclick = () => runPage({ jdOverride: $("jd").value, rescanDom: true });
  $("generic-org").onchange = async (ev) => {
    state.prefs = { ...state.prefs, useGenericOrgName: ev.target.checked };
    await setPrefs(state.prefs);
    runPage({ jdOverride: $("jd").value, rescanDom: false });
  };
}

// ------------------------------------------------------------------ plumbing

async function inject(files) {
  await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files });
}

async function call(fnName, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    args: [fnName, arg === undefined ? null : arg],
    func: (name, payload) => {
      const api = globalThis.JAF;
      if (!api || typeof api[name] !== "function") return { __error: "content script not loaded" };
      return api[name](payload);
    }
  });
  return res ? res.result : null;
}

// ------------------------------------------------------------------ pipeline

export async function runPage({ jdOverride = null, rescanDom = true } = {}) {
  if (rescanDom) {
    await inject(["content/label.js", "content/scan.js"]);
    const scan = await call("scan");
    if (!scan || scan.__error) {
      setStatus(`Could not read the page. ${scan && scan.__error ? scan.__error : ""}`, "red");
      return;
    }
    state.scan = scan;
    // Labels are normalized here rather than in the content script so the
    // normalization rules live in one place that node can test.
    for (const f of [...scan.fields, ...scan.uploads]) f.labelNorm = normLabel(f.labelRaw);
    $("ats").textContent = scan.ats;
  }
  const scan = state.scan;
  if (!scan) return;

  if (scan.ats === "workday") {
    renderWorkday();
    return;
  }

  const jdText = jdOverride != null ? jdOverride : scan.postingText;
  state.posting = parsePosting({ text: jdText, title: scan.title, host: scan.host });
  state.eligibility = checkEligibility(state.profile, state.posting);

  const blocked = state.eligibility.blocked && !state.overrideBlocked;

  state.assembled = blocked
    ? null
    : assemble(state.profile, state.posting, { roleTypeOverride: state.roleOverride, skillLimit: 10 });

  if (state.assembled && !state.assembled.ok) {
    // The verifier refused the output. Nothing gets filled from the assembler.
    state.assembled = { ...state.assembled, entries: [], skills: [] };
  }

  state.matched = matchFields(scan.fields, {
    profile: state.profile,
    posting: state.posting,
    assembled: blocked ? null : state.assembled,
    learned: state.learned,
    prefs: state.prefs,
    host: scan.host
  });

  await inject(["content/fill.js"]);
  await call("applyPlan", {
    plan: blocked ? [] : state.matched.plan.map((p) => ({
      targetJafId: p.targetJafId, kind: p.kind, value: p.value, tier: p.tier, ruleId: p.ruleId
    })),
    unknownIds: blocked ? [] : state.matched.unknowns.map((u) => u.field.jafId),
    manualIds: blocked ? [] : state.matched.manual.map((m) => m.field.jafId),
    uploadIds: scan.uploads.map((u) => u.jafId)
  });
  if (!blocked && state.matched.learnedUsed.length) await bumpUse(state.matched.learnedUsed);

  render(blocked);
}

// -------------------------------------------------------------------- render

function render(blocked) {
  const m = state.matched;
  const scan = state.scan;

  setStatus(
    blocked
      ? "Hard blocker found. Nothing was filled and nothing was assembled."
      : `${scan.fields.length} fields found. ${m.confident.length} filled, ${m.review.length} to verify, ${m.unknowns.length} unknown.`,
    blocked ? "red" : null
  );

  show("sec-eligibility", true);
  $("eligibility").innerHTML = eligibilityHtml(state.eligibility, state.profile, {
    blocked, showOverride: !state.overrideBlocked, overrideId: "override"
  });
  const ov = $("override");
  if (ov) ov.onclick = () => { state.overrideBlocked = true; runPage({ jdOverride: $("jd").value, rescanDom: false }); };

  renderUploads();

  show("sec-role", true);
  $("role").innerHTML = roleHtml(state.posting, blocked ? null : state.assembled, {
    override: state.roleOverride, selectId: "role-select"
  });
  $("jd").value = state.posting.text;
  $("role-select").onchange = (ev) => {
    state.roleOverride = ev.target.value || null;
    runPage({ jdOverride: $("jd").value, rescanDom: false });
  };

  renderUnknown();
  renderManual();
  renderEeo();
  renderConflicts();
  renderList("review", m.review, "blue");
  renderList("filled", m.confident, "green");

  show("sec-assembled", Boolean(state.assembled) && !blocked);
  if (state.assembled && !blocked) {
    $("assembled").innerHTML = assembledHtml(state.assembled, { copySections: false });
    wireCopyText($("assembled"));
  }

  wireFieldLinks();
}

function renderUploads() {
  const ups = state.scan.uploads;
  show("sec-uploads", ups.length > 0);
  $("uploads-count").textContent = ups.length ? `(${ups.length})` : "";
  $("uploads").innerHTML = ups.map((u) => `
    <div class="card red">
      <a class="lbl" data-jaf="${esc(u.jafId)}">${esc(u.labelRaw || u.name || "File upload")}</a>
      <div class="meta">${u.required ? "Required. " : ""}${u.hasFile ? "A file is already attached." : "Empty."}${u.accept ? " Accepts " + esc(u.accept) + "." : ""}</div>
      <div class="why">Attach this yourself. JavaScript is not permitted to set a file input, so the extension cannot and will not.</div>
    </div>`).join("");
}

function renderUnknown() {
  const list = state.matched.unknowns;
  show("sec-unknown", list.length > 0);
  $("unknown-count").textContent = list.length ? `(${list.length})` : "";
  $("unknown").innerHTML = list.map((u, i) => {
    const f = u.field;
    const input = f.options && f.options.length
      ? `<select data-answer="${i}">${['<option value="">Pick an option</option>'].concat(f.options.map((o) => `<option value="${esc(o.value)}">${esc(o.textRaw || o.value)}</option>`)).join("")}</select>`
      : `<input type="text" data-answer="${i}" placeholder="Your answer">`;
    return `<div class="card amber">
      <a class="lbl" data-jaf="${esc(f.jafId)}">${esc(f.labelRaw || f.name || f.jafId)}</a>
      <div class="meta">${esc(f.tag)}${f.type && f.type !== f.tag ? "/" + esc(f.type) : ""}${f.required ? ", required" : ""}${f.maxLength ? ", max " + f.maxLength : ""} &middot; label from ${esc(f.labelSource)}</div>
      <div class="why">${esc(u.reason)}</div>
      ${u.note ? `<div class="why">${esc(u.note)}</div>` : ""}
      ${u.vetoed && u.vetoed.length ? `<div class="why">Options vetoed by a profile rule: ${u.vetoed.map(esc).join(", ")}</div>` : ""}
      <div class="row">${input}<button class="small" data-save="${i}">Save</button></div>
    </div>`;
  }).join("");

  for (const btn of $("unknown").querySelectorAll("[data-save]")) {
    btn.onclick = async () => {
      const i = Number(btn.dataset.save);
      const u = list[i];
      const input = $("unknown").querySelector(`[data-answer="${i}"]`);
      const answer = input.value.trim();
      if (!answer) return;
      const res = await learnAnswer({
        labelRaw: u.field.labelRaw,
        labelNorm: u.field.labelNorm,
        derivedPattern: derivePattern(u.field.labelNorm),
        answer,
        tag: u.field.tag,
        type: u.field.type,
        options: u.field.options && u.field.options.length ? u.field.options.map((o) => o.value) : null,
        host: state.scan.host
      });
      if (!res.ok) { setStatus(res.reason, "red"); return; }
      state.learned = await getLearned();
      await runPage({ jdOverride: $("jd").value, rescanDom: false });
    };
  }
}

function renderManual() {
  const list = state.matched.manual;
  show("sec-manual", list.length > 0);
  $("manual-count").textContent = list.length ? `(${list.length})` : "";
  $("manual").innerHTML = list.map((m) => `
    <div class="card amber">
      <a class="lbl" data-jaf="${esc(m.field.jafId)}">${esc(m.field.labelRaw || m.field.name || m.field.jafId)}</a>
      <div class="meta">rule: ${esc(m.ruleId)}${m.deliberatelyBlank ? " &middot; left blank on purpose" : ""}</div>
      <div class="why">${esc(m.note)}</div>
    </div>`).join("");
}

function renderEeo() {
  const list = state.matched.eeo;
  show("sec-eeo", list.length > 0);
  $("eeo-count").textContent = list.length ? `(${list.length})` : "";
  $("eeo-note").textContent = list.length ? state.profile.standard_answers.eeo_questions : "";
  $("eeo").innerHTML = list.map((e) => `
    <div class="card">
      <a class="lbl" data-jaf="${esc(e.field.jafId)}">${esc(e.field.labelRaw || e.field.name || e.field.jafId)}</a>
      <div class="why">Never auto-filled. ${e.decline ? `The decline option on this form is "${esc(e.decline.textRaw)}".` : "No decline-to-self-identify option found on this field."}</div>
    </div>`).join("");
}

function renderConflicts() {
  const list = state.matched.conflicts;
  show("sec-conflicts", list.length > 0);
  $("conflicts-count").textContent = list.length ? `(${list.length})` : "";
  $("conflicts").innerHTML = list.map((c, i) => `
    <div class="card amber">
      <a class="lbl" data-jaf="${esc(c.field.jafId)}">${esc(c.field.labelRaw || c.field.name)}</a>
      <div class="meta">Saved answer was used.</div>
      <div class="why">saved: <strong>${esc(c.learnedValue)}</strong><br>rule <code>${esc(c.ruleId)}</code> wanted: <strong>${esc(c.ruleValue)}</strong></div>
      <div class="row"><button class="small" data-forget="${i}">Forget the saved answer</button></div>
    </div>`).join("");

  for (const btn of $("conflicts").querySelectorAll("[data-forget]")) {
    btn.onclick = async () => {
      await forgetAnswer(list[Number(btn.dataset.forget)].learnedKey);
      state.learned = await getLearned();
      await runPage({ jdOverride: $("jd").value, rescanDom: false });
    };
  }
}

function renderList(id, items, colour) {
  show("sec-" + id, items.length > 0);
  $(id + "-count").textContent = items.length ? `(${items.length})` : "";
  $(id).innerHTML = items.map((p) => `
    <div class="card ${colour}">
      <a class="lbl" data-jaf="${esc(p.targetJafId)}">${esc(p.field.labelRaw || p.field.name || p.field.jafId)}</a>
      <div class="val">${esc(p.display.length > 400 ? p.display.slice(0, 400) + "..." : p.display)}</div>
      <div class="meta">rule: ${esc(p.ruleId)} &middot; via ${esc(p.source)}${p.truncated ? " &middot; truncated to fit" : ""}</div>
      ${p.note ? `<div class="why">${esc(p.note)}</div>` : ""}
      ${p.vetoed && p.vetoed.length ? `<div class="why">Vetoed options: ${p.vetoed.map(esc).join(", ")}</div>` : ""}
    </div>`).join("");
}

function renderWorkday() {
  setStatus("Workday detected. Not supported in v1.", "red");
  for (const id of ["sec-eligibility", "sec-role", "sec-uploads", "sec-unknown", "sec-manual", "sec-eeo", "sec-conflicts", "sec-review", "sec-filled"]) {
    show(id, false);
  }
  show("sec-assembled", true);
  $("assembled").innerHTML = `<div class="banner red">
    <strong>Workday.</strong> Its dropdowns are custom React components, not real selects, so filling them needs click simulation. Half-filling a Workday form is worse than not touching it, so nothing was changed on this page.
    Use the <strong>Paste a posting</strong> tab to get the assembled material and fill it in by hand.
  </div>`;
}

function wireFieldLinks() {
  for (const a of document.querySelectorAll("a.lbl[data-jaf]")) {
    a.onclick = (ev) => { ev.preventDefault(); call("focusField", a.dataset.jaf); };
  }
}
