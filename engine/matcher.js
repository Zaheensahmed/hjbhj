// engine/matcher.js -- PURE. Field descriptors in, a fill plan out.
//
// Three tiers, because a match off a name attribute is not the same thing as
// autocomplete="email" and should not wear the same colour:
//   confident (>= 0.75)  filled, green
//   review    (>= 0.45)  filled, blue, and listed for you to check
//   unknown   (< 0.45)   left alone, amber, listed with an answer box
import { FIELD_RULES, TIERS } from "../rules/field-rules.js";
import { expand, DECLINE_OPTIONS } from "../rules/synonyms.js";
import { normOption, derivePattern, patternToRegex } from "./normalize.js";
import { skillsText, bulletsText } from "./assembler.js";

const LEARNED_BASE = 0.92;        // a taught answer beats a generic regex rule
const LEARNED_PATTERN_BASE = 0.7; // a wildcarded pattern match is weaker

function atPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function labelHits(patterns, label) {
  if (!patterns) return true;
  return patterns.some((re) => re.test(label));
}

function gateOk(rule, field) {
  if (rule.types && !rule.types.includes(field.type)) return false;
  if (rule.tags && !rule.tags.includes(field.tag)) return false;
  return true;
}

/** Match a desired value against the options actually on the page. */
export function resolveOption(candidates, options, rejectOption) {
  const opts = options.map((o) => ({ ...o, cmp: normOption(o.textRaw || o.value) }));
  const usable = rejectOption ? opts.filter((o) => !rejectOption.test(o.textRaw || o.value)) : opts;
  const vetoed = rejectOption ? opts.filter((o) => rejectOption.test(o.textRaw || o.value)) : [];

  for (const cand of candidates) {
    for (const form of expand(cand)) {
      const f = normOption(form);
      if (!f) continue;
      let hit = usable.find((o) => o.cmp === f);
      if (hit) return { option: hit, score: 1.0, via: "exact", vetoed };
      hit = usable.find((o) => o.cmp.startsWith(f) || f.startsWith(o.cmp));
      if (hit && f.length > 1) return { option: hit, score: 0.85, via: "prefix", vetoed };
      hit = usable.find((o) => o.cmp.includes(f));
      if (hit && f.length > 2) return { option: hit, score: 0.7, via: "contains", vetoed };
    }
  }
  return { option: null, score: 0, via: "none", vetoed };
}

function findDeclineOption(options) {
  const opts = options.map((o) => ({ ...o, cmp: normOption(o.textRaw || o.value) }));
  for (const d of DECLINE_OPTIONS) {
    const f = normOption(d);
    const hit = opts.find((o) => o.cmp === f) || opts.find((o) => o.cmp.includes(f));
    if (hit) return hit;
  }
  return null;
}

function normResolve(r) {
  if (r == null) return null;
  if (typeof r === "string" || typeof r === "number") return { value: String(r) };
  return r;
}

function runResolve(rule, ctx) {
  const r = rule.resolve;
  switch (r.kind) {
    case "path": {
      const v = atPath(ctx.profile, r.path);
      return v == null ? null : { value: String(v) };
    }
    case "const":
      return { value: String(r.value) };
    case "choose":
      return { candidates: r.candidates, tierCap: r.tierCap };
    case "fn":
      return normResolve(r.fn(ctx));
    case "assemble":
      return { assemble: r.target };
    case "eeo":
      return { eeo: true };
    case "manual":
      return { manual: true, note: rule.note || null };
    default:
      return null;
  }
}

function learnedMatch(field, learned) {
  const exact = learned[field.labelNorm];
  if (exact) return { entry: exact, key: field.labelNorm, score: LEARNED_BASE, via: "learned-exact" };
  const pat = derivePattern(field.labelNorm);
  for (const [key, entry] of Object.entries(learned)) {
    if (!entry.derivedPattern) continue;
    if (entry.derivedPattern === pat) return { entry, key, score: LEARNED_PATTERN_BASE, via: "learned-pattern" };
    try {
      if (patternToRegex(entry.derivedPattern).test(field.labelNorm)) {
        return { entry, key, score: LEARNED_PATTERN_BASE, via: "learned-pattern" };
      }
    } catch { /* a bad stored pattern must not break a scan */ }
  }
  return null;
}

