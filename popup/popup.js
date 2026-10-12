// popup/popup.js -- the orchestrator. The engine runs here, in a module
// context, so engine/ stays free of DOM and chrome.* and can be tested in node.
//
// Nothing touches the page until you open this popup, which only happens
// because you clicked the toolbar button. That click is also what grants
// activeTab, so the extension has no standing access to any site.

import { getProfile, getLearned, getPrefs, setPrefs, learnAnswer, bumpUse, forgetAnswer } from "../shared/store.js";
import { parsePosting } from "../engine/posting.js";
import { checkEligibility } from "../engine/eligibility.js";
import { assemble } from "../engine/assembler.js";
import { matchFields } from "../engine/matcher.js";
import { normLabel, derivePattern } from "../engine/normalize.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  tabId: null,
  profile: null,
  learned: {},
  prefs: {},
  scan: null,
  posting: null,
  eligibility: null,
  assembled: null,
  matched: null,
  roleOverride: null,
  overrideBlocked: false
};

// ------------------------------------------------------------------ plumbing

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

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

async function run({ jdOverride = null, rescanDom = true } = {}) {
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
    renderWorkday(scan);
    return;
  }

  const jdText = jdOverride != null ? jdOverride : scan.postingText;
  state.posting = parsePosting({ text: jdText, title: scan.title, host: scan.host });
  state.eligibility = checkEligibility(state.profile, state.posting);

  const blocked = state.eligibility.blocked && !state.overrideBlocked;

  state.assembled = blocked
    ? null
    : assemble(state.profile, state.posting, {
        roleTypeOverride: state.roleOverride,
        skillLimit: 10
      });

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

  if (!blocked) {
    await inject(["content/fill.js"]);
    await call("applyPlan", {
      plan: state.matched.plan.map((p) => ({
        targetJafId: p.targetJafId, kind: p.kind, value: p.value, tier: p.tier, ruleId: p.ruleId
      })),
      unknownIds: state.matched.unknowns.map((u) => u.field.jafId),
      manualIds: state.matched.manual.map((m) => m.field.jafId),
      uploadIds: scan.uploads.map((u) => u.jafId)
    });
    if (state.matched.learnedUsed.length) await bumpUse(state.matched.learnedUsed);
  } else {
    await inject(["content/fill.js"]);
    await call("applyPlan", { plan: [], unknownIds: [], manualIds: [], uploadIds: scan.uploads.map((u) => u.jafId) });
  }

  render(blocked);
}

// ------------------------------------------------------------------- render

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function show(id, on) { $(id).hidden = !on; }

function render(blocked) {
  const m = state.matched;
  const scan = state.scan;

  setStatus(
    blocked
      ? "Hard blocker found. Nothing was filled and nothing was assembled."
      : `${scan.fields.length} fields found. ${m.confident.length} filled, ${m.review.length} to verify, ${m.unknowns.length} unknown.`,
    blocked ? "red" : null
  );

  renderEligibility(blocked);
  renderUploads();
  renderRole();
  renderUnknown();
  renderManual();
  renderEeo();
  renderConflicts();
  renderList("review", m.review, "blue");
  renderList("filled", m.confident, "green");
  renderAssembled(blocked);
  wireFieldLinks();
}

