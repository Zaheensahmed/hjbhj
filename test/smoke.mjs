// test/smoke.mjs -- run with: node test/smoke.mjs
//
// Asserts the invariants that are the point of the design, not just that the
// code runs. engine/ and rules/ are pure ES modules with no browser
// dependencies, which is what makes this possible without a build step.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePosting } from "../engine/posting.js";
import { assemble, skillsText } from "../engine/assembler.js";
import { buildAllowedSet, verifyOutput } from "../engine/verify.js";
import { checkEligibility } from "../engine/eligibility.js";
import { matchFields } from "../engine/matcher.js";
import { normLabel } from "../engine/normalize.js";
import { buildReport, reportToText, sectionText, SECTIONS, SECTION_TITLES } from "../engine/report.js";
import { triageCard, triageAll, VERDICTS } from "../engine/triage.js";
import { parsePanel, splitSections, bulletsOf, parseInsider, parseMatch, resolveDestination, parseQualificationTags } from "../engine/harvest.js";
import { QUEUE_STATUSES, AUTO_SETTABLE, advanceOnOpen, nextToOpen, queueSummary, toTrackerRecord, atsFromUrl, slugify, harvestSummaryMessage, earlyTerminationMessage } from "../engine/queue.js";
import { assess, harvestStateOf, boardReport, partitionQueue, STAGE2_VERDICTS } from "../engine/assess.js";
import { isJobrightUrl } from "../engine/harvest.js";
import * as JR from "../rules/jobright-rules.js";
import { execFileSync } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The real data files are gitignored. A clean clone has only the .example.json
// ones, which are structurally identical with placeholder values, so almost
// everything here runs either way. The few groups that assert real content are
// skipped and say so.
function loadData(realPath, examplePath) {
  const real = path.join(root, realPath);
  if (fs.existsSync(real)) return { data: JSON.parse(fs.readFileSync(real, "utf8")), isReal: true };
  return { data: JSON.parse(fs.readFileSync(path.join(root, examplePath), "utf8")), isReal: false };
}
const loadedProfile = loadData("data/profile.json", "data/profile.example.json");
const loadedTracker = loadData("tracker/data.json", "tracker/data.example.json");
const profile = loadedProfile.data;
const REAL_PROFILE = loadedProfile.isReal;
const REAL_TRACKER = loadedTracker.isReal;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`); }
}
function group(name) { console.log(`\n${name}`); }
let skipped = 0;
function skip(name, why) { skipped++; console.log(`  skip ${name}\n       ${why}`); }

const field = (o) => ({
  jafId: o.jafId || "jaf-x", tag: o.tag || "input", type: o.type || "text",
  name: o.name || null, id: o.id || null, autocomplete: o.autocomplete || null,
  required: Boolean(o.required), maxLength: o.maxLength || null, max: o.max || null,
  placeholder: o.placeholder || null, currentValue: "", options: o.options || [],
  labelRaw: o.label, labelNorm: normLabel(o.label),
  labelSource: o.labelSource || "label-for", labelWeight: o.labelWeight ?? 0.95
});
const opts = (...texts) => texts.map((t, i) => ({ jafId: `jaf-o${i}`, value: t, textRaw: t }));

const POSTINGS = {
  offensive: parsePosting({ title: "Summer 2027 Offensive Security Intern", text: "Red team engagements, penetration testing and vulnerability research against embedded devices. You will reverse engineer firmware and write proof-of-concept exploits. The range for this role is $22 - $28 per hour. Nice to have: Ghidra, Burp Suite, AWS." }),
  blue: parsePosting({ title: "SOC Analyst Intern, Summer 2027", text: "Join our security operations center. Threat detection, alert triage, monitoring and baselining across network traffic. Packet analysis and hardening experience welcome. We use Splunk and CrowdStrike." }),
  ai: parsePosting({ title: "AI Security Intern", text: "Work on LLM safety and prompt injection defense for large language model deployments. Data privacy, PII handling and application security. Summer 2027." }),
  embedded: parsePosting({ title: "Embedded Systems Security Intern", text: "Firmware and bare metal work on microcontrollers. Device driver development, SPI, GPIO, RTOS. Systems programming in C. Summer internship." }),
  grc: parsePosting({ title: "GRC Risk Analyst Intern", text: "Governance, risk and compliance. You will support control testing, audit readiness and policy writing against NIST and ISO 27001. Banking environment. Summer 2027 internship." }),
  federal: parsePosting({ title: "Federal Cybersecurity Student Intern", text: "Public service mission at a federal agency. National security work supporting government systems. Summer 2027. US citizenship required." })
};

// ---------------------------------------------------------------------------
group("Assembler: every role type produces verified output");
for (const [name, posting] of Object.entries(POSTINGS)) {
  const a = assemble(profile, posting);
  ok(`${name} assembles`, a.ok && a.entries.length > 0, a.violations && a.violations.length ? JSON.stringify(a.violations[0]) : "no entries");
  ok(`${name} emits no violations`, a.violations.length === 0, JSON.stringify(a.violations));
}

// ---------------------------------------------------------------------------
group("Hard constraint: output text is identity-equal to profile text");
{
  const allowed = buildAllowedSet(profile);
  const a = assemble(profile, POSTINGS.offensive);
  const everyBullet = a.entries.flatMap((e) => e.bullets);
  ok("every bullet text exists verbatim in the profile",
    everyBullet.every((b) => allowed.byText.has(b.text)),
    everyBullet.filter((b) => !allowed.byText.has(b.text)).map((b) => b.text).join(" | "));
  ok("every bullet carries the ids it came from",
    everyBullet.every((b) => b.ids.length >= 1 && b.ids.every((id) => allowed.byId.has(id))));
  ok("every skill exists verbatim in skill_pool",
    a.skills.every((s) => allowed.skills.has(s.skill)));
}

// ---------------------------------------------------------------------------
group("Verifier rejects what it must");
{
  const allowed = buildAllowedSet(profile);
  const real = profile.experience[0].claims[0].text;

  const cases = [
    ["invented claim", "Led a red team engagement for a Fortune 500 client"],
    // A content-independent mutation, so this holds for the example profile too.
    ["softened qualifier", "Led a full security audit after " + real.charAt(0).toLowerCase() + real.slice(1)],
    ["silent merge", profile.experience[0].claims[0].text + " and " + profile.experience[0].claims[1].text],
    ["strengthened wording", "Built a mitmproxy tool that fixed the authentication vulnerability"],
    ["NEVER_CLAIM term", "Performed malware analysis in Ghidra"]
  ];
  for (const [label, text] of cases) {
    const r = verifyOutput([{ text, kind: "claim" }], allowed, profile);
    ok(`rejects ${label}`, !r.ok, "verifier accepted it");
  }
  const r = verifyOutput([{ text: real, kind: "claim" }], allowed, profile);
  ok("accepts verbatim claim", r.ok, JSON.stringify(r.violations));

  const rs = verifyOutput([{ text: "Nmap", kind: "skill" }], allowed, profile);
  ok("accepts verbatim skill", rs.ok);
  const rb = verifyOutput([{ text: "Ghidra", kind: "skill" }], allowed, profile);
  ok("rejects a skill not in the pool", !rb.ok);
}

// ---------------------------------------------------------------------------
group("merge_pairs gates every merge");
{
  ok("profile ships with an empty merge_pairs", Array.isArray(profile.assembly_rules.merge_pairs));

  const a1 = assemble(profile, POSTINGS.embedded);
  ok("no merges happen with an empty merge_pairs",
    a1.entries.every((e) => e.bullets.every((b) => !b.merged)));
  ok("merge candidates are offered instead", a1.mergeCandidates.length > 0);

  const cand = a1.mergeCandidates[0];
  const withPair = JSON.parse(JSON.stringify(profile));
  withPair.assembly_rules.merge_pairs = [{ a: cand.a, b: cand.b }];
  const a2 = assemble(withPair, POSTINGS.embedded);
  const merged = a2.entries.flatMap((e) => e.bullets).filter((b) => b.merged);
  ok("an approved pair does merge", merged.length === 1, `${merged.length} merges`);
  ok("the approved merge verifies", a2.ok, JSON.stringify(a2.violations));
  ok("the merge is the two texts joined by a whitelisted separator",
    merged.length === 1 && merged[0].text === cand.preview);

  const allowed = buildAllowedSet(profile);
  const unapproved = verifyOutput([{ text: cand.preview, kind: "claim" }], allowed, profile);
  ok("the same join is rejected when not in merge_pairs", !unapproved.ok);
}

// ---------------------------------------------------------------------------
group("NEVER_CLAIM scope");
{
  const a = assemble(profile, POSTINGS.ai);
  const banned = profile.NEVER_CLAIM.map((t) => t.toLowerCase());
  ok("no skill output matches a NEVER_CLAIM term",
    !a.skills.some((s) => banned.some((b) => s.skill.toLowerCase().includes(b))),
    a.skills.map((s) => s.skill).join(", "));
  ok("no bullet text matches a NEVER_CLAIM term",
    !a.entries.flatMap((e) => e.bullets).some((b) => banned.some((x) => b.text.toLowerCase().includes(x))));

  // The exemption the user asked for: project metadata is not claim text.
  const receipts = a.entries.find((e) => e.entryId === "receipts");
  ok("projects[].stack is exempt and passed through untouched",
    receipts && receipts.header.stack === profile.projects[0].stack,
    receipts ? String(receipts.header.stack) : "receipts entry missing");
  ok("stack is not part of the verified claim output",
    !a.entries.flatMap((e) => e.bullets).some((b) => b.text === profile.projects[0].stack));
  ok("my_scope travels with the project so the Swift split stays visible",
    receipts && /Did NOT write the Swift UI/.test(receipts.header.my_scope));
}

// ---------------------------------------------------------------------------
group("no_grc_experience");
{
  const a = assemble(profile, POSTINGS.grc);
  ok("GRC posting is recognised", /GRC/.test(a.roleType), a.roleType);
  ok("the no-GRC rule is surfaced as a warning",
    a.notices.some((n) => n.level === "warn" && /NO governance/.test(n.text)));
  ok("output implies no framework or audit experience", a.violations.length === 0, JSON.stringify(a.violations));
  const text = a.entries.flatMap((e) => e.bullets.map((b) => b.text)).join(" ").toLowerCase();
  ok("no framework token leaks into the bullets",
    !/\bnist\b|\biso 27001\b|\bsoc 2\b|\baudit\b|risk register|policy writing/.test(text));
  if (REAL_PROFILE) {
    ok("leads with assessment, controls or documentation per the rule",
      /assess|identified|restricted|documented|implemented|built/.test(a.entries[0].bullets[0].text.toLowerCase()),
      a.entries[0].bullets[0].text);
  } else {
    skip("leads with assessment, controls or documentation", "checks the wording of real claim text.");
  }
}

// ---------------------------------------------------------------------------
group("Gaps are reported, not stretched");
{
  const a = assemble(profile, POSTINGS.offensive);
  ok("Ghidra is reported as a gap", a.gaps.includes("ghidra"), a.gaps.join(", "));
  ok("AWS is reported as a gap", a.gaps.includes("aws"));
  const b = assemble(profile, POSTINGS.blue);
  ok("Splunk is reported as a gap", b.gaps.includes("splunk"), b.gaps.join(", "));
}

// ---------------------------------------------------------------------------
group("lead_with picks relevance, not recency");
{
  const off = assemble(profile, POSTINGS.offensive);
  ok("offensive posting leads with the drone work",
    off.entries.find((e) => e.isLead).entryId === "gmu_drone",
    off.entries.find((e) => e.isLead).entryId);
  const emb = assemble(profile, POSTINGS.embedded);
  ok("embedded posting leads with the embedded entry",
    emb.entries.find((e) => e.isLead).entryId === "gmu_beholder",
    emb.entries.find((e) => e.isLead).entryId);
  const ai = assemble(profile, POSTINGS.ai);
  ok("AI posting leads with Receipts",
    ai.entries.find((e) => e.isLead).entryId === "receipts",
    ai.entries.find((e) => e.isLead).entryId);
}

// ---------------------------------------------------------------------------
group("Eligibility");
{
  const blockText = (s) => parsePosting({ text: s + " " + "Filler sentence to clear the minimum length requirement. ".repeat(8) });

  const clearance = checkEligibility(profile, blockText("Applicants must currently hold an active TS/SCI clearance."));
  ok("active clearance blocks", clearance.blocked, JSON.stringify(clearance.blockers));

  const obtainable = checkEligibility(profile, blockText("Must have the ability to obtain a security clearance."));
  ok("ability to obtain does not block", !obtainable.blocked, JSON.stringify(obtainable.blockers));

  const grad = checkEligibility(profile, blockText("Open to the class of 2027 and 2028 only."));
  ok("a graduation window excluding 2029 blocks", grad.blocked, JSON.stringify(grad.blockers));

  const gradOk = checkEligibility(profile, blockText("Open to students graduating between 2028 and 2030."));
  ok("a window containing 2029 does not block", !gradOk.blocked, JSON.stringify(gradOk.blockers));

  const inst = checkEligibility(profile, blockText("Applicants must be enrolled at a participating consortium institution in southwest Virginia."));
  ok("an institution restriction blocks", inst.blocked);

  const soft = checkEligibility(profile, blockText("We prefer rising juniors or seniors. Minimum GPA of 3.0 required."));
  ok("rising junior is a soft flag, not a blocker", !soft.blocked && soft.flags.length >= 2, JSON.stringify(soft.flags.map((f) => f.id)));
  ok("the soft flag carries the counter-argument",
    soft.flags.some((f) => /33 credits|sophomore standing|Junior/.test(f.argue)),
    JSON.stringify(soft.flags.map((f) => f.argue)));
  ok("every finding quotes the posting", [...soft.flags, ...soft.blockers].every((f) => f.sentence && f.sentence.length > 0));

  const thin = checkEligibility(profile, parsePosting({ text: "short" }));
  ok("thin text is reported rather than cleared", thin.insufficientText && !thin.blocked);
}

// ---------------------------------------------------------------------------
group("Matcher");
{
  const posting = POSTINGS.offensive;
  const assembled = assemble(profile, posting);
  const ctx = { profile, posting, assembled, learned: {}, prefs: {}, host: "boards.greenhouse.io" };

  const fields = [
    field({ jafId: "f1", label: "Email", type: "email", autocomplete: "email" }),
    field({ jafId: "f2", label: "First Name", autocomplete: "given-name" }),
    field({ jafId: "f3", label: "fld_7_x", labelSource: "attribute", labelWeight: 0.45 }),
    field({ jafId: "f4", label: "Phone", type: "tel" }),
    field({ jafId: "f5", label: "State", tag: "select", options: opts("Maryland", "Virginia", "New York") }),
    field({ jafId: "f6", label: "Are you legally authorized to work in the United States?", tag: "radiogroup", options: opts("Yes", "No") }),
    field({ jafId: "f7", label: "Field of Study", tag: "select", options: opts("Cybersecurity", "Information Systems", "Computer Science") }),
    field({ jafId: "f8", label: "Field of Study", tag: "select", options: opts("Cybersecurity", "Accounting") }),
    field({ jafId: "f9", label: "Have you registered with the Selective Service?", tag: "radiogroup", options: opts("Yes", "No") }),
    field({ jafId: "f10", label: "GPA" }),
    field({ jafId: "f11", label: "High School GPA (4.0 scale)" }),
    field({ jafId: "f12", label: "Gender", tag: "select", options: opts("Male", "Female", "Decline To Self Identify") }),
    field({ jafId: "f13", label: "Relevant technical skills", tag: "textarea", maxLength: 120 }),
    field({ jafId: "f14", label: "Why do you want to work here?", tag: "textarea" }),
    field({ jafId: "f15", label: "I certify that the information provided is accurate and complete", tag: "checkbox", type: "checkbox" }),
    field({ jafId: "f16", label: "Expected graduation date", placeholder: "MM/YY" }),
    field({ jafId: "f17", label: "Desired hourly rate", required: true }),
    field({ jafId: "f18", label: "Zip", autocomplete: "postal-code" }),
    field({ jafId: "f19", label: "What is your favourite colour?" })
  ];

  const m = matchFields(fields, ctx);
  const find = (id) => m.plan.find((p) => p.field.jafId === id);
  const unknown = (id) => m.unknowns.find((u) => u.field.jafId === id);
  const manual = (id) => m.manual.find((x) => x.field.jafId === id);

  ok("email fills from autocomplete at confident tier",
    find("f1") && find("f1").value === profile.identity.email && find("f1").tier === "confident");
  ok("first name fills", find("f2") && find("f2").value === profile.identity.first_name);
  ok("a meaningless attribute label stays unknown", Boolean(unknown("f3")));
  ok("phone fills", find("f4") && find("f4").value === profile.identity.phone);
  ok("state select resolves MD to Maryland", find("f5") && find("f5").display === "Maryland");
  ok("work authorization radio picks Yes", find("f6") && find("f6").display === "Yes");
  ok("field of study picks Information Systems over Cybersecurity",
    find("f7") && find("f7").display === "Information Systems");
  ok("field of study vetoes Cybersecurity when nothing else fits",
    Boolean(unknown("f8")) && unknown("f8").vetoed.includes("Cybersecurity"),
    JSON.stringify(unknown("f8") && unknown("f8").vetoed));
  ok("selective service is never auto-filled",
    Boolean(manual("f9")) && /UNCONFIRMED/.test(manual("f9").note));
  ok("an unqualified GPA field is handed back to you", Boolean(manual("f10")));
  ok("high school GPA on a 4.0 scale gives the unweighted number",
    find("f11") && find("f11").value === profile.education.high_school_gpa_unweighted);
  ok("EEO is routed to your call, never filled",
    m.eeo.some((e) => e.field.jafId === "f12") && !find("f12"));
  ok("the decline option is located for you",
    m.eeo.find((e) => e.field.jafId === "f12").decline.textRaw === "Decline To Self Identify");
  ok("skills field gets assembled skills, trimmed to maxLength",
    find("f13") && find("f13").value === skillsText(assembled.skills, 120) && find("f13").value.length <= 120,
    find("f13") && String(find("f13").value.length));
  ok("the trim drops whole skills and never abbreviates one",
    find("f13") && find("f13").value.split(", ").every((s) => assembled.skills.some((k) => k.skill === s)),
    find("f13") && find("f13").value);
  ok("skills come out most-relevant first",
    assembled.skills[0].skill === "Vulnerability assessment" && assembled.skills[1].skill === "Penetration testing concepts",
    assembled.skills.slice(0, 3).map((s) => s.skill).join(", "));
  ok("an essay field is refused, with a reason", Boolean(manual("f14")) && /cannot draft this/.test(manual("f14").note));
  ok("a certification checkbox is never ticked", Boolean(manual("f15")) && !find("f15"));
  ok("graduation date respects an MM/YY placeholder",
    find("f16") && find("f16").value === profile.education.graduation_mm_yy);
  ok("salary uses the top of a detected range",
    find("f17") && find("f17").value === "$28" && find("f17").tier === "review",
    find("f17") && find("f17").value);
  ok("zip fills", find("f18") && find("f18").value === profile.identity.zip);
  ok("an unmatched question stays unknown", Boolean(unknown("f19")));
  ok("nothing in the plan sits below the review tier", m.plan.every((p) => p.tier !== "unknown"));

  // learned answers
  const learned = {
    "what is your favourite colour": {
      labelRaw: "What is your favourite colour?", labelNorm: "what is your favourite colour",
      derivedPattern: "what is your favourite colour", answer: "Blue", tag: "input", type: "text", options: null
    }
  };
  const m2 = matchFields(fields, { ...ctx, learned });
  const f19 = m2.plan.find((p) => p.field.jafId === "f19");
  ok("a learned answer fills on the next pass", f19 && f19.value === "Blue" && f19.tier === "confident");
  ok("a learned answer beats nothing and is marked as learned", f19 && f19.ruleId === "learned");
}

// ---------------------------------------------------------------------------
group("Matcher: blocked posting fills nothing from the assembler");
{
  const posting = POSTINGS.offensive;
  const m = matchFields([field({ jafId: "s1", label: "Relevant technical skills", tag: "textarea" })],
    { profile, posting, assembled: null, learned: {}, prefs: {} });
  ok("skills stays unknown with no assembled output", m.unknowns.length === 1 && m.plan.length === 0);
}

// ---------------------------------------------------------------------------
group("fill.js cannot submit");
{
  // Comments are stripped first. fill.js documents that it never submits, and
  // a grep over the prose would pass on the promise instead of the code.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  const banned = [/\.submit\s*\(/, /requestSubmit/, /\.click\s*\(/, /type\s*=\s*["']submit["']/, /HTMLFormElement/];
  for (const file of ["content/fill.js", "content/scan.js", "content/label.js", "popup/popup.js"]) {
    const code = stripComments(fs.readFileSync(path.join(root, file), "utf8"));
    for (const re of banned) {
      ok(`no ${re.source} in ${file}`, !re.test(code));
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  ok("manifest declares no content_scripts, so nothing runs on page load", !("content_scripts" in manifest));
  ok("manifest requests no host permissions", !("host_permissions" in manifest));
  ok("manifest requests exactly activeTab, scripting, storage, notifications",
    JSON.stringify(manifest.permissions) === JSON.stringify(["activeTab", "scripting", "storage", "notifications"]),
    JSON.stringify(manifest.permissions));
}

// ---------------------------------------------------------------------------
group("Posting parsing");
{
  ok("summer term detected", POSTINGS.offensive.term === "summer");
  ok("pay range top is used, not invented",
    parsePosting({ text: "Pay is $16.00 - $19.67 per hour." }).payRange.top === "$19.67");
  ok("no range means no payRange", parsePosting({ text: "Competitive pay." }).payRange === null);
  const vague = parsePosting({ title: "Intern", text: "Join our team. We value curiosity." });
  ok("a vague posting refuses to guess a role type", vague.roles.primary === null, vague.roles.reason);
  const a = assemble(profile, vague);
  ok("the assembler asks instead of assuming", a.needsRoleType === true && a.entries.length === 0);
}


// ---------------------------------------------------------------------------
group("Feature 1: standalone report");
{
  const jd = `Summer 2027 Offensive Security Intern

