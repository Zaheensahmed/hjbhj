// engine/report.js -- PURE. The standalone report, shared by the popup's paste
// tab and cli.mjs so both produce identical output.
//
// This module reads pasted text and the profile. It never touches the DOM,
// chrome.scripting or the network.
import { parsePosting } from "./posting.js";
import { checkEligibility } from "./eligibility.js";
import { assemble } from "./assembler.js";

export function buildReport(profile, jdText, opts = {}) {
  const posting = parsePosting({
    text: jdText || "",
    title: opts.title || firstLineAsTitle(jdText),
    host: opts.host || "pasted"
  });
  const eligibility = checkEligibility(profile, posting);
  const assembled = assemble(profile, posting, {
    roleTypeOverride: opts.roleTypeOverride || null,
    skillLimit: opts.skillLimit || 10
  });
  return { posting, eligibility, assembled };
}

/** A pasted posting usually leads with its own title. */
function firstLineAsTitle(text) {
  const first = String(text || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return "";
  return first.length <= 120 ? first : "";
}

export const SECTIONS = ["eligibility", "role", "bullets", "skills", "gaps", "merges"];

const BULLET = "- ";
const rule = (s) => "\n" + s + "\n" + "=".repeat(s.length);

function eligibilityText(report, profile) {
  const e = report.eligibility;
  const out = [];
  if (e.insufficientText) {
    out.push(e.note);
    return out.join("\n");
  }
  out.push(e.blocked ? `BLOCKED. ${e.blockers.length} hard blocker(s).` : "No hard blockers found.");
  for (const b of e.blockers) {
    out.push("");
    out.push(`HARD BLOCKER: ${b.filter}${b.confidence === "low" ? " (low confidence, read it yourself)" : ""}`);
    out.push(`  posting says: ${b.sentence}`);
    out.push(`  why: ${b.why}`);
  }
  for (const f of e.flags) {
    out.push("");
    out.push(`FLAG: ${f.filter}`);
    out.push(`  posting says: ${f.sentence}`);
    out.push(`  your answer: ${f.argue}`);
  }
  if (e.cleared.length) {
    out.push("");
    out.push(`Checked and cleared: ${e.cleared.map((c) => c.id).join(", ")}`);
  }
  if (!e.blockers.length && !e.flags.length) {
    out.push(`Always viable: ${profile.eligibility_filters.always_viable}`);
  }
  return out.join("\n");
}

function roleText(report) {
  const p = report.posting;
  const a = report.assembled;
  const out = [];
  out.push(`Role type: ${a.roleType || "not inferred"}`);
  out.push(`Reason: ${p.roles.reason}`);
  if (p.term) out.push(`Term: ${p.term}`);
  if (p.payRange) out.push(`Pay range in the posting: ${p.payRange.raw}`);
  out.push("");
  out.push("Scores:");
  for (const r of p.roles.all) {
    const hits = r.hits.map((h) => h.pattern + (h.inTitle ? " [title]" : "")).join(", ");
    out.push(`  ${String(r.score).padStart(4)}  ${r.role}`);
    if (hits) out.push(`        matched: ${hits}`);
  }
  if (a.tagList) {
    out.push("");
    out.push(`Tags in use: ${a.tagList.map((t) => `${t.tag} ${t.weight}`).join(", ")}`);
  }
  return out.join("\n");
}

function bulletsText(report) {
  const a = report.assembled;
  if (a.needsRoleType) return a.reason;
  const out = [];
  for (const e of a.entries) {
    const head = e.kind === "experience"
      ? `${e.header.employer}, ${e.header.title} (${e.header.focus}), ${e.header.start} to ${e.header.end}`
      : `${e.header.name}, ${e.header.subtitle}, ${e.header.dates}`;
    out.push(`${head}${e.isLead ? "   [LEAD]" : ""}`);
    for (const b of e.bullets) {
      out.push(BULLET + b.text);
      out.push(`    ids: ${b.ids.join(" + ")}${b.merged ? " (approved merge)" : ""}${b.jdHits && b.jdHits.length ? `  posting terms: ${b.jdHits.join(", ")}` : ""}`);
    }
    if (e.kind === "project" && e.header.my_scope) out.push(`    scope on record: ${e.header.my_scope}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function skillsText(report) {
  const a = report.assembled;
  if (a.needsRoleType) return a.reason;
  const out = [a.skills.map((s) => s.skill).join(", ")];
  if (a.skillsHeld && a.skillsHeld.length) {
    out.push("");
    out.push(`Held back past the default 10: ${a.skillsHeld.map((s) => s.skill).join(", ")}`);
  }
  return out.join("\n");
}

function gapsText(report) {
  const a = report.assembled;
  if (!a.gaps || !a.gaps.length) return "Nothing the posting asked for is missing from the pools.";
  return [
    "Asked for, not claimed. Omitted rather than stretched:",
    ...a.gaps.map((g) => BULLET + g),
    "",
    "If any of these is actually true, add it to the profile yourself."
  ].join("\n");
}

function mergesText(report) {
  const a = report.assembled;
  if (!a.mergeCandidates || !a.mergeCandidates.length) return "No merge candidates.";
  const out = ["Not merged. Add a pair to assembly_rules.merge_pairs only if both read true as written and the join asserts nothing new.", ""];
  for (const c of a.mergeCandidates) {
    out.push(`${c.a} + ${c.b}   shares: ${c.sharedTags.join(", ")}`);
    out.push(`  ${c.preview}`);
    out.push(`  snippet: ${c.snippet}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

const BUILDERS = {
  eligibility: eligibilityText,
  role: roleText,
  bullets: bulletsText,
  skills: skillsText,
  gaps: gapsText,
  merges: mergesText
};

export const SECTION_TITLES = {
  eligibility: "Eligibility",
  role: "Role type",
  bullets: "Resume bullets",
  skills: "Skills",
  gaps: "Gaps",
  merges: "Merge candidates"
};

export function sectionText(report, profile, which) {
  const fn = BUILDERS[which];
  if (!fn) throw new Error(`unknown section: ${which}`);
  return fn(report, profile);
}

export function reportToText(report, profile) {
  const out = [];
  const a = report.assembled;
  if (a.violations && a.violations.length) {
    out.push("OUTPUT REFUSED BY THE VERIFIER. Nothing below is safe to use.");
    for (const v of a.violations) out.push(`  ${v.reason}\n    ${v.text}`);
    out.push("");
  }
  for (const n of a.notices || []) {
    out.push(`${n.level === "warn" ? "WARNING" : "note"}: ${n.text}`);
  }
  for (const which of SECTIONS) {
    out.push(rule(SECTION_TITLES[which]));
    out.push(sectionText(report, profile, which));
  }
  return out.join("\n") + "\n";
}
