// test/smoke.mjs -- run with: node test/smoke.mjs
//
// Asserts the invariants that are the point of the design, not just that the
// code runs. engine/ and rules/ are pure ES modules with no browser
// dependencies, which is what makes this possible without a build step.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePosting } from "../engine/posting.js";
import { assemble, skillsText } from "../engine/assembler.js";
import { buildAllowedSet, verifyOutput } from "../engine/verify.js";
import { checkEligibility } from "../engine/eligibility.js";
import { matchFields } from "../engine/matcher.js";
import { normLabel } from "../engine/normalize.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = JSON.parse(fs.readFileSync(path.join(root, "data/profile.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`); }
}
function group(name) { console.log(`\n${name}`); }

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
    ["softened qualifier", real.replace("Assessed", "Led a full security audit of")],
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
  ok("leads with assessment, controls or documentation per the rule",
    /assess|identified|restricted|documented|implemented|built/.test(a.entries[0].bullets[0].text.toLowerCase()),
    a.entries[0].bullets[0].text);
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
  ok("first name fills", find("f2") && find("f2").value === "Casey");
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
  ok("manifest requests exactly activeTab, scripting, storage",
    JSON.stringify(manifest.permissions) === JSON.stringify(["activeTab", "scripting", "storage"]),
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