We are hiring an intern for our offensive security team. You will perform
penetration testing and vulnerability research against embedded devices and
reverse engineer firmware. The range is $22 - $28 per hour.

Requirements:
- Must be enrolled in a Bachelor's program
- We prefer rising juniors or seniors
- Minimum GPA of 3.0 required
- Must have the ability to obtain a security clearance
- Nice to have: Ghidra, Burp Suite, AWS`;

  const r = buildReport(profile, jd);
  ok("report carries posting, eligibility and assembled", Boolean(r.posting && r.eligibility && r.assembled));
  ok("the title is taken from the first line", r.posting.title === "Summer 2027 Offensive Security Intern", r.posting.title);
  ok("role type is inferred", r.assembled.roleType === "offensive / red team / RE / vuln research", r.assembled.roleType);
  ok("assembled output verifies", r.assembled.ok && r.assembled.violations.length === 0);

  for (const which of SECTIONS) {
    const t = sectionText(r, profile, which);
    ok(`section "${which}" renders non-empty text`, typeof t === "string" && t.trim().length > 0);
  }

  const full = reportToText(r, profile);
  for (const which of SECTIONS) {
    ok(`the full report includes the ${which} section`, full.includes(SECTION_TITLES[which]));
  }

  // The text renderer must not invent or reshape claim text. Every bullet line,
  // with its list marker removed, has to be identity-equal to a profile claim.
  const allowed = buildAllowedSet(profile);
  const bulletLines = sectionText(r, profile, "bullets")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  ok("every bullet line in the text output is verbatim profile text",
    bulletLines.length > 0 && bulletLines.every((l) => allowed.byText.has(l)),
    bulletLines.filter((l) => !allowed.byText.has(l)).join(" | "));
  ok("every skill in the text output is verbatim profile text",
    sectionText(r, profile, "skills").split("\n")[0].split(", ").every((s) => allowed.skills.has(s)));
  ok("no em-dash reaches the rendered report", !/[—–]/.test(full));

  // The institution-restriction false positive this feature surfaced.
  ok("a degree requirement is not read as an institution restriction",
    !r.eligibility.blocked,
    JSON.stringify(r.eligibility.blockers.map((b) => b.id)));
  ok("the degree requirement is explicitly cleared, not ignored",
    r.eligibility.cleared.some((c) => c.id === "institution_restriction"));

  // Quoting a bullet list must quote one bullet, not run them together.
  const gpaFlag = r.eligibility.flags.find((f) => f.id === "gpa_floor");
  ok("a bullet is quoted on its own", gpaFlag && gpaFlag.sentence === "Minimum GPA of 3.0 required", gpaFlag && gpaFlag.sentence);
  const juniorFlag = r.eligibility.flags.find((f) => f.id === "rising_junior_senior");
  ok("each flag quotes only its own bullet", juniorFlag && juniorFlag.sentence === "We prefer rising juniors or seniors", juniorFlag && juniorFlag.sentence);

  // A real institution restriction still blocks.
  const consortium = buildReport(profile, "Intern role. ".repeat(20) + "\nApplicants must be enrolled at a participating consortium institution in southwest Virginia.");
  ok("a consortium restriction still blocks", consortium.eligibility.blocked);

  // A blocked posting assembles nothing by default, but still reports.
  const blockedReport = buildReport(profile, "Security Intern. ".repeat(20) + "\nApplicants must currently hold an active TS/SCI clearance.");
  ok("a blocked posting is reported as blocked", blockedReport.eligibility.blocked);
  ok("the blocked report still names the blocker in its text",
    sectionText(blockedReport, profile, "eligibility").includes("HARD BLOCKER"));

  // Role override.
  const overridden = buildReport(profile, jd, { roleTypeOverride: "AI / LLM security" });
  ok("a role override is honoured", overridden.assembled.roleType === "AI / LLM security");
  ok("an override changes which entry leads",
    overridden.assembled.entries.find((e) => e.isLead).entryId === "receipts",
    overridden.assembled.entries.find((e) => e.isLead).entryId);

  // Skill limit.
  ok("the skill limit is respected", buildReport(profile, jd, { skillLimit: 4 }).assembled.skills.length === 4);

  // Thin input.
  const thin = buildReport(profile, "Intern wanted.");
  ok("thin text reports insufficient text rather than clearing", thin.eligibility.insufficientText);
}

// ---------------------------------------------------------------------------
group("Feature 1: the paste path touches no page");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  // engine/ and the paste tab may not reach a page or inject anything.
  const pageReach = [/chrome\.scripting/, /executeScript/, /chrome\.tabs/, /document\.querySelector/];
  const engineFiles = fs.readdirSync(path.join(root, "engine")).map((f) => "engine/" + f);
  for (const file of [...engineFiles, "popup/tab-paste.js", "engine/report.js", "cli.mjs"]) {
    const code = stripComments(fs.readFileSync(path.join(root, file), "utf8"));
    for (const re of pageReach) {
      ok(`${file} does not use ${re.source}`, !re.test(code));
    }
  }
  for (const file of engineFiles) {
    const code = stripComments(fs.readFileSync(path.join(root, file), "utf8"));
    ok(`${file} does not reference chrome.*`, !/\bchrome\./.test(code));
    ok(`${file} does not reference document`, !/\bdocument\b/.test(code));
    ok(`${file} makes no network request`, !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code));
  }
}

// ---------------------------------------------------------------------------
group("Feature 1: cli.mjs");
{
  const tmp = path.join(root, "test", ".cli-fixture.txt");
  fs.writeFileSync(tmp, `AI Security Intern, Summer 2027