function tierOf(score) {
  if (score >= TIERS.CONFIDENT) return "confident";
  if (score >= TIERS.REVIEW) return "review";
  return "unknown";
}

/**
 * @param {Array} fields  descriptors from content/scan.js
 * @param {object} ctx    { profile, posting, assembled, learned, prefs, host }
 */
export function matchFields(fields, ctx) {
  const { profile, posting, assembled, learned = {}, prefs = {} } = ctx;

  const plan = [];       // things to actually write to the page
  const unknowns = [];   // amber, you answer these
  const manual = [];     // deliberately not filled, with a reason
  const eeo = [];        // your call, decline option located for you
  const uploads = [];    // file inputs, which JS cannot set
  const conflicts = [];
  const learnedUsed = [];

  for (const field of fields) {
    if (field.tag === "file") {
      uploads.push({ field, reason: "File inputs cannot be set by JavaScript. Attach this one yourself." });
      continue;
    }
    if (field.type === "password") continue;

    // --- candidate rules
    const scored = [];
    for (const rule of FIELD_RULES) {
      if (!gateOk(rule, field)) continue;

      let signal = field.labelWeight;
      let via = field.labelSource;
      if (rule.autocomplete && field.autocomplete && rule.autocomplete.includes(field.autocomplete)) {
        signal = 1.0; via = "autocomplete";
      } else if (!labelHits(rule.any, field.labelNorm)) {
        continue;
      }
      if (rule.not && labelHits(rule.not, field.labelNorm)) continue;

      scored.push({ rule, score: rule.base * signal, via });
    }
    scored.sort((a, b) => b.score - a.score);

    // --- learned answers
    const lm = learnedMatch(field, learned);
    const best = scored[0] || null;

    let chosen = null;
    if (lm && (!best || lm.score >= best.score)) {
      chosen = { kind: "learned", lm, score: lm.score };
    } else if (best) {
      chosen = { kind: "rule", rule: best.rule, score: best.score, via: best.via };
    }

    if (lm && best) {
      const ruleOut = normResolve(runResolve(best.rule, { profile, field, posting, prefs, assembled }));
      const ruleVal = ruleOut && ruleOut.value;
      if (ruleVal != null && String(ruleVal) !== String(lm.entry.answer)) {
        conflicts.push({
          field, ruleId: best.rule.id,
          ruleValue: String(ruleVal), learnedValue: String(lm.entry.answer),
          learnedKey: lm.key
        });
      }
    }

    if (!chosen) {
      unknowns.push({ field, reason: "No rule matched this label." });
      continue;
    }

    // --- learned branch
    if (chosen.kind === "learned") {
      const entry = chosen.lm.entry;
      if (field.options && field.options.length) {
        const m = resolveOption([entry.answer], field.options);
        if (!m.option) {
          unknowns.push({ field, reason: `Saved answer "${entry.answer}" is not one of this form's options.` });
          continue;
        }
        plan.push({ field, kind: field.tag === "radiogroup" ? "check" : "select", targetJafId: m.option.jafId || field.jafId, value: m.option.value, display: m.option.textRaw, tier: tierOf(chosen.score * m.score), source: chosen.lm.via, ruleId: "learned" });
      } else {
        plan.push({ field, kind: "value", targetJafId: field.jafId, value: entry.answer, display: entry.answer, tier: tierOf(chosen.score), source: chosen.lm.via, ruleId: "learned" });
      }
      learnedUsed.push(chosen.lm.key);
      continue;
    }

    // --- rule branch
    const rule = chosen.rule;
    const out = normResolve(runResolve(rule, { profile, field, posting, prefs, assembled }));

    if (!out) {
      unknowns.push({ field, reason: `Rule "${rule.id}" matched the label but the profile has no value for it.` });
      continue;
    }
    if (out.eeo) {
      eeo.push({ field, decline: findDeclineOption(field.options || []), note: profile.standard_answers.eeo_questions });
      continue;
    }
    if (out.manual) {
      manual.push({ field, ruleId: rule.id, note: out.note || rule.note || "Not auto-filled." });
      continue;
    }
    if (out.leaveBlank) {
      manual.push({ field, ruleId: rule.id, note: out.note, deliberatelyBlank: true });
      continue;
    }

    // assembled output
    if (out.assemble) {
      if (!assembled || !assembled.ok) {
        unknowns.push({ field, reason: "Assembler has no output for this posting yet. Set a role type first." });
        continue;
      }
      let value = null;
      if (out.assemble === "skills") {
        value = skillsText(assembled.skills, field.maxLength);
      } else if (out.assemble === "lead_bullets") {
        const lead = assembled.entries.find((e) => e.isLead) || assembled.entries[0];
        value = lead ? bulletsText(lead, field.maxLength) : null;
      }
      if (!value) {
        unknowns.push({ field, reason: "Nothing assembled for this target." });
        continue;
      }
      plan.push({ field, kind: "value", targetJafId: field.jafId, value, display: value, tier: tierOf(Math.min(chosen.score, TIERS.CONFIDENT + 0.01)), source: "assembler", ruleId: rule.id, assembled: out.assemble });
      continue;
    }

    // option-based
    if (field.options && field.options.length) {
      const candidates = out.candidates || (out.value != null ? [out.value] : []);
      if (!candidates.length) {
        unknowns.push({ field, reason: `Rule "${rule.id}" produced no candidate for a choice field.` });
        continue;
      }
      const m = resolveOption(candidates, field.options, out.rejectOption);
      if (!m.option) {
        unknowns.push({
          field,
          reason: `Rule "${rule.id}" wanted ${candidates.map((c) => `"${c}"`).join(" or ")} and none of this form's options match. Not guessing at the nearest one.`,
          note: out.note,
          vetoed: m.vetoed.map((v) => v.textRaw)
        });
        continue;
      }
      const cap = out.tierCap || rule.tierCap;
      let score = chosen.score * m.score;
      if (cap) score = Math.min(score, cap);
      plan.push({
        field, kind: field.tag === "radiogroup" ? "check" : "select",
        targetJafId: m.option.jafId || field.jafId,
        value: m.option.value, display: m.option.textRaw,
        tier: tierOf(score), source: `${chosen.via} / ${m.via}`, ruleId: rule.id,
        note: out.note, vetoed: m.vetoed.map((v) => v.textRaw)
      });
      continue;
    }

    // plain value
    if (out.value == null || out.value === "") {
      unknowns.push({ field, reason: `Rule "${rule.id}" resolved to an empty value.`, note: out.note });
      continue;
    }
    let score = chosen.score;
    const cap = out.tierCap || rule.tierCap;
    if (cap) score = Math.min(score, cap);
    let value = String(out.value);
    let truncated = false;
    if (field.maxLength && value.length > field.maxLength) {
      value = value.slice(0, field.maxLength);
      truncated = true;
    }
    plan.push({ field, kind: "value", targetJafId: field.jafId, value, display: value, tier: tierOf(score), source: chosen.via, ruleId: rule.id, note: out.note, truncated });
  }

  // Standalone checkboxes are never ticked unless a rule explicitly targeted
  // them. Ticking a box you have not read is not autofill, it is agreeing on
  // your behalf.
  const filtered = plan.filter((p) => {
    if (p.field.tag !== "checkbox") return true;
    manual.push({ field: p.field, ruleId: p.ruleId, note: "Standalone checkbox. Not ticked automatically." });
    return false;
  });

  return {
    plan: filtered.filter((p) => p.tier !== "unknown"),
    confident: filtered.filter((p) => p.tier === "confident"),
    review: filtered.filter((p) => p.tier === "review"),
    unknowns, manual, eeo, uploads, conflicts, learnedUsed
  };
}