function renderEligibility(blocked) {
  const e = state.eligibility;
  show("sec-eligibility", true);
  const out = [];

  if (e.insufficientText) {
    out.push(`<div class="banner blue">${esc(e.note)}</div>`);
  }
  if (e.blockers.length) {
    out.push(`<div class="banner red"><strong>${e.blockers.length} hard blocker${e.blockers.length > 1 ? "s" : ""}.</strong> ${blocked ? "Assembly skipped." : "You chose to continue anyway."}</div>`);
  }
  for (const b of e.blockers) {
    out.push(`<div class="card red">
      <div class="lbl-static"><strong>${esc(b.filter)}</strong>${b.confidence === "low" ? ' <span class="tagline">(low confidence, read it yourself)</span>' : ""}</div>
      <blockquote>${esc(b.sentence)}</blockquote>
      <div class="why">${esc(b.why)}</div>
    </div>`);
  }
  for (const f of e.flags) {
    out.push(`<div class="card amber">
      <div class="lbl-static"><strong>${esc(f.filter)}</strong></div>
      <blockquote>${esc(f.sentence)}</blockquote>
      <div class="why">${esc(f.argue)}</div>
    </div>`);
  }
  if (e.cleared.length) {
    out.push(`<p class="note">Checked and cleared: ${e.cleared.map((c) => esc(c.id)).join(", ")}.</p>`);
  }
  if (!e.blockers.length && !e.flags.length && !e.insufficientText) {
    out.push(`<div class="banner blue">No blockers or flags found. ${esc(e.alwaysViable)}</div>`);
  }
  if (e.blockers.length && !state.overrideBlocked) {
    out.push(`<div class="row"><button id="override">Assemble anyway</button></div>`);
  }
  $("eligibility").innerHTML = out.join("");
  const btn = $("override");
  if (btn) btn.onclick = () => { state.overrideBlocked = true; run({ jdOverride: $("jd").value, rescanDom: false }); };
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

function renderRole() {
  show("sec-role", true);
  const p = state.posting;
  const a = state.assembled;
  const roles = p.roles.all;
  const current = state.roleOverride || (a && a.roleType) || "";

  const opts = ['<option value="">Infer from the posting</option>']
    .concat(roles.map((r) => `<option value="${esc(r.role)}"${r.role === state.roleOverride ? " selected" : ""}>${esc(r.role)} (${r.score})</option>`))
    .join("");

  const hits = roles[0] && roles[0].hits.length
    ? roles[0].hits.map((h) => esc(h.pattern) + (h.inTitle ? " [title]" : "")).join(", ")
    : "nothing matched";

  $("role").innerHTML = `
    <div class="card ${a && a.roleType ? "blue" : "amber"}">
      <div><strong>${esc(current || "Role type not inferred")}</strong></div>
      <div class="meta">${esc(p.roles.reason)}</div>
      <div class="meta">Top matches: ${hits}</div>
      ${p.term ? `<div class="meta">Term reads as: ${esc(p.term)}</div>` : ""}
      ${p.payRange ? `<div class="meta">Pay range found: ${esc(p.payRange.raw)}</div>` : ""}
      ${a && a.tagList ? `<div class="meta">Tags in use: ${a.tagList.map((t) => esc(t.tag) + " " + t.weight).join(", ")}</div>` : ""}
    </div>
    <label class="inline" for="role-select">Override the role type</label>
    <select id="role-select">${opts}</select>`;

  $("jd").value = p.text;
  $("role-select").onchange = (ev) => {
    state.roleOverride = ev.target.value || null;
    run({ jdOverride: $("jd").value, rescanDom: false });
  };
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
      await run({ jdOverride: $("jd").value, rescanDom: false });
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
      await run({ jdOverride: $("jd").value, rescanDom: false });
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

function renderAssembled(blocked) {
  const a = state.assembled;
  show("sec-assembled", Boolean(a) && !blocked);
  if (!a || blocked) return;

  const out = [];

  if (a.needsRoleType) {
    out.push(`<div class="banner amber">${esc(a.reason)}</div>`);
    $("assembled").innerHTML = out.join("");
    return;
  }
  if (a.violations && a.violations.length) {
    out.push(`<div class="banner red"><strong>Output refused by the verifier.</strong> Nothing was filled from the assembler.<ul>${
      a.violations.map((v) => `<li>${esc(v.reason)}<br><code>${esc(v.text)}</code></li>`).join("")
    }</ul></div>`);
  }
  for (const n of a.notices) {
    out.push(`<div class="banner ${n.level === "warn" ? "amber" : "blue"}">${esc(n.text)}</div>`);
  }

  for (const e of a.entries) {
    const head = e.kind === "experience"
      ? `${e.header.employer}, ${e.header.title} (${e.header.focus})`
      : `${e.header.name}, ${e.header.subtitle}`;
    out.push(`<div class="card ${e.isLead ? "green" : ""}">
      <div><strong>${esc(head)}</strong>${e.isLead ? ' <span class="tagline">lead</span>' : ""}</div>
      <ul>${e.bullets.map((b) => `<li>${esc(b.text)}${b.merged ? ' <span class="tagline">(approved merge)</span>' : ""}<br><span class="tagline">${esc(b.ids.join(" + "))}${b.jdHits && b.jdHits.length ? " &middot; posting terms: " + b.jdHits.map(esc).join(", ") : ""}</span></li>`).join("")}</ul>
      ${e.kind === "project" && e.header.my_scope ? `<div class="why">Scope on record: ${esc(e.header.my_scope)}</div>` : ""}
    </div>`);
  }

  out.push(`<div class="card">
    <div><strong>Skills, in order</strong></div>
    <div class="val">${esc(a.skills.map((s) => s.skill).join(", "))}</div>
    ${a.skillsHeld && a.skillsHeld.length ? `<div class="why">Held back past the default 10: ${a.skillsHeld.map((s) => esc(s.skill)).join(", ")}</div>` : ""}
  </div>`);

  if (a.gaps.length) {
    out.push(`<div class="card amber">
      <div><strong>Asked for, not claimed</strong></div>
      <div class="val">${a.gaps.map(esc).join(", ")}</div>
      <div class="why">Omitted rather than stretched. If any of these is actually true, add it to the profile yourself.</div>
    </div>`);
  }

  if (a.mergeCandidates.length) {
    out.push(`<div class="card">
      <div><strong>Merge candidates</strong></div>
      <div class="why">Not merged. Add a pair to <code>assembly_rules.merge_pairs</code> if both read true as written and the join asserts nothing new.</div>
      ${a.mergeCandidates.map((c) => `<div style="margin-top:6px">
        <div class="val">${esc(c.preview)}</div>
        <div class="meta">shares: ${c.sharedTags.map(esc).join(", ")}</div>
        <div class="row"><code>${esc(c.snippet)}</code><button class="small" data-copy="${esc(c.snippet)}">Copy</button></div>
      </div>`).join("")}
    </div>`);
  }

  $("assembled").innerHTML = out.join("");
  for (const btn of $("assembled").querySelectorAll("[data-copy]")) {
    btn.onclick = () => navigator.clipboard.writeText(btn.dataset.copy);
  }
}

function renderWorkday(scan) {
  setStatus("Workday detected. Not supported in v1.", "red");
  show("sec-eligibility", false);
  show("sec-role", false);
  show("sec-uploads", false);
  show("sec-unknown", false);
  show("sec-manual", false);
  show("sec-eeo", false);
  show("sec-review", false);
  show("sec-filled", false);
  show("sec-assembled", true);
  $("assembled").innerHTML = `<div class="banner red">
    <strong>Workday.</strong> Its dropdowns are custom React components, not real selects, so filling them needs click simulation. Half-filling a Workday form is worse than not touching it, so nothing was changed on this page.
  </div>`;
}

function wireFieldLinks() {
  for (const a of document.querySelectorAll("a.lbl[data-jaf]")) {
    a.onclick = (ev) => { ev.preventDefault(); call("focusField", a.dataset.jaf); };
  }
}

// --------------------------------------------------------------------- boot

(async function boot() {
  const tab = await activeTab();
  state.tabId = tab.id;

  state.profile = await getProfile();
  if (!state.profile) {
    const res = await fetch(chrome.runtime.getURL("data/profile.json"));
    state.profile = await res.json();
  }
  state.learned = await getLearned();
  state.prefs = await getPrefs();
  $("generic-org").checked = Boolean(state.prefs.useGenericOrgName);

  if (!/^https?:/.test(tab.url || "")) {
    setStatus("This page is not a website the extension can read.", "red");
    return;
  }

  $("rescan").onclick = () => run({ jdOverride: $("jd").value, rescanDom: true });
  $("generic-org").onchange = async (ev) => {
    state.prefs = { ...state.prefs, useGenericOrgName: ev.target.checked };
    await setPrefs(state.prefs);
    run({ jdOverride: $("jd").value, rescanDom: false });
  };

  try {
    await run({});
  } catch (err) {
    setStatus(`Scan failed: ${err && err.message ? err.message : err}`, "red");
  }
})();