Work on LLM safety and prompt injection defense for large language model
deployments. Data privacy and PII handling.

Requirements:
- Must be enrolled in a Bachelor's program
- Experience with AWS and Kubernetes preferred`);

  const runCli = (args) => {
    try {
      return { out: execFileSync("node", [path.join(root, "cli.mjs"), ...args], { encoding: "utf8" }), code: 0 };
    } catch (err) {
      return { out: (err.stdout || "") + (err.stderr || ""), code: err.status };
    }
  };

  const a = runCli([tmp]);
  ok("cli exits 0 on a viable posting", a.code === 0, `exit ${a.code}`);
  ok("cli prints every section", SECTIONS.every((w) => a.out.includes(SECTION_TITLES[w])));
  ok("cli infers the AI role type", /Role type: AI \/ LLM security/.test(a.out), a.out.split("\n").find((l) => l.startsWith("Role type:")));
  ok("cli reports the AWS gap", /aws/.test(a.out.split("Gaps")[1] || ""));
  ok("cli output matches the module output exactly",
    a.out === reportToText(buildReport(profile, fs.readFileSync(tmp, "utf8")), profile));

  const b = runCli([tmp, "--role", "embedded / hardware / systems"]);
  ok("cli honours --role", /Role type: embedded \/ hardware \/ systems/.test(b.out));

  const c = runCli([tmp, "--role", "nonsense"]);
  ok("cli rejects an unknown role type", c.code === 1 && /Unknown role type/.test(c.out), `exit ${c.code}`);

  const d = runCli(["--help"]);
  ok("cli --help lists the real role types", d.code === 0 && d.out.includes("GRC / risk / audit / banking"));

  const blocked = path.join(root, "test", ".cli-blocked.txt");
  fs.writeFileSync(blocked, "Intern role at our agency. ".repeat(20) + "\nApplicants must currently hold an active TS/SCI clearance.");
  const e = runCli([blocked]);
  ok("cli exits 2 when blocked", e.code === 2, `exit ${e.code}`);

  const f = runCli([path.join(root, "test", "does-not-exist.txt")]);
  ok("cli fails cleanly on a missing file", f.code === 1 && /Could not read/.test(f.out));

  fs.unlinkSync(tmp);
  fs.unlinkSync(blocked);
}

// ---------------------------------------------------------------------------
group("Feature 1: popup wiring");
{
  const html = fs.readFileSync(path.join(root, "popup/popup.html"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  // Ids created at render time, inside innerHTML, rather than present in the
  // static markup.
  const dynamic = new Set(["override", "role-select", "paste-override", "paste-role-select"]);

  const popupFiles = fs.readdirSync(path.join(root, "popup")).filter((f) => f.endsWith(".js"));
  const missing = [];
  for (const file of popupFiles) {
    const src = fs.readFileSync(path.join(root, "popup", file), "utf8");
    for (const m of src.matchAll(/\$\("([a-z0-9-]+)"\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamic.has(id)) missing.push(`${file}: ${id}`);
    }
  }
  ok("every element the popup looks up exists in popup.html", missing.length === 0, missing.join(", "));

  // Sections the page tab shows and hides by id.
  const pageSrc = fs.readFileSync(path.join(root, "popup/tab-page.js"), "utf8");
  const shown = [...pageSrc.matchAll(/show\("(sec-[a-z-]+)"/g)].map((m) => m[1]);
  const missingSections = shown.filter((id) => !htmlIds.has(id));
  ok("every section the page tab toggles exists", missingSections.length === 0, missingSections.join(", "));

  ok("the popup declares both tabs", /data-tab="page"/.test(html) && /data-tab="paste"/.test(html));
  ok("the paste panel exists", htmlIds.has("panel-paste") && htmlIds.has("panel-page"));
}


// ---------------------------------------------------------------------------
group("Feature 2: tracker logic");
{
  await import("../tracker/logic.js");
  const T = globalThis.JAF_TRACKER;
  const TODAY = new Date(Date.UTC(2026, 9, 12)); // 2026-10-12

  ok("logic.js loads as an ES module and exposes one global", Boolean(T) && typeof T.normalize === "function");

  // dates
  ok("a valid date parses", T.parseDate("2026-09-03") instanceof Date);
  ok("a non-date is refused", T.parseDate("Sept 3") === null);
  ok("a slash date is refused rather than guessed", T.parseDate("09/03/2026") === null);
  ok("an impossible date is refused", T.parseDate("2026-02-30") === null);
  ok("an empty date is refused", T.parseDate("") === null && T.parseDate(undefined) === null);
  ok("daysSince counts whole days", T.daysSince("2026-09-03", TODAY) === 39, String(T.daysSince("2026-09-03", TODAY)));
  ok("daysSince on an unparseable date is null, not zero", T.daysSince("soon", TODAY) === null);

  // normalize
  const n = T.normalize({ applications: [{ company: "X" }], deadlines: [{ item: "Y", due: "2027-01-01" }] });
  ok("normalize fills every field as a string", T.FIELDS.every((f) => typeof n.applications[0][f] === "string"));
  ok("normalize defaults a missing status to To apply", n.applications[0].status === "To apply");
  ok("normalize supplies the default status list", n.statuses.includes("Under Review"));
  ok("normalize tolerates junk input", T.normalize(null).applications.length === 0 && T.normalize(7).deadlines.length === 0);

  // validate
  const bad = T.normalize({
    statuses: ["Applied", "Rejected"],
    applications: [
      { id: "a", company: "" },
      { id: "a", company: "Dup" },
      { id: "b", company: "B", date_applied: "09/03/2026" },
      { id: "c", company: "C", status: "Vibes" },
      { id: "d", company: "D", status: "Applied" }
    ],
    deadlines: [{ id: "x", item: "No date" }]
  });
  const problems = T.validate(bad);
  const kinds = new Set(problems.map((p) => p.kind));
  ok("validate catches a missing company", problems.some((p) => p.id === "a" && p.kind === "missing"));
  ok("validate catches a duplicate id", kinds.has("duplicate-id"));
  ok("validate catches a non-ISO date", problems.some((p) => p.id === "b" && p.kind === "bad-date"));
  ok("validate catches an unknown status", problems.some((p) => p.id === "c" && p.kind === "unknown-status"));
  ok("validate catches applied-with-no-date", problems.some((p) => p.id === "d" && p.kind === "incomplete"));
  ok("validate catches a deadline with no date at all", problems.some((p) => p.id === "x" && p.kind === "missing"));

  // byStatus
  const grouped = T.byStatus(T.normalize({
    applications: [
      { id: "1", company: "Zeta", status: "Applied" },
      { id: "2", company: "Alpha", status: "Applied" },
      { id: "3", company: "Early", status: "Applied", priority: "low" },
      { id: "4", company: "Q", status: "Rejected" }
    ]
  }));
  ok("byStatus groups by status", grouped.length === 2);
  ok("byStatus sorts alphabetically inside a group", grouped[0].items[0].company === "Alpha");
  ok("byStatus pushes low priority to the end", grouped[0].items[2].company === "Early");

  // stale
  const staleData = T.normalize({
    applications: [
      { id: "old", company: "Old", status: "Applied", date_last_checked: "2026-08-01" },
      { id: "fresh", company: "Fresh", status: "Applied", date_last_checked: "2026-10-10" },
      { id: "never", company: "Never", status: "Applied", date_applied: "2026-07-01" },
      { id: "nodates", company: "Nodates", status: "Under Review" },
      { id: "dead", company: "Dead", status: "Rejected", date_applied: "2026-01-01" },
      { id: "todo", company: "Todo", status: "To apply" }
    ]
  });
  const st = T.stale(staleData, TODAY);
  const ids = st.map((r) => r.app.id);
  ok("stale finds a record checked long ago", ids.includes("old"));
  ok("stale leaves a recently checked record alone", !ids.includes("fresh"));
  ok("stale falls back to the applied date when never checked", ids.includes("never") && st.find((r) => r.app.id === "never").basis.includes("never checked"));
  ok("stale reports a record with no dates rather than hiding it", ids.includes("nodates") && st.find((r) => r.app.id === "nodates").days === null);
  ok("stale ignores closed applications", !ids.includes("dead"));
  ok("stale ignores ones not applied to yet", !ids.includes("todo"));
  ok("stale puts unknowns last, since unknown is not zero", ids[ids.length - 1] === "nodates", ids.join(","));
  ok("a 29 day gap is not stale", T.stale(T.normalize({ applications: [{ id: "x", company: "X", status: "Applied", date_last_checked: "2026-09-13" }] }), TODAY).length === 0);
  ok("a 30 day gap is stale", T.stale(T.normalize({ applications: [{ id: "x", company: "X", status: "Applied", date_last_checked: "2026-09-12" }] }), TODAY).length === 1);

  // upcoming
  const dueData = T.normalize({
    applications: [
      { id: "app1", company: "WithDeadline", status: "To apply", deadline: "2026-11-01" },
      { id: "app2", company: "Closed", status: "Rejected", deadline: "2026-10-20" }
    ],
    deadlines: [
      { id: "past", item: "Past thing", due: "2026-10-01" },
      { id: "soon", item: "Soon thing", due: "2026-10-15" },
      { id: "vague", item: "Vague thing", due_text: "sometime" }
    ]
  });
  const due = T.upcoming(dueData, TODAY);
  ok("upcoming merges deadlines and application deadlines", due.some((r) => r.kind === "application") && due.some((r) => r.kind === "deadline"));
  ok("upcoming drops deadlines on closed applications", !due.some((r) => r.id === "app2"));
  ok("upcoming sorts soonest first with overdue at the top", due[0].id === "past" && due[0].overdue === true);
  ok("upcoming reports days away", due.find((r) => r.id === "soon").daysAway === 3);
  ok("upcoming puts a date-less item last", due[due.length - 1].id === "vague");
  ok("upcoming can be windowed", T.upcoming(dueData, TODAY, 5).every((r) => r.daysAway === null || r.daysAway <= 5));

  // mergeOverlay
  const seed = { applications: [{ id: "a", company: "A", status: "Applied", notes: "seed note" }] };
  const overlay = { applications: [{ id: "a", status: "Interview" }, { id: "b", company: "B", status: "Applied" }] };
  const merged = T.mergeOverlay(seed, overlay);
  ok("the overlay updates a field it supplies", merged.applications.find((a) => a.id === "a").status === "Interview");
  ok("the overlay does not wipe a field it leaves blank", merged.applications.find((a) => a.id === "a").notes === "seed note");
  ok("the overlay can add a record", merged.applications.find((a) => a.id === "b")._fromOverlay === true);
  ok("an overlaid record is marked", merged.applications.find((a) => a.id === "a")._overlaid === true);
  ok("merging with no overlay is just the seed", T.mergeOverlay(seed, null).applications.length === 1);

  // toJson
  const round = JSON.parse(T.toJson(merged));
  ok("toJson round-trips through JSON.parse", Array.isArray(round.applications));
  ok("toJson strips internal markers", !JSON.stringify(round).includes("_fromOverlay") && !JSON.stringify(round).includes("_overlaid"));
  ok("toJson omits empty fields rather than writing blanks", !("location" in round.applications[0]));
  ok("toJson keeps the statuses list", round.statuses.includes("Under Review"));
  ok("toJson output re-normalizes cleanly", T.normalize(round).applications.length === merged.applications.length);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
group("Feature 2: the example data is usable");
{
  const T = globalThis.JAF_TRACKER;
  const ex = T.normalize(JSON.parse(fs.readFileSync(path.join(root, "tracker/data.example.json"), "utf8")));
  ok("the example tracker normalizes", ex.applications.length > 0 && ex.deadlines.length > 0);
  ok("the example tracker has no bad dates", !T.validate(ex).some((p) => p.kind === "bad-date"));
  ok("the example tracker has no duplicate ids", !T.validate(ex).some((p) => p.kind === "duplicate-id"));
  ok("the example tracker uses known statuses", !T.validate(ex).some((p) => p.kind === "unknown-status"));
  ok("every example view runs", T.byStatus(ex).length > 0 && Array.isArray(T.stale(ex, new Date())) && T.upcoming(ex, new Date()).length > 0);

  const exProfile = JSON.parse(fs.readFileSync(path.join(root, "data/profile.example.json"), "utf8"));
  ok("the example profile has the same top-level shape as a real one",
    JSON.stringify(Object.keys(exProfile)) === JSON.stringify(Object.keys(profile)));
  ok("the example profile keeps every claim id and tag set",
    JSON.stringify(exProfile.experience.map((e) => [e.id, e.claims.map((c) => c.tags)])) ===
    JSON.stringify(profile.experience.map((e) => [e.id, e.claims.map((c) => c.tags)])));
  ok("the example profile keeps NEVER_CLAIM intact", JSON.stringify(exProfile.NEVER_CLAIM) === JSON.stringify(profile.NEVER_CLAIM));
  ok("the example profile keeps the role-type tag map", JSON.stringify(exProfile.assembly_rules.role_type_tags) === JSON.stringify(profile.assembly_rules.role_type_tags));
  ok("the example profile assembles and verifies",
    assemble(exProfile, parsePosting({ title: "Summer 2027 Red Team Intern", text: "Penetration testing and vulnerability research." })).ok);

  // Whether any real value leaked into a committed file is checked in
  // test/seed.local.mjs, which is gitignored, because naming the values here
  // would put them in the repo this check exists to keep them out of.
}

group("Feature 2: tracker stays local");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  const logic = stripComments(fs.readFileSync(path.join(root, "tracker/logic.js"), "utf8"));
  ok("tracker/logic.js touches no DOM", !/\bdocument\b/.test(logic));
  ok("tracker/logic.js touches no chrome API", !/\bchrome\./.test(logic));
  ok("tracker/logic.js makes no network request", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(logic));
  ok("tracker/logic.js has no import or export, so it loads both ways",
    !/^\s*(import|export)\s/m.test(logic));

  const ui = stripComments(fs.readFileSync(path.join(root, "tracker/tracker.js"), "utf8"));
  // The tracker loops over a candidate list, so check the list itself rather
  // than the call site.
  const candidates = (ui.match(/for \(const path of \[([^\]]+)\]\)/) || [])[1] || "";
  const paths = [...candidates.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  ok("the tracker only ever fetches its own two bundled data files",
    JSON.stringify(paths) === '["data.json","data.example.json"]', JSON.stringify(paths));
  ok("the tracker fetches no absolute URL", !/fetch\s*\(\s*["'`]?https?:/i.test(ui));
  ok("the tracker does not use chrome.scripting", !/chrome\.scripting/.test(ui));

  const html = fs.readFileSync(path.join(root, "tracker/index.html"), "utf8");
  ok("the tracker page loads no remote script or style",
    ![...html.matchAll(/(?:src|href)="([^"]+)"/g)].some((m) => /^(https?:)?\/\//.test(m[1])));
  ok("the tracker page says it cannot write to disk", /cannot write to your disk/i.test(html));
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  ok("data/profile.json is gitignored", /^data\/profile\.json$/m.test(ignore));
  ok("tracker/data.json is gitignored", /^tracker\/data\.json$/m.test(ignore));
  ok("the example files are NOT ignored", !/profile\.example\.json/.test(ignore) && !/data\.example\.json/.test(ignore));

  ok("the tracker page offers all four views",
    ["status", "stale", "deadlines", "problems"].every((v) => html.includes(`data-view="${v}"`)));
}


