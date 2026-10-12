// engine/assembler.js -- PURE.
//
// Selects and orders claims you already wrote. It does not write, merge,
// paraphrase or soften anything.
//
// How that is enforced rather than merely intended:
//   1. Selection works on claim IDs. Text is resolved only at the final step,
//      by lookup in the allowed set built from the profile.
//   2. There is no string concatenation, template literal or .replace() applied
//      to claim text anywhere in this file. The one join that exists copies two
//      whole claim texts around a separator from a fixed whitelist, and only
//      when you listed that exact pair in assembly_rules.merge_pairs.
//   3. Everything returned goes through verifyOutput() before it reaches the
//      popup or a form field. A failure refuses to fill.
import { termsOf } from "./normalize.js";
import { buildAllowedSet, verifyOutput, verifyNoGrcImplication, JOIN_SEPARATORS } from "./verify.js";
import { GRC_IMPLICATION_TOKENS } from "../rules/role-rules.js";

const ALL_TAG = "all";
const ALL_TAG_BONUS = 0.15;
const JD_TERM_BONUS = 0.5;
const BULLETS_PER_ENTRY = 3;
const DEFAULT_SKILL_COUNT = 10;

/** Weight a tag by its position in the role's tag list. Earlier means more. */
function tagWeights(tagList) {
  const w = new Map();
  tagList.forEach((t, i) => w.set(t, (tagList.length - i) / tagList.length));
  return w;
}

