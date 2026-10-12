// popup/tab-paste.js -- the standalone assembler.
//
// This path never touches the DOM of any page and never calls
// chrome.scripting. It reads the profile and the text you pasted, runs engine/,
// and renders. That is the whole dependency list, which is why it keeps working
// when anything to do with page scanning breaks.

import { buildReport, sectionText, SECTIONS, SECTION_TITLES, reportToText } from "../engine/report.js";
import { $, esc, eligibilityHtml, roleHtml, assembledHtml, wireCopyText, wireCopySections, flash } from "./ui.js";

const state = { profile: null, report: null, roleOverride: null, overrideBlocked: false };

export function initPasteTab(profile) {
  state.profile = profile;
  $("paste-run").onclick = () => runPaste();
  $("paste-clear").onclick = () => {
    $("paste-jd").value = "";
    $("paste-out").innerHTML = "";
    $("paste-actions").hidden = true;
    state.report = null;
  };
  $("paste-copy-all").onclick = async () => {
    if (!state.report) return;
    await navigator.clipboard.writeText(reportToText(state.report, state.profile));
    flash($("paste-copy-all"), "Copied all");
  };
  $("paste-jd").addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") runPaste();
  });
}

function runPaste() {
  const text = $("paste-jd").value;
  if (!text.trim()) {
    $("paste-out").innerHTML = `<div class="banner amber">Paste a job description first.</div>`;
    return;
  }
  state.report = buildReport(state.profile, text, {
    roleTypeOverride: state.roleOverride,
    skillLimit: Number($("paste-skills").value) || 10
  });
  render();
}

function render() {
  const { eligibility, posting, assembled } = state.report;
  const blocked = eligibility.blocked && !state.overrideBlocked;
  const out = [];

  out.push(`<h3 class="subhead">Eligibility<button class="small ghost" data-copy-section="eligibility">Copy</button></h3>`);
  out.push(eligibilityHtml(eligibility, state.profile, {
    blocked,
    showOverride: !state.overrideBlocked,
    overrideId: "paste-override"
  }));

  out.push(`<h3 class="subhead">Role type<button class="small ghost" data-copy-section="role">Copy</button></h3>`);
  out.push(roleHtml(posting, blocked ? null : assembled, {
    override: state.roleOverride,
    selectId: "paste-role-select"
  }));

  if (blocked) {
    out.push(`<div class="banner red">Nothing assembled. A hard blocker is in the way, and you asked to be told you are ineligible rather than handed a polished application. Use <strong>Assemble anyway</strong> above if you disagree with the read.</div>`);
  } else {
    out.push(assembledHtml(assembled, { copySections: true }));
  }

  const container = $("paste-out");
  container.innerHTML = out.join("");
  $("paste-actions").hidden = false;

  wireCopyText(container);
  wireCopySections(container, (which) => sectionText(state.report, state.profile, which));

  const sel = $("paste-role-select");
  if (sel) {
    sel.onchange = (ev) => {
      state.roleOverride = ev.target.value || null;
      runPaste();
    };
  }
  const ov = $("paste-override");
  if (ov) {
    ov.onclick = () => { state.overrideBlocked = true; render(); };
  }
}

export { SECTIONS, SECTION_TITLES };