// ---------------------------------------------------------------------------
group("Feature 3: stage-1 verdicts");
{
  const term = (season, year = 2027) => ({ season, year, label: `${year} ${season[0].toUpperCase() + season.slice(1)}` });
  const card = (o = {}) => ({
    cardId: "c1", index: 1, listingUrl: o.listingUrl === undefined ? "https://jobright.ai/jobs/info/abc" : o.listingUrl,
    title: "Security Intern", company: "Acme", location: null, arrangement: null, jobType: "Internship",
    pay: null, startTerm: null, applicants: null, posted: null, earlyApplicant: false, alumni: null,
    matchPercent: null, matchLabel: null, tags: [], applyButtons: [], industry: null, rawText: "",
    ...o
  });
  const codes = (r, kind) => r.reasons.filter((x) => x.kind === kind).map((x) => x.code);

  ok("there are exactly two verdicts and apply is not one", JSON.stringify(VERDICTS) === '["REVIEW","SKIP"]');

  // SKIP: start term is not summer.
  for (const season of ["winter", "spring", "fall"]) {
    const r = triageCard(card({ startTerm: term(season) }));
    ok(`a ${season} start term skips`, r.verdict === "SKIP" && codes(r, "skip").includes("term_not_summer"));
  }
  ok("the skip reason explains the enrollment conflict",
    /term-time and conflict with full-time enrollment/i.test(triageCard(card({ startTerm: term("winter") })).reasons.find((x) => x.code === "term_not_summer").text));
  ok("a summer start term does not skip", triageCard(card({ startTerm: term("summer") })).verdict === "REVIEW");

  // SKIP: onsite and term-time and far.
  const farTermTime = triageCard(card({ startTerm: term("fall"), arrangement: "Onsite", location: "Seattle, WA" }));
  ok("onsite plus term-time plus far skips", farTermTime.verdict === "SKIP" && codes(farTermTime, "skip").includes("onsite_termtime_far"));
  ok("that skip cites the eligibility filter", /school-year on-site role away from campus/i.test(farTermTime.reasons.find((x) => x.code === "onsite_termtime_far").text));

  const farSummer = triageCard(card({ startTerm: term("summer"), arrangement: "Onsite", location: "Seattle, WA" }));
  ok("onsite and far but in summer does NOT skip, because summer relocation is fine",
    farSummer.verdict === "REVIEW", JSON.stringify(codes(farSummer, "skip")));

  const nearTermTime = triageCard(card({ startTerm: term("fall"), arrangement: "Onsite", location: "Baltimore, MD" }));
  ok("onsite term-time but local is not skipped for distance",
    !codes(nearTermTime, "skip").includes("onsite_termtime_far"));

  const remoteFall = triageCard(card({ startTerm: term("fall"), arrangement: "Remote", location: "Seattle, WA" }));
  ok("remote is never skipped for distance", !codes(remoteFall, "skip").includes("onsite_termtime_far"));
  ok("remote is noted as always viable", codes(remoteFall, "note").includes("remote"));

  // FLAG: clearance.
  const clr = triageCard(card({ startTerm: term("summer"), tags: ["Security Clearance"] }));
  ok("a clearance tag flags rather than skips", clr.verdict === "REVIEW" && clr.flags.some((f) => f.code === "clearance"));
  ok("the clearance flag says stage 2 must read the requirement", /required at application/i.test(clr.flags[0].text));
  ok("a clearance flag lowers the score", clr.score < triageCard(card({ startTerm: term("summer") })).score);

  // BOOST cases.
  const cit = triageCard(card({ startTerm: term("summer"), tags: ["U.S. Citizen Only"] }));
  ok("citizen-only boosts", cit.boosts.some((b) => b.code === "citizen_only") && cit.score > 0);
  ok("the US-spelling variant also boosts", triageCard(card({ startTerm: term("summer"), tags: ["US Citizen Only"] })).boosts.some((b) => b.code === "citizen_only"));
  ok("early applicant boosts", triageCard(card({ startTerm: term("summer"), earlyApplicant: true })).boosts.some((b) => b.code === "early_applicant"));
  ok("a small applicant pool boosts", triageCard(card({ startTerm: term("summer"), applicants: 9 })).boosts.some((b) => b.code === "low_applicants"));
  ok("a large applicant pool does not boost", !triageCard(card({ startTerm: term("summer"), applicants: 400 })).boosts.some((b) => b.code === "low_applicants"));
  ok("the threshold boundary is inclusive",
    triageCard(card({ startTerm: term("summer"), applicants: JR.LOW_APPLICANT_THRESHOLD })).boosts.some((b) => b.code === "low_applicants") &&
    !triageCard(card({ startTerm: term("summer"), applicants: JR.LOW_APPLICANT_THRESHOLD + 1 })).boosts.some((b) => b.code === "low_applicants"));

  const alum = triageCard(card({ startTerm: term("summer"), alumni: 3 }));
  ok("alumni count boosts", alum.boosts.some((b) => b.code === "alumni"));
  ok("alumni surface as a referral lead", alum.referralLead && alum.referralLead.kind === "school" && alum.referralLead.count === 3);
  ok("zero alumni is not a referral lead", triageCard(card({ startTerm: term("summer"), alumni: 0 })).referralLead === null);

  // Missing data is noted, never guessed.
  const noTerm = triageCard(card({}));
  ok("a missing start term does not skip", noTerm.verdict === "REVIEW");
  ok("a missing start term is noted", codes(noTerm, "note").includes("term_unknown"));
  ok("unreadable fields are listed", noTerm.missing.includes("startTerm") && noTerm.missing.includes("location"));
  ok("unreadable fields point at the rules file",
    /rules\/jobright-rules\.js/.test(noTerm.reasons.find((x) => x.code === "fields_missing").text));

  // REVIEW is always labelled as a ceiling, never as a recommendation.
  const best = triageCard(card({ startTerm: term("summer"), tags: ["U.S. Citizen Only"], alumni: 5, earlyApplicant: true, applicants: 2, matchPercent: 97 }));
  ok("even the best card is only REVIEW", best.verdict === "REVIEW");
  ok("REVIEW explains that stage 1 cannot check the prose",
    /no job description text/i.test(best.reasons.find((x) => x.kind === "verdict").text));
  ok("REVIEW says it is the ceiling", /best verdict stage 1 can give/i.test(best.reasons.find((x) => x.kind === "verdict").text));

  // Exhaustive: nothing produces anything outside VERDICTS, and never APPLY.
  let combos = 0;
  for (const season of [null, "summer", "fall", "winter", "spring"]) {
    for (const arrangement of [null, "Remote", "Hybrid", "Onsite"]) {
      for (const location of [null, "Baltimore, MD", "Seattle, WA", "Arlington, VA", "Remote"]) {
        for (const tags of [[], ["Security Clearance"], ["U.S. Citizen Only"], ["Security Clearance", "U.S. Citizen Only"]]) {
          for (const alumni of [null, 0, 7]) {
            for (const applicants of [null, 1, 500]) {
              const r = triageCard(card({
                startTerm: season ? term(season) : null, arrangement, location, tags, alumni, applicants,
                earlyApplicant: combos % 3 === 0, matchPercent: combos % 101
              }));
              combos++;
              if (!VERDICTS.includes(r.verdict)) { ok("verdict outside the allowed set", false, JSON.stringify(r.verdict)); break; }
              if (/apply/i.test(r.verdict)) { ok("a verdict said apply", false, r.verdict); break; }
            }
          }
        }
      }
    }
  }
  // 5 seasons x 4 arrangements x 5 locations x 4 tag sets x 3 alumni x 3 applicants
  ok(`all ${combos} field combinations stay inside the two verdicts`, combos === 3600, String(combos));
}

