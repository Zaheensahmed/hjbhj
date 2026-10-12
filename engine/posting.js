// engine/posting.js -- PURE. Turns raw job-description text into the few
// structured facts the rest of the engine needs.
import { ROLE_KEYWORDS, TITLE_MULTIPLIER, SECONDARY_THRESHOLD, MIN_CONFIDENT_SCORE, REQUIREMENT_TERMS } from "../rules/role-rules.js";
import { squash, squashLines, termsOf } from "./normalize.js";

const MAX_TEXT = 40000;

export function parsePosting({ text = "", title = "", host = "" } = {}) {
  // Line breaks are preserved. A posting's requirements are usually a bullet
  // list, and collapsing it to one line makes every quoted blocker run into the
  // next bullet.
  const body = squashLines(text).slice(0, MAX_TEXT);
  const head = squash(title);
  const haystack = (head + " \n " + body).toLowerCase();

  return {
    text: body,
    title: head,
    host,
    termSet: new Set(termsOf(haystack)),
    term: detectTerm(haystack),
    payRange: detectPayRange(body),
    requirements: detectRequirements(haystack),
    roles: scoreRoles(head.toLowerCase(), body.toLowerCase())
  };
}

function detectTerm(h) {
  if (/\bsummer\b/.test(h)) return "summer";
  if (/\b(?:fall|autumn)\b/.test(h) && /\b(?:internship|co-?op|term|semester)\b/.test(h)) return "fall";
  if (/\bspring\b/.test(h) && /\b(?:internship|co-?op|term|semester)\b/.test(h)) return "spring";
  if (/\bacademic year\b|\bschool year\b/.test(h)) return "academic_year";
  return null;
}

function detectPayRange(body) {
  const re = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(?:-|to|–|—|and)\s*\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/;
  const m = body.match(re);
  if (!m) return null;
  const num = (s) => Number(s.replace(/,/g, ""));
  const lo = num(m[1]), hi = num(m[2]);
  if (!(hi > lo)) return null;
  const tail = body.slice(m.index, m.index + m[0].length + 40).toLowerCase();
  const unit = /per hour|\/\s?hour|hourly|an hour|\/hr/.test(tail) ? "hour"
    : /per year|annual|\/\s?year|yearly/.test(tail) ? "year" : null;
  return {
    raw: m[0].trim() + (unit ? ` per ${unit}` : ""),
    low: lo,
    high: hi,
    unit,
    // Answer inside their range, at or near the top, per compensation_rules.
    top: unit === "hour" ? `$${hi}` : `$${hi.toLocaleString("en-US")}`
  };
}

function detectRequirements(h) {
  return REQUIREMENT_TERMS.filter((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(h);
  });
}

function scoreRoles(titleLower, bodyLower) {
  const rows = [];
  for (const [role, patterns] of Object.entries(ROLE_KEYWORDS)) {
    let score = 0;
    const hits = [];
    for (const [re, weight] of patterns) {
      const t = (titleLower.match(new RegExp(re.source, re.flags)) || []).length;
      const b = (bodyLower.match(new RegExp(re.source, re.flags)) || []).length;
      if (!t && !b) continue;
      score += weight * (t * TITLE_MULTIPLIER + Math.min(b, 4));
      hits.push({ pattern: re.source, inTitle: t > 0, count: t + b, weight });
    }
    rows.push({ role, score, hits: hits.sort((a, b) => b.weight * b.count - a.weight * a.count).slice(0, 6) });
  }
  rows.sort((a, b) => b.score - a.score);

  const top = rows[0];
  const confident = top && top.score >= MIN_CONFIDENT_SCORE;
  const secondary = confident && rows[1] && rows[1].score >= top.score * SECONDARY_THRESHOLD ? rows[1].role : null;

  return {
    all: rows,
    primary: confident ? top.role : null,
    secondary,
    confident: Boolean(confident),
    reason: confident
      ? `${top.role} scored ${top.score}` + (secondary ? `, ${rows[1].role} close behind at ${rows[1].score}` : "")
      : `Top score was ${top ? top.score : 0}, below the ${MIN_CONFIDENT_SCORE} threshold. Pick a role type yourself or paste more of the posting.`
  };
}