function bannedSkill(name, neverClaim) {
  return neverClaim.some((t) => {
    const core = t.replace(/\s*\(.*\)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${core}([^a-z0-9]|$)`, "i").test(name);
  });
}

function scoreTags(tags, weights, jdTerms, text) {
  let score = 0;
  let matched = [];
  for (const t of tags || []) {
    if (t === ALL_TAG) { score += ALL_TAG_BONUS; continue; }
    const w = weights.get(t);
    if (w != null) { score += w; matched.push(t); }
  }
  // Relevance bump when the claim already names something the posting asks for.
  // This changes ordering only. It never changes text.
  let jdHits = [];
  if (jdTerms && jdTerms.size) {
    for (const term of termsOf(text)) {
      if (jdTerms.has(term) && term.length > 3) jdHits.push(term);
    }
    jdHits = [...new Set(jdHits)];
    score += Math.min(jdHits.length, 4) * JD_TERM_BONUS;
  }
  return { score, matched, jdHits };
}

/**
 * @param {object} profile
 * @param {object} posting  from parsePosting()
 * @param {object} opts  { roleTypeOverride, skillLimit }
 */
export function assemble(profile, posting, opts = {}) {
  const rules = profile.assembly_rules || {};
  const roleMap = rules.role_type_tags || {};
  const neverClaim = profile.NEVER_CLAIM || [];
  const allowed = buildAllowedSet(profile);

  const roleType = opts.roleTypeOverride || (posting && posting.roles ? posting.roles.primary : null);
  const notices = [];

  if (!roleType) {
    return {
      ok: false,
      roleType: null,
      needsRoleType: true,
      reason: posting && posting.roles ? posting.roles.reason : "No posting text to infer from.",
      entries: [], skills: [], gaps: [], mergeCandidates: [], notices
    };
  }

  const tagList = roleMap[roleType] || [ALL_TAG];
  const weights = tagWeights(tagList);
  const secondary = opts.roleTypeOverride ? null : (posting && posting.roles ? posting.roles.secondary : null);
  if (secondary && roleMap[secondary]) {
    // Secondary tags count, at half weight, and never displace a primary tag.
    (roleMap[secondary] || []).forEach((t, i) => {
      const half = ((roleMap[secondary].length - i) / roleMap[secondary].length) * 0.5;
      if (!weights.has(t) || weights.get(t) < half) weights.set(t, half);
    });
    notices.push({ level: "info", text: `Secondary role type "${secondary}" contributed tags at half weight.` });
  }

  const isGrc = /grc|risk|audit|banking/i.test(roleType);
  if (isGrc) {
    notices.push({ level: "warn", text: rules.no_grc_experience });
  }

  const jdTerms = posting ? posting.termSet : new Set();

  // ---- score and select claims, by ID
  const groups = [];
  const sources = [
    ...(profile.experience || []).map((e) => ({ kind: "experience", entry: e })),
    ...(profile.projects || []).map((p) => ({ kind: "project", entry: p }))
  ];

  for (const { kind, entry } of sources) {
    const scored = (entry.claims || []).map((c, i) => {
      const id = `${entry.id}.${i}`;
      const s = scoreTags(c.tags, weights, jdTerms, c.text);
      return { id, score: s.score, matchedTags: s.matched, jdHits: s.jdHits };
    })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const picked = scored.slice(0, BULLETS_PER_ENTRY);
    if (!picked.length) continue;

    groups.push({
      kind,
      entryId: entry.id,
      header: kind === "experience"
        ? { employer: entry.employer, department: entry.department, title: entry.title, focus: entry.focus, city: entry.city, state: entry.state, start: entry.start, end: entry.end }
        : { name: entry.name, subtitle: entry.subtitle, dates: entry.dates, stack: entry.stack, my_scope: entry.my_scope, team_size: entry.team_size },
      picked,
      dropped: scored.slice(BULLETS_PER_ENTRY),
      aggregate: picked.reduce((sum, c) => sum + c.score, 0)
    });
  }

  // ---- lead_with: order by match, not by date
  groups.sort((a, b) => b.aggregate - a.aggregate);
  const lead = groups[0] || null;
  if (lead) {
    notices.push({
      level: "info",
      text: `Leading with ${lead.kind === "experience" ? lead.header.employer + " (" + lead.header.focus + ")" : lead.header.name}, aggregate claim score ${lead.aggregate.toFixed(2)}. assembly_rules.lead_with says relevance, not recency.`
    });
  }

  // ---- resolve IDs to text, by lookup only
  const approvedPairs = rules.merge_pairs || [];
  const entries = groups.map((g) => {
    const bullets = [];
    const used = new Set();

    for (const c of g.picked) {
      if (used.has(c.id)) continue;
      const pair = approvedPairs.find(
        (p) => (p.a === c.id && g.picked.some((x) => x.id === p.b) && !used.has(p.b)) ||
               (p.b === c.id && g.picked.some((x) => x.id === p.a) && !used.has(p.a))
      );
      if (pair) {
        const a = allowed.byId.get(pair.a);
        const b = allowed.byId.get(pair.b);
        const sep = JOIN_SEPARATORS.includes(pair.separator) ? pair.separator : JOIN_SEPARATORS[0];
        if (a && b) {
          bullets.push({ ids: [pair.a, pair.b], text: a.text.replace(/[.\s]+$/, "") + sep + b.text, merged: true });
          used.add(pair.a); used.add(pair.b);
          continue;
        }
      }
      const claim = allowed.byId.get(c.id);
      if (!claim) continue;
      bullets.push({ ids: [c.id], text: claim.text, merged: false, matchedTags: c.matchedTags, jdHits: c.jdHits });
      used.add(c.id);
    }

    return { kind: g.kind, entryId: g.entryId, header: g.header, isLead: g === lead, bullets, droppedIds: g.dropped.map((d) => d.id), aggregate: g.aggregate };
  });

  // ---- skills
  const skillLimit = opts.skillLimit || DEFAULT_SKILL_COUNT;
  const skillRows = (profile.skill_pool || [])
    .filter((s) => !bannedSkill(s.skill, neverClaim))
    .map((s) => {
      const base = scoreTags(s.tags, weights, jdTerms, s.skill);
      const named = jdTerms.has(s.skill.toLowerCase()) ? 1.0 : 0;
      return { skill: s.skill, tags: s.tags, evidence: s.evidence, score: base.score + named, matchedTags: base.matched };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));

  const skills = skillRows.slice(0, skillLimit);
  const skillsHeld = skillRows.slice(skillLimit);
  const droppedForNeverClaim = (profile.skill_pool || [])
    .filter((s) => bannedSkill(s.skill, neverClaim))
    .map((s) => s.skill);
  if (droppedForNeverClaim.length) {
    notices.push({ level: "info", text: `Dropped from skills by NEVER_CLAIM: ${droppedForNeverClaim.join(", ")}` });
  }

  // ---- honest gaps
  const claimedTerms = new Set();
  for (const e of entries) for (const b of e.bullets) for (const t of termsOf(b.text)) claimedTerms.add(t);
  for (const s of skillRows) for (const t of termsOf(s.skill)) claimedTerms.add(t);

  const gaps = (posting ? posting.requirements : []).filter((req) => {
    const parts = termsOf(req);
    return !parts.every((p) => claimedTerms.has(p));
  });

  // ---- merge candidates, for you to approve into merge_pairs
  const mergeCandidates = [];
  for (const g of groups) {
    for (let i = 0; i < g.picked.length - 1; i++) {
      const a = g.picked[i], b = g.picked[i + 1];
      const at = allowed.byId.get(a.id), bt = allowed.byId.get(b.id);
      if (!at || !bt) continue;
      const shared = (at.tags || []).filter((t) => (bt.tags || []).includes(t) && t !== ALL_TAG);
      if (!shared.length) continue;
      if (approvedPairs.some((p) => (p.a === a.id && p.b === b.id) || (p.a === b.id && p.b === a.id))) continue;
      mergeCandidates.push({
        a: a.id, b: b.id, sharedTags: shared,
        aText: at.text, bText: bt.text,
        preview: at.text.replace(/[.\s]+$/, "") + JOIN_SEPARATORS[0] + bt.text,
        snippet: JSON.stringify({ a: a.id, b: b.id })
      });
    }
  }

  // ---- verification gate
  const items = [
    ...entries.flatMap((e) => e.bullets.map((b) => ({ text: b.text, kind: "claim", ids: b.ids }))),
    ...skills.map((s) => ({ text: s.skill, kind: "skill" }))
  ];
  const check = verifyOutput(items, allowed, profile);
  const grcCheck = isGrc ? verifyNoGrcImplication(items, GRC_IMPLICATION_TOKENS) : { ok: true, violations: [] };

  const violations = [...check.violations, ...grcCheck.violations];
  for (const w of check.warnings) notices.push({ level: "warn", text: `${w.reason} Text: "${w.text}"` });

  return {
    ok: violations.length === 0,
    roleType,
    secondary,
    tagList: [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([t, w]) => ({ tag: t, weight: Number(w.toFixed(2)) })),
    entries,
    skills,
    skillsHeld,
    gaps,
    mergeCandidates,
    notices,
    violations,
    isGrc
  };
}

/** Flat text for a skills field, trimmed to fit rather than abbreviated. */
export function skillsText(skills, maxLength) {
  const names = skills.map((s) => s.skill);
  if (!maxLength) return names.join(", ");
  let out = [];
  for (const n of names) {
    const next = out.concat(n).join(", ");
    if (next.length > maxLength) break;
    out.push(n);
  }
  return out.join(", ");
}

/** Bullet block for an experience-description textarea. */
export function bulletsText(entry, maxLength) {
  const lines = entry.bullets.map((b) => b.text);
  if (!maxLength) return lines.join("\n");
  let out = [];
  for (const l of lines) {
    if (out.concat(l).join("\n").length > maxLength) break;
    out.push(l);
  }
  return out.join("\n");
}