// ---------------------------------------------------------------------------
group("Feature 3: ranking and persistence");
{
  const term = (season) => ({ season, year: 2027, label: `2027 ${season}` });
  const mk = (id, o) => ({
    cardId: id, index: 1, listingUrl: `https://jobright.ai/jobs/info/${id}`,
    title: `T${id}`, company: `C${id}`, location: "Baltimore, MD", arrangement: "Hybrid",
    jobType: "Internship", pay: null, startTerm: term("summer"), applicants: null, posted: null,
    earlyApplicant: false, alumni: null, matchPercent: null, matchLabel: null, tags: [],
    applyButtons: [], industry: null, rawText: "raw", ...o
  });

  const cards = [
    mk("plain", {}),
    mk("winter", { startTerm: term("winter") }),
    mk("strong", { alumni: 4, tags: ["U.S. Citizen Only"], earlyApplicant: true, applicants: 3 }),
    mk("flagged", { tags: ["Security Clearance"] })
  ];

  const { rows, counts } = triageAll(cards, {});
  ok("REVIEW rows come before SKIP rows", rows[rows.length - 1].card.cardId === "winter");
  ok("the strongest card ranks first", rows[0].card.cardId === "strong", rows.map((r) => r.card.cardId).join(","));
  ok("a flagged card ranks below a plain one", rows.findIndex((r) => r.card.cardId === "flagged") > rows.findIndex((r) => r.card.cardId === "plain"));
  ok("counts add up", counts.total === 4 && counts.review === 3 && counts.skip === 1);
  ok("flagged and referral counts are reported", counts.flagged === 1 && counts.referralLeads === 1);

  const dismissed = { dismissed: { "https://jobright.ai/jobs/info/winter": { at: "now" } } };
  const after = triageAll(cards, dismissed);
  ok("a dismissed listing URL does not come back", !after.rows.some((r) => r.card.cardId === "winter"));
  ok("dismissals are counted", after.counts.dismissed === 1 && after.counts.shown === 3);
  ok("dismissal is keyed by listing URL, so a reordered board still hides it",
    triageAll([...cards].reverse(), dismissed).rows.every((r) => r.card.cardId !== "winter"));

  const shortlisted = triageAll(cards, { shortlist: { "https://jobright.ai/jobs/info/strong": { at: "now" } } });
  ok("a shortlisted row is marked", shortlisted.rows.find((r) => r.card.cardId === "strong").shortlisted === true);
  ok("an unshortlisted row is not", shortlisted.rows.find((r) => r.card.cardId === "plain").shortlisted === false);

  // A card with no listing URL cannot be keyed, and must not crash triage.
  const anon = triageAll([mk("anon", { listingUrl: null })], dismissed);
  ok("a card with no listing URL still triages", anon.rows.length === 1);
  ok("it reports the missing URL", anon.rows[0].missing.includes("listingUrl"));
}

