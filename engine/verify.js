// engine/verify.js -- PURE. The enforcement layer.
//
// Every string the assembler emits has to be identity-equal to a claim or skill
// you wrote, or an approved two-claim join. Nothing else leaves this module
// alive. That is what makes "never invent a claim" a checked invariant rather
// than a comment the next change can quietly break.
//
// Scope note: NEVER_CLAIM is applied to assembled claim text and to skills
// output only. Project metadata such as projects[].stack is exempt, because it
// describes a three-person project truthfully and my_scope already records who
// wrote which part.

export const JOIN_SEPARATORS = [". "];

export function buildAllowedSet(profile) {
  const byText = new Map();
  const byId = new Map();

  const add = (id, text, source, tags) => {
    byId.set(id, { id, text, source, tags: tags || [] });
    if (!byText.has(text)) byText.set(text, id);
  };

  for (const e of profile.experience || []) {
    (e.claims || []).forEach((c, i) => add(`${e.id}.${i}`, c.text, { kind: "experience", id: e.id, employer: e.employer, title: e.title, focus: e.focus, start: e.start, end: e.end }, c.tags));
  }
  for (const p of profile.projects || []) {
    (p.claims || []).forEach((c, i) => add(`${p.id}.${i}`, c.text, { kind: "project", id: p.id, name: p.name, subtitle: p.subtitle, dates: p.dates }, c.tags));
  }
  for (const a of profile.awards || []) {
    add(`award.${byId.size}`, a.text, { kind: "award" }, a.tags);
  }
  const skills = new Set((profile.skill_pool || []).map((s) => s.skill));

  return { byText, byId, skills };
}

function bannedTerms(profile) {
  return (profile.NEVER_CLAIM || []).map((t) => ({
    raw: t,
    re: new RegExp(`(^|[^a-z0-9])${t.replace(/\s*\(.*\)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i")
  }));
}

function approvedJoin(profile, text, allowed) {
  const pairs = (profile.assembly_rules && profile.assembly_rules.merge_pairs) || [];
  for (const sep of JOIN_SEPARATORS) {
    for (const pair of pairs) {
      const a = allowed.byId.get(pair.a);
      const b = allowed.byId.get(pair.b);
      if (!a || !b) continue;
      const joined = a.text.replace(/[.\s]+$/, "") + sep + b.text;
      if (joined === text) return { pair, ids: [pair.a, pair.b] };
    }
  }
  return null;
}

/**
 * @param {Array<{text:string, kind:"claim"|"skill", ids?:string[]}>} items
 * @returns {{ok:boolean, violations:Array, warnings:Array}}
 */
export function verifyOutput(items, allowed, profile) {
  const violations = [];
  const warnings = [];
  const banned = bannedTerms(profile);

  for (const item of items) {
    const text = item.text;

    if (item.kind === "skill") {
      if (!allowed.skills.has(text)) {
        violations.push({ text, reason: "Not a verbatim entry in skill_pool." });
      }
    } else {
      const exact = allowed.byText.has(text);
      const join = exact ? null : approvedJoin(profile, text, allowed);
      if (!exact && !join) {
        violations.push({
          text,
          reason: "Not identity-equal to any claim, and not an approved merge_pairs join. The assembler must select existing text, never compose it."
        });
      }
    }

    // NEVER_CLAIM applies to assembled claim text and skills output.
    for (const b of banned) {
      if (b.re.test(text)) {
        violations.push({ text, reason: `Contains a NEVER_CLAIM term: "${b.raw}".` });
      }
    }

    // writing_rules: no em-dashes anywhere. Flagged, not fatal, because a hit
    // here means the source text has one, which is yours to edit.
    if (/[—–]/.test(text)) {
      warnings.push({ text, reason: "Contains an em-dash or en-dash, which writing_rules forbids. Fix it in profile.json." });
    }
    if (/\s[-]\s/.test(text)) {
      warnings.push({ text, reason: "Contains a spaced hyphen used as punctuation, which writing_rules forbids inside role sections." });
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

/** GRC guard: reject output implying framework or audit experience. */
export function verifyNoGrcImplication(items, tokens) {
  const violations = [];
  for (const item of items) {
    for (const t of tokens) {
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (re.test(item.text)) {
        violations.push({ text: item.text, reason: `Implies governance or audit experience via "${t}", and no_grc_experience says there is none.` });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