// ---------------------------------------------------------------------------
group("Feature 3: rules and scanner hygiene");
{
  const plain = JR.toPlain();
  const json = JSON.stringify(plain);
  ok("toPlain survives JSON", JSON.parse(json).FIELD_PATTERNS.startTerm.length === JR.FIELD_PATTERNS.startTerm.length);
  ok("no pattern collapses to an empty object", !/:\{\}/.test(json) && !/\[\{\}\]/.test(json));
  ok("every pattern keeps source and flags",
    JSON.parse(json).FIELD_PATTERNS.startTerm.every((p) => typeof p.source === "string" && typeof p.flags === "string"));
  ok("rebuilt patterns still match real card text",
    new RegExp(JSON.parse(json).FIELD_PATTERNS.startTerm[0].source, "i").test("Start in 2027 Summer"));

  ok("NEAR_HOME covers Baltimore and the DC area",
    ["Baltimore, MD", "Arlington, VA", "Washington, DC", "Fort Meade, MD"].every((l) => JR.NEAR_HOME.some((re) => re.test(l))));
  ok("NEAR_HOME excludes the far cases",
    ["Seattle, WA", "Austin, TX", "New York, NY", "San Jose, CA"].every((l) => !JR.NEAR_HOME.some((re) => re.test(l))));
  ok("summer is the only non-term-time season",
    JR.SUMMER_TERMS.length === 1 && JR.TERM_TIME_TERMS.length === 4 && !JR.TERM_TIME_TERMS.includes("summer"));

  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const scanSrc = stripComments(fs.readFileSync(path.join(root, "content/jobright-scan.js"), "utf8"));

  ok("the board scanner clicks nothing", !/\.click\s*\(/.test(scanSrc));
  ok("the board scanner submits nothing", !/\.submit\s*\(|requestSubmit/.test(scanSrc));
  ok("the board scanner makes no network request", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(scanSrc));
  ok("the board scanner does not use the Find Any Email box", !/find\s*any\s*email/i.test(scanSrc));
  ok("the board scanner only records which apply button exists",
    /applyButtons/.test(scanSrc) && !/\.click/.test(scanSrc));

  const triageSrc = stripComments(fs.readFileSync(path.join(root, "engine/triage.js"), "utf8"));
  ok("engine/triage.js never assigns an APPLY verdict", !/verdict\s*=\s*["'`]APPLY/i.test(triageSrc));
  ok("the string APPLY appears nowhere in triage code", !/\bAPPLY\b/.test(triageSrc));

  const triTab = stripComments(fs.readFileSync(path.join(root, "popup/tab-triage.js"), "utf8"));
  ok("the triage tab clicks nothing on the page", !/"click"|'click'|\.click\s*\(/.test(triTab));
  ok("the triage tab calls only scanBoard, focusCard and harvest",
    [...triTab.matchAll(/call\("([a-zA-Z]+)"/g)].every((m) => ["scanBoard", "focusCard", "harvest"].includes(m[1])),
    JSON.stringify([...triTab.matchAll(/call\("([a-zA-Z]+)"/g)].map((m) => m[1])));
}


// ---------------------------------------------------------------------------
group("Feature 4: panel parsing");
{
  const PANEL = [
    "Acme Defense", "Posted 2 days ago", "Security Engineering Intern",
    "Baltimore, MD", "Onsite", "$25 - $32 / hour", "Internship", "Start in 2027 Summer",
    "Acme Defense builds secure telemetry systems for industrial customers across the mid-Atlantic and beyond.",
    "82% match", "Experience Level 70%", "Skill 90%", "Education Match 65%",
    "U.S. Citizen Only", "Security Clearance", "142 applicants",
    "Insider Connection",
    "Beyond Your Network (4)", "Dana Reed", "@Acme Defense", "Jo Patel",
    "From Your Previous Company", "Sam Okafor", "Previously@Example Org Inc.",
    "From Your School", "Priya Nair", "@Example State Universi...", "Find Any Email",
    "Responsibilities", "- Assess embedded device security", "- Write proof-of-concept mitigations",
    "Qualification",
    "Required", "- Must graduate in December 2027 or later", "- Must remain enrolled through the internship",
    "- Minimum GPA of 3.0", "- Must be authorized to work in the US",
    "Preferred", "- Experience with Ghidra", "- Familiarity with MQTT",
    "Benefits", "- $1,500 relocation stipend", "- Corporate housing provided for the summer term", "- Health insurance",
    "Company", "Founded 2011", "Headquarters: Columbia, MD", "850 employees", "acmedefense.com", "Glassdoor 4.1", "Series C"
  ].join("\n");

  const r = parsePanel({
    panelText: PANEL,
    links: [{ text: "Original Job Post", href: "https://acme.example/careers/123" }, { text: "Share", href: "#" }],
    tagElements: [
      { text: "Python", className: "tag tag-match", hasIcon: false },
      { text: "Ghidra", className: "tag", hasIcon: false },
      { text: "Linux", className: "tag", hasIcon: true }
    ],
    jobrightUrl: "https://jobright.ai/jobs/info/abc"
  });

  // sections
  ok("responsibilities are parsed as bullets", r.responsibilities.length === 2 && r.responsibilities[0] === "Assess embedded device security");
  ok("required bullets are parsed", r.required.length === 4, JSON.stringify(r.required));
  ok("preferred bullets are parsed separately", r.preferred.length === 2 && r.preferred[0] === "Experience with Ghidra");
  ok("required and preferred do not bleed into each other", !r.required.some((b) => /Ghidra/.test(b)));
  ok("benefits are captured in full", r.benefits.length === 3);
  ok("relocation terms are captured", r.benefits.some((b) => /relocation stipend/i.test(b)));
  ok("housing terms are captured", r.benefits.some((b) => /corporate housing/i.test(b)));

  // match panel: three sub-scores, separately
  ok("the overall match is captured", r.match.overall === 82);
  ok("Experience Level is captured on its own", r.match.subscores.experienceLevel === 70);
  ok("Skill is captured on its own", r.match.subscores.skill === 90);
  ok("Education Match is captured on its own", r.match.subscores.educationMatch === 65);
  ok("the three sub-scores are distinct values", new Set(Object.values(r.match.subscores)).size === 3);
  ok("a worded sub-score is kept as a word, not coerced to a number",
    parseMatch("Experience Level: Strong").subscores.experienceLevel === "Strong");

  // insider connection
  ok("all three insider buckets exist", ["beyond_network", "previous_company", "school"].every((k) => k in r.insider.buckets));
  ok("the beyond-network count comes from the heading", r.insider.buckets.beyond_network.count === 4);
  ok("beyond-network names are captured", r.insider.buckets.beyond_network.people.some((p) => p.name === "Dana Reed"));
  ok("an affiliation attaches to the name above it",
    r.insider.buckets.beyond_network.people.find((p) => p.name === "Dana Reed").affiliation === "Acme Defense");
  ok("the previous-company bucket captures name and affiliation",
    r.insider.buckets.previous_company.people[0].name === "Sam Okafor" &&
    r.insider.buckets.previous_company.people[0].affiliation === "Example Org Inc.");
  ok("the school bucket captures name and truncated affiliation",
    r.insider.buckets.school.people[0].name === "Priya Nair" &&
    /Example State Universi/.test(r.insider.buckets.school.people[0].affiliation));
  ok("school and previous company surface as referral leads", r.insider.leads.length === 2);
  ok("the school lead is surfaced prominently", r.insider.leads.some((l) => l.kind === "school"));
  ok("beyond-network is NOT a referral lead", !r.insider.leads.some((l) => l.kind === "beyond_network"));

  // Find Any Email is never touched and never stored, anywhere in the record.
  ok("Find Any Email appears nowhere in the parsed record",
    !/find any email/i.test(JSON.stringify(r)));

  // qualification tags
  ok("qualification tags are captured with their marked state", r.qualificationTags.length === 3);
  ok("a class-marked tag reads as held", r.qualificationTags.find((t) => t.text === "Python").marked === true);
  ok("an unmarked tag reads as not held", r.qualificationTags.find((t) => t.text === "Ghidra").marked === false);
  ok("an icon also counts as marked", r.qualificationTags.find((t) => t.text === "Linux").marked === true);
  ok("every marked verdict carries low confidence", r.qualificationTags.every((t) => t.markedConfidence === "low"));
  ok("the raw className travels so the heuristic can be corrected",
    r.qualificationTags.every((t) => typeof t.className === "string"));

  // company facts, lightly
  ok("company facts are captured", r.companyFacts.founded === "2011" && r.companyFacts.headquarters === "Columbia, MD");
  ok("employee count and rating are captured", r.companyFacts.employees === "850" && r.companyFacts.glassdoor === "4.1");

  // header
  ok("the start term is parsed from the header", r.header.startTerm.season === "summer" && r.header.startTerm.year === 2027);
  ok("pay is captured", /\$25/.test(r.header.pay));
  ok("the applicant count is captured", r.header.applicants === 142);
  ok("match-panel tags are captured", r.header.tags.includes("Security Clearance") && r.header.tags.includes("U.S. Citizen Only"));

  ok("a fully readable panel reports nothing missing", r.missing.length === 0, JSON.stringify(r.missing));
  ok("the exact text eligibility ran against is kept", r.eligibilityInput.includes("Must graduate in December 2027 or later"));
}

// ---------------------------------------------------------------------------
group("Feature 4: the destination link is read, never clicked");
{
  const JOBRIGHT = "https://jobright.ai/jobs/info/abc";

  const real = resolveDestination([{ text: "Original Job Post", href: "https://acme.example/jobs/9" }], JOBRIGHT);
  ok("a real href becomes the destination", real.destinationUrl === "https://acme.example/jobs/9" && real.resolvesOnOpen === false);
  ok("a real href is reported as found and not jobright", real.originalPostFound === true && real.destinationIsJobright === false);

  // A destination is never backfilled with the Jobright URL. These three states
  // fail for different reasons and have to stay distinguishable, because
  // conflating them is what let a jobright.ai link pass itself off as a
  // destination and reach the work queue.
  for (const href of ["#", "javascript:void(0)", "", "about:blank"]) {
    const r = resolveDestination([{ text: "Original Job Post", href }], JOBRIGHT);
    ok(`an href of "${href || "(empty)"}" yields NO destination, with the link still reported as found`,
      r.destinationUrl === null && r.originalPostFound === true && r.destinationIsJobright === true);
  }

  const internal = resolveDestination([{ text: "Original Job Post", href: "https://jobright.ai/jobs/info/xyz" }], JOBRIGHT);
  ok("an Original Job Post href pointing back at jobright is not a destination",
    internal.destinationUrl === null && internal.destinationIsJobright === true);

  const none = resolveDestination([{ text: "Share", href: "https://x.test" }], JOBRIGHT);
  ok("with no Original Job Post link there is no destination at all", none.destinationUrl === null);
  ok("and the link is reported as not found, which is the diagnosable part", none.originalPostFound === false);
  ok("the reason is recorded", /no original job post link was found/i.test(none.via));
  ok("an unrelated link is never mistaken for the destination", none.destinationUrl !== "https://x.test");
  ok("Apply is never a source of the destination URL",
    resolveDestination([{ text: "Apply with Autofill", href: "https://acme.example/apply" }], JOBRIGHT).destinationUrl === null);
  ok("the Jobright URL is still kept, just not as a destination", none.jobrightUrl === JOBRIGHT);
}

// ---------------------------------------------------------------------------
group("Feature 4: eligibility against the real requirements");
{
  // This is what stage 1 could not do.
  const req = (lines) => checkEligibility(profile, parsePosting({ text: lines.join("\n") + "\n" + "Filler requirement line. ".repeat(12) }));

  const orLater = req(["Must graduate in December 2027 or later"]);
  ok("an open-ended graduation floor does not block", !orLater.blocked, JSON.stringify(orLater.blockers.map((b) => b.why)));
  ok("the floor is explained", orLater.cleared.some((c) => /open-ended floor/i.test(c.why)));

  const orEarlier = req(["Must graduate no later than June 2028"]);
  ok("a ceiling you miss does block", orEarlier.blocked, JSON.stringify(orEarlier.blockers));

  const window2829 = req(["Must graduate between December 2028 and June 2030"]);
  ok("a window containing 2029 does not block", !window2829.blocked);

  const window27 = req(["Open to the class of 2026 and 2027 only"]);
  ok("a closed list excluding 2029 blocks", window27.blocked);

  const enrolled = req(["Must remain enrolled through the duration of the internship"]);
  ok("staying enrolled is not read as an institution restriction", !enrolled.blocked, JSON.stringify(enrolled.blockers));

  const gpa = req(["Minimum GPA of 3.0 required"]);
  ok("a GPA floor is a soft flag with the real answer", !gpa.blocked && gpa.flags.some((f) => f.id === "gpa_floor"));
  ok("the GPA flag gives the honest position", gpa.flags.find((f) => f.id === "gpa_floor").argue.includes("No college GPA yet"));

  const clearance = req(["Must currently hold an active Secret clearance"]);
  ok("an active clearance requirement blocks at stage 2", clearance.blocked);

  const obtainable = req(["Must have the ability to obtain a Secret clearance"]);
  ok("ability to obtain does not block at stage 2", !obtainable.blocked);
}

// ---------------------------------------------------------------------------
group("Feature 4: the harvest loop's click policy");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const src = stripComments(fs.readFileSync(path.join(root, "content/jobright-harvest.js"), "utf8"));

  // Every click must go through safeClick. Exactly one bare .click() is
  // allowed: the one inside safeClick itself, after the refusal check.
  const bareClicks = [...src.matchAll(/\.click\s*\(/g)].length;
  ok("there is exactly one .click() in the file, inside safeClick", bareClicks === 1, String(bareClicks));
  // Order matters more than proximity: the refusal check has to come first.
  const scBody = (() => {
    const from = src.indexOf("function safeClick");
    return from === -1 ? "" : src.slice(from, src.indexOf("\n  }", from));
  })();
  ok("safeClick's body exists", scBody.length > 0);
  ok("safeClick checks the forbidden list BEFORE it clicks",
    scBody.includes("isForbidden(") && scBody.indexOf("isForbidden(") < scBody.indexOf(".click("));
  ok("the one .click() in the file is the one inside safeClick", scBody.includes(".click("));
  ok("safeClick records a refusal rather than clicking", /run\.refusals\.push/.test(src));

  // The only deliberate click targets.
  const whys = [...src.matchAll(/safeClick\([^,]+,\s*[`"']([^`"'$]*)/g)].map((m) => m[1].trim());
  ok("the only things clicked on purpose are a card and a close control",
    whys.every((w) => /^open card|^close/.test(w)), JSON.stringify(whys));

  ok("the loop never submits", !/\.submit\s*\(|requestSubmit/.test(src));
  ok("the loop makes no network request", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
  ok("the loop never touches the Find Any Email box", !/find\s*any\s*email/i.test(src));
  ok("the loop never answers a Did-you-apply prompt", !/did\s*you\s*apply/i.test(src));
  ok("the loop never marks anything applied", !/mark\s*as\s*applied/i.test(src));

  // FORBIDDEN_CLICK must actually cover every button named in the brief.
  const forbidden = (label) => JR.FORBIDDEN_CLICK.some((re) => re.test(label));
  for (const label of [
    "Apply with Autofill", "APPLY WITH AUTOFILL", "Easy Apply", "Apply Now",
    "Save", "Save job", "Dismiss", "Not interested", "Find Any Email",
    "Report Issue", "Share", "Did you apply?", "Mark as applied", "Submit"
  ]) {
    ok(`FORBIDDEN_CLICK refuses "${label}"`, forbidden(label));
  }
  ok("a close control is NOT forbidden", !forbidden("Close") && !forbidden("×"));
  ok("a job card title is NOT forbidden", !forbidden("Security Engineering Intern"));
  ok("the close patterns recognise the usual glyphs",
    ["×", "✕", "x", "Close"].every((t) => JR.CLOSE_TEXTS.some((re) => re.test(t))));
}

// ---------------------------------------------------------------------------
group("Feature 4: loop resilience");
{
  const src = fs.readFileSync(path.join(root, "content/jobright-harvest.js"), "utf8");

  ok("waiting is wall-clock, not tick-counted", /Date\.now\(\)\s*-\s*started/.test(src));
  ok("a hidden tab gets a multiplied budget, not a failure", /hiddenMultiplier/.test(src) && /document\.hidden/.test(src));
  ok("nothing fails before a minimum number of polls", /polls\s*>=\s*rules\.HARVEST\.minPolls/.test(src));
  ok("throttling is reported rather than hidden", /throttled/.test(src));

  ok("a render timeout marks the card failed and continues", /harvest failed[\s\S]{0,600}continue;/.test(src));
  ok("consecutive failures eventually stop the run", /maxConsecutiveFailures/.test(src));
  ok("there is a hard cap on run length", /maxRunMs/.test(src) && /hard cap on run length/.test(src));
  ok("there is a hard cap on cards", /maxCards/.test(src) && /slice\(0, rules\.HARVEST\.maxCards\)/.test(src));
  ok("the gap between cards is randomized", /Math\.random\(\)/.test(src) && /gapMinMs/.test(src) && /gapMaxMs/.test(src));

  ok("Stop is read from storage, so it works after the popup closes", /harvest_control/.test(src) && /readControl/.test(src));
  ok("stopping preserves progress", /stopped by you/.test(src) && /writeProgress/.test(src));
  ok("navigation ends the run cleanly", /beforeunload/.test(src) && /navigation/.test(src));
  ok("progress is written after every card, not at the end",
    (src.match(/await writeProgress\(\)/g) || []).length >= 4);
  ok("each record is reported as it is read", /harvest:record/.test(src));

  ok("the caps are sane", JR.HARVEST.gapMinMs >= 3000 && JR.HARVEST.gapMaxMs <= 6000 && JR.HARVEST.maxRunMs <= 60 * 60 * 1000);

  // The service worker owns parsing and eligibility because a classic content
  // script cannot import engine/.
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  ok("the worker parses the panel", /parsePanel/.test(bg));
  ok("the worker runs eligibility on the harvested text", /checkEligibility/.test(bg));
  ok("the worker stores each record as it arrives", /putHarvested/.test(bg));
  ok("a failed card is still stored, so it is visible", /harvest failed/.test(bg));
  ok("records are keyed by listing URL", /payload\.listingUrl \|\|/.test(bg));
  ok("the message channel stays open for the async reply", /return true;/.test(bg));
}


// ---------------------------------------------------------------------------
group("Feature 5: nothing is ever submitted for you");
{
  ok("there are four queue statuses", JSON.stringify(QUEUE_STATUSES) === '["queued","opened","submitted","skipped"]');
  ok("submitted is not machine-settable", !AUTO_SETTABLE.includes("submitted") && JSON.stringify(AUTO_SETTABLE) === '["opened"]');

  ok("opening moves queued to opened", advanceOnOpen("queued") === "opened");
  ok("opening an already-opened item changes nothing", advanceOnOpen("opened") === "opened");
  ok("opening never touches a submitted item", advanceOnOpen("submitted") === "submitted");
  ok("opening never touches a skipped item", advanceOnOpen("skipped") === "skipped");
  for (const st of [...QUEUE_STATUSES, "", null, undefined, "nonsense"]) {
    if (advanceOnOpen(st) === "submitted" && st !== "submitted") {
      ok(`advanceOnOpen("${st}") produced submitted`, false);
    }
  }
  ok("no input to advanceOnOpen can produce submitted out of thin air",
    [...QUEUE_STATUSES, "", "x"].filter((st) => st !== "submitted").every((st) => advanceOnOpen(st) !== "submitted"));

  const entries = [
    { listingUrl: "u1", company: "B", queueStatus: "opened" },
    { listingUrl: "u2", company: "A", queueStatus: "queued" },
    { listingUrl: "u3", company: "C", queueStatus: "submitted" }
  ];
  ok("next to open prefers a queued item", nextToOpen(entries).listingUrl === "u2");
  ok("with nothing queued it falls back to an opened one",
    nextToOpen(entries.filter((e) => e.queueStatus !== "queued")).listingUrl === "u1");
  ok("with nothing open it returns null",
    nextToOpen(entries.filter((e) => e.queueStatus === "submitted")) === null);

  const sum = queueSummary(entries);
  ok("the summary counts each status", sum.total === 3 && sum.queued === 1 && sum.opened === 1 && sum.submitted === 1);
}

// ---------------------------------------------------------------------------
group("Feature 5: the tracker record a submission becomes");
{
  ok("ATS is inferred from the destination host",
    atsFromUrl("https://boards.greenhouse.io/acme/jobs/1") === "Greenhouse" &&
    atsFromUrl("https://jobs.lever.co/acme/9") === "Lever" &&
    atsFromUrl("https://acme.wd1.myworkdayjobs.com/x") === "Workday");
  ok("an unknown host yields no ATS rather than a guess", atsFromUrl("https://acme.example/careers") === "");
  ok("a Jobright URL is not an ATS", atsFromUrl("https://jobright.ai/jobs/info/x") === "");
  ok("slugify produces a stable id fragment", slugify("A.B. Example & Co") === "a-b-example-co");

  const entry = {
    listingUrl: "https://jobright.ai/jobs/info/abc",
    destinationUrl: "https://boards.greenhouse.io/acme/jobs/1",
    company: "Acme Defense", title: "Security Engineering Intern",
    referralLeads: [{ kind: "school", text: "2 from your school. Ask before applying cold." }]
  };
  const harvested = {
    record: {
      header: { company: "Acme Defense", title: "Security Engineering Intern", location: "Baltimore, MD", startTerm: { label: "2027 Summer" } },
      match: { overall: 82 },
      resolvesOnOpen: false,
      insider: { leads: [] }
    },
    eligibility: { flags: [{ filter: "Minimum GPA stated" }], blockers: [] }
  };

  const rec = toTrackerRecord(entry, harvested, "2026-10-12");
  ok("the record carries the company", rec.company === "Acme Defense");
  ok("the record carries the role", rec.role === "Security Engineering Intern");
  ok("the record carries the location from the harvest", rec.location === "Baltimore, MD");
  ok("the record carries the term", rec.term === "2027 Summer");
  ok("the portal URL is the destination, not the Jobright link", rec.portal_url === entry.destinationUrl);
  ok("the ATS is filled in from the destination", rec.ats === "Greenhouse");
  ok("the status is Applied", rec.status === "Applied");
  ok("the applied date is the day you marked it", rec.date_applied === "2026-10-12");
  ok("last checked is set too", rec.date_last_checked === "2026-10-12");
  ok("the referral lead is kept in the notes", /from your school/.test(rec.notes));
  ok("the match score is kept in the notes", /82%/.test(rec.notes));
  ok("an eligibility flag is kept in the notes", /Minimum GPA stated/.test(rec.notes));
  ok("the id is stable and derived", rec.id === "jr-acme-defense-2027-summer", rec.id);
  ok("the same entry twice produces the same id",
    toTrackerRecord(entry, harvested, "2026-11-01").id === rec.id);

  // The one field nothing here can know.
  ok("the account email is left blank rather than guessed", rec.account_email === "");
  ok("the deadline is left blank rather than guessed", rec.deadline === "");
  ok("next action is left blank", rec.next_action === "");

  // It has to be a shape the tracker accepts.
  const T = globalThis.JAF_TRACKER;
  const normalized = T.normalize({ applications: [rec] });
  ok("the record normalizes cleanly into the tracker", normalized.applications.length === 1);
  ok("the record passes tracker validation on dates",
    !T.validate(normalized).some((p) => p.kind === "bad-date"), JSON.stringify(T.validate(normalized)));
  ok("the record merges into the tracker as an overlay",
    T.mergeOverlay({ applications: [] }, { applications: [rec] }).applications[0]._fromOverlay === true);

  // An unharvested entry still produces something sane.
  const bare = toTrackerRecord({ listingUrl: "https://jobright.ai/jobs/info/z", company: "Zeta" }, null, "2026-10-12");
  ok("an unharvested entry still yields a record", bare.company === "Zeta" && bare.status === "Applied");
  ok("missing facts stay blank", bare.role === "" && bare.location === "" && bare.term === "");
  ok("with no destination the Jobright URL is used", bare.portal_url === "https://jobright.ai/jobs/info/z");

  const resolves = toTrackerRecord(entry, { record: { ...harvested.record, resolvesOnOpen: true }, eligibility: { flags: [], blockers: [] } }, "2026-10-12");
  ok("a resolve-on-open destination is noted in the record", /resolved only on open/i.test(resolves.notes));
}

// ---------------------------------------------------------------------------
group("Feature 5: notification text");
{
  const msg = harvestSummaryMessage({ reviewed: 40, worthApplying: 12, skipped: 25, failed: 3 });
  ok("the completion body matches the stated format",
    msg === "40 reviewed. 12 worth applying to, 25 skipped, 3 failed to harvest.", msg);

  const early = earlyTerminationMessage({ reason: "stopped by you", done: 12, total: 40, failed: 1 });
  ok("early termination says how far it got", /12 of 40/.test(early));
  ok("early termination names the reason", /stopped by you/.test(early));
  ok("early termination says progress was saved", /saved/i.test(early), early);
  ok("early termination reports failures when there were some", /1 failed/.test(early));
  ok("early termination omits failures when there were none",
    !/failed/.test(earlyTerminationMessage({ reason: "navigation", done: 3, total: 9, failed: 0 })));
}

// ---------------------------------------------------------------------------
group("Feature 5: the worker owns the badge and notifications");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const bg = stripComments(fs.readFileSync(path.join(root, "background.js"), "utf8"));

  ok("the worker sets the badge", /chrome\.action\.setBadgeText/.test(bg));
  ok("the badge shows done over total", /\$\{payload\.done\}\/\$\{payload\.total\}/.test(bg));
  ok("the badge turns amber when a card failed", /#d97706/.test(bg) && /failed > 0/.test(bg));
  ok("the badge is green otherwise", /#16a34a/.test(bg));
  ok("the full progress is also in the tooltip, since a badge clips", /setBadgeTitle/.test(bg) && /setTitle/.test(bg));
  ok("the worker fires the completion notification", /chrome\.notifications\.create/.test(bg) && /Jobright triage done/.test(bg));
  ok("the worker notifies on early termination too", /Jobright triage stopped/.test(bg) && /earlyTerminationMessage/.test(bg));
  ok("clicking the notification focuses the Jobright tab",
    /notifications\.onClicked/.test(bg) && /chrome\.tabs\.update\(harvestTabId, \{ active: true \}\)/.test(bg));
  ok("the worker records which tab the harvest ran in", /sender\.tab\.id/.test(bg));
  ok("the worker clears the badge on request", /"badge:clear"/.test(bg));
  ok("completion counts come from what was actually stored", /harvestCounts/.test(bg) && /getTriage/.test(bg));
  ok("the notification has a real icon file", /icons\/icon-128\.png/.test(bg));

  // The content script must not try to do any of this itself.
  const harvestSrc = stripComments(fs.readFileSync(path.join(root, "content/jobright-harvest.js"), "utf8"));
  ok("the content script never calls chrome.notifications", !/chrome\.notifications/.test(harvestSrc));
  ok("the content script never sets the badge", !/chrome\.action/.test(harvestSrc));
  ok("the content script messages the worker instead", /chrome\.runtime\.sendMessage/.test(harvestSrc));

  const popup = stripComments(fs.readFileSync(path.join(root, "popup/popup.js"), "utf8"));
  ok("opening the popup clears the badge", /badge:clear/.test(popup));
}

// ---------------------------------------------------------------------------
group("Feature 5: the queue never claims you applied");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const q = stripComments(fs.readFileSync(path.join(root, "popup/tab-queue.js"), "utf8"));

  ok("opening uses advanceOnOpen, which cannot yield submitted", /advanceOnOpen\(/.test(q));
  ok("the queue never assigns submitted itself",
    !/setQueueStatus\([^)]*["'`]submitted["'`]/.test(q), "found a hard-coded submitted transition");
  ok("submitted only ever comes from the status control you change",
    /const status = sel\.value/.test(q) && /status === "submitted"/.test(q));
  ok("open-next opens in a foreground tab", /chrome\.tabs\.create\(\{ url: [^}]*active: true/.test(q));
  ok("the queue says opening is not applying", /not applying/i.test(q));

  // Order: tracker first, then the Jobright step is offered.
  const trackerAt = q.indexOf("addTrackerRecord");
  const jobrightAt = q.indexOf("data-jobright");
  ok("the tracker write happens before the Jobright action is offered",
    trackerAt > -1 && jobrightAt > -1 && trackerAt < jobrightAt);

  ok("the queue never clicks anything on a page", !/\.click\s*\(/.test(q));
  ok("the queue never answers the did-you-apply prompt",
    !/did\s*you\s*apply/i.test(q.replace(/"Did you apply\?"/g, "")) || /does not answer/i.test(q));
  ok("the Jobright action only brings the card into view",
    /queue:focusCard/.test(q) && !/markApplied|setApplied/.test(q));

  const bg = stripComments(fs.readFileSync(path.join(root, "background.js"), "utf8"));
  const focusHandler = bg.slice(bg.indexOf('"queue:focusCard"'), bg.indexOf('"queue:focusCard"') + 1200);
  ok("the worker's focus handler calls only focusCard", /api\.focusCard\(cardId\)/.test(focusHandler));
  ok("the worker's focus handler clicks nothing", !/\.click\s*\(/.test(focusHandler));
}

// ---------------------------------------------------------------------------
group("Feature 5: packaging");
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  ok("icons are declared", manifest.icons && manifest.icons["128"] === "icons/icon-128.png");
  ok("the action has an icon", manifest.action.default_icon && manifest.action.default_icon["16"]);
  for (const size of [16, 48, 128]) {
    const file = path.join(root, `icons/icon-${size}.png`);
    ok(`icons/icon-${size}.png exists`, fs.existsSync(file));
    const head = fs.readFileSync(file).subarray(0, 8);
    ok(`icons/icon-${size}.png is a real PNG`, head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  }
  ok("still no host permissions", !("host_permissions" in manifest));
  ok("still no content_scripts", !("content_scripts" in manifest));

  // Nothing anywhere reaches the network except the extension's own files.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "test") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) files.push(rel);
    }
  };
  walk("");
  // No fetch anywhere may name a remote host, whether as a literal, a template
  // or a variable holding one.
  const remote = [];
  const literalPaths = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    if (/fetch\s*\(\s*[`"']?\s*(?:https?:)?\/\//i.test(src)) remote.push(`${f}: fetch to an absolute URL`);
    for (const m of src.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]+)["'`]/g)) {
      if (!/schema|w3\.org|json-schema/i.test(m[1])) remote.push(`${f}: URL literal ${m[1]}`);
    }
    for (const m of src.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) literalPaths.push(`${f}:${m[1]}`);
  }
  ok("no file in the extension names a remote URL", remote.length === 0, remote.join(" | "));
  ok("every literal fetch path is a bundled relative path",
    literalPaths.every((p) => !/^https?:/.test(p.split(":").slice(1).join(":"))), literalPaths.join(" | "));
  ok("the profile loader names only the two bundled profile paths",
    /PROFILE_PATH = "data\/profile\.json"/.test(fs.readFileSync(path.join(root, "shared/load-data.js"), "utf8")) &&
    /PROFILE_EXAMPLE_PATH = "data\/profile\.example\.json"/.test(fs.readFileSync(path.join(root, "shared/load-data.js"), "utf8")));
  ok("nothing opens a socket", !files.some((f) => /WebSocket|EventSource/.test(fs.readFileSync(path.join(root, f), "utf8"))));
}


// ---------------------------------------------------------------------------
group("Silent failure fix: a jobright.ai URL is never a destination");
{
  ok("jobright hosts are recognised",
    isJobrightUrl("https://jobright.ai/jobs/info/abc") && isJobrightUrl("https://www.jobright.ai/x"));
  ok("an employer host is not", !isJobrightUrl("https://boards.greenhouse.io/acme/jobs/1"));
  ok("rubbish does not throw", isJobrightUrl("not a url") === true || isJobrightUrl("not a url") === false);
  ok("an empty URL is not a destination", !isJobrightUrl(""));

  const row = (v = "REVIEW") => ({ verdict: v, card: { listingUrl: "https://jobright.ai/jobs/info/u1" } });
  const good = {
    harvestStatus: "ok", blocked: false,
    record: { required: ["Must graduate in 2029 or later", "Remain enrolled"], preferred: [], requiredFrom: "required heading",
      originalPostFound: true, destinationUrl: "https://acme.example/j/1", destinationIsJobright: false, insider: { leads: [] } },
    eligibility: { insufficientText: false, blocked: false, blockers: [], flags: [] }
  };
  const withRec = (patch) => ({ ...good, record: { ...good.record, ...patch } });

  ok("a fully harvested card reaches APPLY", assess(row(), good).verdict === "APPLY");
  ok("and is queue eligible", assess(row(), good).queueEligible === true);

  // The five ways it must NOT be queue eligible.
  const cases = [
    ["not harvested at all", null, "not_harvested"],
    ["panel never opened", { harvestStatus: "harvest failed", why: "panel did not render" }, "panel_failed"],
    ["no Required list found", { ...good, record: { ...good.record, required: [] } }, "no_required"],
    ["no Original Job Post link", withRec({ originalPostFound: false, destinationUrl: null, destinationIsJobright: true }), "no_original_post"],
    ["only a jobright URL", withRec({ originalPostFound: true, destinationUrl: null, destinationIsJobright: true }), "no_destination"]
  ];
  for (const [name, harvested, code] of cases) {
    const a = assess(row(), harvested);
    ok(`${name}: verdict REVIEW, not queueable`, a.verdict === "REVIEW" && a.queueEligible === false, a.verdict);
    ok(`${name}: the reason names the failing step`, a.reasons[0].code === code, a.reasons[0].code);
  }

  // Eligibility over too little text is not an assessment.
  const thin = assess(row(), { ...good, eligibility: { insufficientText: true, blocked: false, blockers: [], flags: [] } });
  ok("a clean verdict over too little requirement text does not reach APPLY",
    thin.verdict === "REVIEW" && thin.queueEligible === false && thin.reasons[0].code === "too_little_text");

  // Blocked and stage-1 skip.
  ok("blocked on the real requirements is SKIP",
    assess(row(), { ...good, blocked: true, eligibility: { insufficientText: false, blocked: true, blockers: [{ filter: "Active clearance", why: "needs one now" }], flags: [] } }).verdict === "SKIP");
  ok("a stage-1 skip stays SKIP", assess(row("SKIP"), good).verdict === "SKIP");

  // Even if a destination somehow is a jobright URL, it is not accepted.
  const sneaky = assess(row(), withRec({ destinationUrl: "https://jobright.ai/jobs/info/u1" }));
  ok("a jobright URL in the destination field is discarded, not used",
    sneaky.state.destinationUrl === null && sneaky.queueEligible === false);
}

// ---------------------------------------------------------------------------
group("Silent failure fix: REVIEW can never reach the queue");
{
  ok("stage 2 has three verdicts and APPLY is one of them",
    JSON.stringify(STAGE2_VERDICTS) === '["APPLY","REVIEW","SKIP"]');
  ok("stage 1 still has only two, and still cannot say APPLY",
    JSON.stringify(VERDICTS) === '["REVIEW","SKIP"]');

  const entry = (o) => ({ listingUrl: "https://jobright.ai/jobs/info/" + o.id, company: o.id, ...o });
  const entries = [
    entry({ id: "ready", destinationUrl: "https://acme.example/1", assessment: { verdict: "APPLY", queueEligible: true, reasons: [] } }),
    entry({ id: "review", destinationUrl: null, assessment: { verdict: "REVIEW", queueEligible: false, reasons: [{ code: "not_harvested", text: "Not harvested." }] } }),
    entry({ id: "skip", destinationUrl: "https://acme.example/3", assessment: { verdict: "SKIP", queueEligible: false, reasons: [{ code: "blocked", text: "Blocked." }] } }),
    entry({ id: "jobrightdest", destinationUrl: "https://jobright.ai/jobs/info/jobrightdest", assessment: { verdict: "APPLY", queueEligible: true, reasons: [] } }),
    entry({ id: "noassessment" })
  ];
  const { eligible, held } = partitionQueue(entries);

  ok("only the fully ready row is eligible", eligible.length === 1 && eligible[0].id === "ready");
  ok("a REVIEW row is held back", held.some((h) => h.id === "review"));
  ok("a SKIP row is held back", held.some((h) => h.id === "skip"));
  ok("a row whose destination is a jobright URL is held back even when marked eligible",
    held.some((h) => h.id === "jobrightdest"));
  ok("a row with no assessment at all is held back, not assumed fine",
    held.some((h) => h.id === "noassessment"));
  ok("held rows are kept with their reason, never silently dropped",
    held.length === 4 && held.every((h) => h.heldBecause && h.heldBecause.length));
}

// ---------------------------------------------------------------------------
group("Silent failure fix: harvest state is visible per board and per card");
{
  const mkRow = (id, verdict = "REVIEW") => ({ verdict, card: { listingUrl: "u" + id, title: "T" + id, company: "C" + id }, referralLead: null });
  const okRec = (patch) => ({
    harvestStatus: "ok", blocked: false, pageUrl: "https://jobright.ai/jobs",
    record: {
      required: ["Must graduate in 2029 or later"], preferred: [], requiredFrom: "required heading",
      originalPostFound: true, destinationUrl: "https://acme.example/1", destinationIsJobright: false, insider: { leads: [] },
      ...(patch && patch.record)
    },
    eligibility: { insufficientText: false, blocked: false, blockers: [], flags: [] },
    ...(patch && patch.top)
  });

  const rows = [mkRow(1), mkRow(2), mkRow(3), mkRow(4)];
  const harvestedByUrl = {
    u1: okRec(),
    u2: okRec({ record: { originalPostFound: false, destinationUrl: null, destinationIsJobright: true } }),
    u3: { harvestStatus: "harvest failed", why: "panel did not render", pageUrl: "https://jobright.ai/jobs" }
    // u4 deliberately never harvested
  };
  const report = boardReport({ rows, harvestedByUrl, run: { startedAt: "2026-10-12T10:00:00Z", finishedAt: "2026-10-12T10:08:00Z" }, boardUrl: "https://jobright.ai/jobs" });

  ok("the report says whether harvest ran and when", report.ran && report.startedAt && report.finishedAt);
  ok("it counts cards on the board", report.counts.cardsOnBoard === 4);
  ok("it counts how many were attempted", report.counts.attempted === 3);
  ok("it counts how many panels opened", report.counts.panelOpened === 2);
  ok("it counts how many failed", report.counts.panelFailed === 1);
  ok("it counts Required lists found", report.counts.requiredFound === 2);
  ok("it counts Original Job Post links found", report.counts.originalPostFound === 1);
  ok("it counts destinations that resolve off jobright", report.counts.destinationResolved === 1);
  ok("it counts what is actually queueable", report.counts.queueEligible === 1);
  ok("the three verdicts are counted separately",
    report.counts.apply === 1 && report.counts.review === 3 && report.counts.skip === 0);

  // Per card, the three steps are individually inspectable.
  const byUrl = (u) => report.assessed.find((a) => a.row.card.listingUrl === u).state;
  ok("card 1 shows all steps passing",
    byUrl("u1").panelOpened && byUrl("u1").requiredFound && byUrl("u1").originalPostFound && byUrl("u1").destinationUrl);
  ok("card 2 shows the link step failing and the others passing",
    byUrl("u2").panelOpened && byUrl("u2").requiredFound && !byUrl("u2").originalPostFound);
  ok("card 3 shows the panel step failing", !byUrl("u3").panelOpened && byUrl("u3").failureReason === "panel did not render");
  ok("card 4 shows as never attempted", byUrl("u4").attempted === false);

  // Required falling back to the Qualification block is reported, not hidden.
  const fallback = boardReport({
    rows: [mkRow(1)], boardUrl: "b",
    harvestedByUrl: { u1: { ...okRec(), pageUrl: "b", record: { ...okRec().record, requiredFrom: "qualification heading (no Required sub-heading was found)" } } },
    run: { startedAt: "x" }
  });
  ok("a Required fallback is counted", fallback.counts.requiredFromFallback === 1);
  ok("and raises a warning", fallback.alarms.some((a) => a.code === "required_fallback" && a.severity === "warn"));
}

// ---------------------------------------------------------------------------
group("Silent failure fix: zero Original Job Post links is loud");
{
  const rows = [1, 2, 3].map((i) => ({ verdict: "REVIEW", card: { listingUrl: "u" + i, title: "T", company: "C" }, referralLead: null }));
  const noLinks = {};
  for (const i of [1, 2, 3]) {
    noLinks["u" + i] = {
      harvestStatus: "ok", blocked: false, pageUrl: "b",
      record: { required: ["Must graduate in 2029 or later"], preferred: [], requiredFrom: "required heading",
        originalPostFound: false, destinationUrl: null, destinationIsJobright: true, insider: { leads: [] } },
      eligibility: { insufficientText: false, blocked: false, blockers: [], flags: [] }
    };
  }
  const report = boardReport({ rows, harvestedByUrl: noLinks, run: { startedAt: "x", finishedAt: "y" }, boardUrl: "b" });

  const alarm = report.alarms.find((a) => a.code === "zero_original_posts");
  ok("zero links across the board raises a critical alarm", Boolean(alarm) && alarm.severity === "critical");
  ok("the alarm says it is a selector problem, not a property of the jobs",
    /selector problem/i.test(alarm.text) && /not 3 jobs without a destination/i.test(alarm.text), alarm.text);
  ok("nothing is queueable", report.counts.queueEligible === 0);
  ok("and queueing is suppressed entirely", report.safeToQueue === false);

  // The other three loud cases.
  const zeroPanels = boardReport({
    rows, boardUrl: "b", run: { startedAt: "x" },
    harvestedByUrl: Object.fromEntries([1, 2, 3].map((i) => ["u" + i, { harvestStatus: "harvest failed", why: "no panel", pageUrl: "b" }]))
  });
  ok("zero panels opening is a critical alarm", zeroPanels.alarms.some((a) => a.code === "zero_panels" && a.severity === "critical"));
  ok("zero panels suppresses queueing", zeroPanels.safeToQueue === false);

  const noRequired = {};
  for (const i of [1, 2, 3]) {
    noRequired["u" + i] = {
      harvestStatus: "ok", blocked: false, pageUrl: "b",
      record: { required: [], preferred: [], requiredFrom: null, originalPostFound: true, destinationUrl: "https://a.test/1", destinationIsJobright: false, insider: { leads: [] } },
      eligibility: { insufficientText: true, blocked: false, blockers: [], flags: [] }
    };
  }
  const zeroReq = boardReport({ rows, harvestedByUrl: noRequired, run: { startedAt: "x" }, boardUrl: "b" });
  ok("zero Required lists is a critical alarm", zeroReq.alarms.some((a) => a.code === "zero_required"));
  ok("the alarm says no clean verdict means anything", /no clean verdict here means anything/i.test(zeroReq.alarms.find((a) => a.code === "zero_required").text));
  ok("zero Required suppresses queueing", zeroReq.safeToQueue === false);

  const unresolved = {};
  for (const i of [1, 2, 3]) {
    unresolved["u" + i] = {
      harvestStatus: "ok", blocked: false, pageUrl: "b",
      record: { required: ["Must graduate in 2029 or later"], preferred: [], requiredFrom: "required heading",
        originalPostFound: true, destinationUrl: null, destinationIsJobright: true, insider: { leads: [] } },
      eligibility: { insufficientText: false, blocked: false, blockers: [], flags: [] }
    };
  }
  const zeroResolved = boardReport({ rows, harvestedByUrl: unresolved, run: { startedAt: "x" }, boardUrl: "b" });
  ok("links found but none resolving is a critical alarm", zeroResolved.alarms.some((a) => a.code === "zero_resolved"));
  ok("that alarm guesses the likely cause", /button that navigates in script/i.test(zeroResolved.alarms.find((a) => a.code === "zero_resolved").text));

  // A healthy board raises nothing and allows queueing.
  const healthy = boardReport({
    rows, boardUrl: "b", run: { startedAt: "x", finishedAt: "y" },
    harvestedByUrl: Object.fromEntries([1, 2, 3].map((i) => ["u" + i, {
      harvestStatus: "ok", blocked: false, pageUrl: "b",
      record: { required: ["Must graduate in 2029 or later"], preferred: [], requiredFrom: "required heading",
        originalPostFound: true, destinationUrl: "https://acme.example/" + i, destinationIsJobright: false, insider: { leads: [] } },
      eligibility: { insufficientText: false, blocked: false, blockers: [], flags: [] }
    }]))
  });
  ok("a healthy board raises no alarms", healthy.alarms.length === 0);
  ok("a healthy board is safe to queue", healthy.safeToQueue === true && healthy.counts.queueEligible === 3);
}

// ---------------------------------------------------------------------------
group("Silent failure fix: the UI cannot reintroduce the fallback");
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const q = stripComments(fs.readFileSync(path.join(root, "popup/tab-queue.js"), "utf8"));

  // The exact line that caused this.
  ok("the queue never falls back to the listing URL for a destination",
    !/destinationUrl:[^\n]*\|\|[^\n]*listingUrl/.test(q), "the || s.listingUrl fallback is back");
  ok("the queue derives its destination from the assessment", /assessment\.state\.destinationUrl/.test(q));
  ok("open next refuses a jobright URL", /isJobrightUrl\(next\.destinationUrl\)/.test(q));
  ok("the refusal explains it is a bug, not a destination",
    /not the employer's posting|is a bug, not a destination/i.test(q));
  ok("the queue partitions rather than filtering silently", /partitionQueue/.test(q));
  ok("held-back rows are rendered with their reason", /heldBecause/.test(q));

  const t = stripComments(fs.readFileSync(path.join(root, "popup/tab-triage.js"), "utf8"));
  ok("auto-queue only ever adds queue-eligible rows", /if \(!a\.queueEligible\) continue;/.test(t));
  ok("auto-queue is suppressed while a critical alarm stands", /safeToQueue/.test(t));
  ok("ticking a non-eligible row is refused with a reason", /Not queueable:/.test(t));
  ok("the triage tab renders the per-card steps", /stepsHtml/.test(t));
  ok("the triage tab renders the board-level harvest report", /harvestReportHtml/.test(t));
  ok("the triage tab says harvest has not run when it has not", /Harvest has not run on this board/.test(t));
  ok("the triage tab states that REVIEW means not yet assessed", /REVIEW means not yet assessed/i.test(t));
}

// Assertions about real seeded content live outside the repo, so the committed
// suite never names a real company, person or credential.
const localTests = path.join(root, "test/seed.local.mjs");
if (fs.existsSync(localTests)) {
  const mod = await import(pathToFileURL(localTests).href);
  await mod.run({ ok, skip, group, profile, root, fs, path, REAL_PROFILE, REAL_TRACKER,
                  T: globalThis.JAF_TRACKER, assemble, parsePosting, checkEligibility });
} else {
  group("Local seed-content tests");
  skip("test/seed.local.mjs", "not present. It is gitignored, so a clean clone has only the structural checks.");
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (!REAL_PROFILE) console.log("note: ran against data/profile.example.json, so content-specific checks used placeholder values.");
if (!REAL_TRACKER) console.log("note: ran against tracker/data.example.json.");
process.exit(fail ? 1 : 0);
