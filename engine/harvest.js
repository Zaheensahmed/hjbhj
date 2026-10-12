// engine/harvest.js -- PURE. Parses a harvested detail panel into structure.
//
// The content script's job is to get the panel's text and a handful of DOM
// facts out. All the parsing happens here, which is why it can be tested
// against synthetic panel text without a browser.
import {
  SECTION_HEADINGS, INSIDER_BUCKETS, AFFILIATION_PATTERNS, MATCH_SUBSCORES,
  OVERALL_MATCH_PATTERNS, UNRESOLVED_HREF, COMPANY_FACT_PATTERNS,
  ORIGINAL_POST_PATTERNS, MATCH_PANEL_TAGS, TAG_MARKED_CLASS, FIELD_PATTERNS
} from "../rules/jobright-rules.js";

const BULLET = /^[\s]*[-•·*●▪–]\s*/;

const clean = (l) => l.replace(/\s+/g, " ").trim();
const isBullet = (l) => BULLET.test(l);
const stripBullet = (l) => clean(l.replace(BULLET, ""));

function firstCapture(patterns, haystack) {
  for (const re of patterns) {
    const m = haystack.match(re);
    if (m) return m[1] !== undefined ? m[1] : m[0];
  }
  return null;
}

function headingKey(line) {
  const l = clean(line);
  if (!l || l.length > 60) return null;
  for (const h of SECTION_HEADINGS) {
    if (h.patterns.some((re) => re.test(l))) return h.key;
  }
  return null;
}

function bucketKey(line) {
  const l = clean(line);
  for (const b of INSIDER_BUCKETS) {
    if (b.patterns.some((re) => re.test(l))) return b.key;
  }
  return null;
}

/**
 * Split the panel into sections by heading line. Everything before the first
 * recognised heading is the header block.
 */
export function splitSections(panelText) {
  const lines = String(panelText || "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const sections = { header: [] };
  let current = "header";

  for (const line of lines) {
    const key = headingKey(line);
    if (key) {
      current = key;
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!sections[current]) sections[current] = [];
    if (clean(line)) sections[current].push(clean(line));
  }
  return sections;
}

/** Bullets if the section uses them, otherwise every non-empty line. */
export function bulletsOf(lines) {
  if (!lines || !lines.length) return [];
  const bullets = lines.filter(isBullet).map(stripBullet).filter(Boolean);
  if (bullets.length) return bullets;
  return lines.map(clean).filter((l) => l.length > 2);
}

export function parseInsider(lines) {
  const buckets = {};
  for (const b of INSIDER_BUCKETS) buckets[b.key] = { count: null, people: [], raw: [] };

  let current = null;
  for (const raw of lines || []) {
    const line = clean(raw);
    if (!line) continue;

    const key = bucketKey(line);
    if (key) {
      current = key;
      const n = line.match(/\((\d+)\)|\b(\d+)\s*$/);
      if (n) buckets[current].count = Number(n[1] || n[2]);
      continue;
    }
    if (!current) continue;
    // The Find Any Email box is never used and never stored, not even as raw
    // text, so no record can carry it.
    if (/find any email/i.test(line)) continue;
    buckets[current].raw.push(line);

    const aff = firstCapture(AFFILIATION_PATTERNS, line);
    if (aff && buckets[current].people.length) {
      // An affiliation line belongs to the name above it.
      buckets[current].people[buckets[current].people.length - 1].affiliation = clean(aff);
      continue;
    }
    if (/^\d+$/.test(line)) { buckets[current].count = Number(line); continue; }
    buckets[current].people.push({ name: line, affiliation: null });
  }

  for (const key of Object.keys(buckets)) {
    if (buckets[key].count === null && buckets[key].people.length) buckets[key].count = buckets[key].people.length;
  }

  const leads = [];
  if (buckets.school.people.length) {
    leads.push({ kind: "school", count: buckets.school.count, people: buckets.school.people,
      text: `${buckets.school.count} from your school. Ask before applying cold.` });
  }
  if (buckets.previous_company.people.length) {
    leads.push({ kind: "previous_company", count: buckets.previous_company.count, people: buckets.previous_company.people,
      text: `${buckets.previous_company.count} from a company you worked at.` });
  }
  return { buckets, leads };
}

export function parseMatch(panelText) {
  const overall = firstCapture(OVERALL_MATCH_PATTERNS, panelText);
  const out = { overall: overall === null ? null : Number(overall), subscores: {} };
  for (const s of MATCH_SUBSCORES) {
    const v = firstCapture(s.patterns, panelText);
    out.subscores[s.key] = v === null ? null : /^\d+$/.test(String(v)) ? Number(v) : String(v);
  }
  return out;
}

export function parseHeader(lines, panelText) {
  const body = (lines || []).join("\n");
  const pick = (key) => {
    const m = FIELD_PATTERNS[key]
      .map((re) => body.match(new RegExp(re.source, re.flags.replace("g", ""))))
      .find(Boolean);
    return m || null;
  };
  const term = (() => {
    const m = pick("startTerm");
    if (!m) return null;
    const parts = [m[1], m[2]].filter(Boolean).map(String);
    const season = (parts.find((p) => /^(summer|fall|autumn|winter|spring)$/i.test(p)) || "").toLowerCase();
    if (!season) return null;
    return { season: season === "autumn" ? "fall" : season, year: Number(parts.find((p) => /^20\d{2}$/.test(p))) || null, label: m[0].replace(/^start\s+in\s+/i, "").trim() };
  })();

  const loc = pick("location");
  const pay = pick("pay");
  const type = pick("jobType");
  const arr = pick("arrangement");
  const posted = pick("posted");

  return {
    title: lines && lines.length ? lines.find((l) => l.length > 6 && l.length < 140) || null : null,
    company: lines && lines.length ? lines[0] || null : null,
    location: loc ? clean(loc[1]) : null,
    arrangement: arr ? clean(arr[1]) : null,
    pay: pay ? clean(pay[0]) : null,
    jobType: type ? clean(type[1]) : null,
    startTerm: term,
    postedRaw: posted ? clean(posted[0]) : null,
    applicants: (() => {
      const m = panelText.match(/\b([\d,]+)\s*\+?\s*applicants?\b/i);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    })(),
    tags: MATCH_PANEL_TAGS.filter((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i").test(panelText)),
    blurb: (lines || []).find((l) => l.length > 80) || null
  };
}

export function parseCompanyFacts(panelText) {
  const out = {};
  for (const [key, patterns] of Object.entries(COMPANY_FACT_PATTERNS)) {
    out[key] = firstCapture(patterns, panelText);
  }
  return out;
}

/**
 * Qualification tags with whether each looked marked. Marking is a visual
 * state, so this is a DOM heuristic: confidence is always low, and the raw
 * className travels with each tag so the heuristic can be corrected.
 */
export function parseQualificationTags(tagElements) {
  return (tagElements || []).map((t) => ({
    text: clean(t.text || ""),
    marked: Boolean(
      TAG_MARKED_CLASS.some((re) => re.test(t.className || "")) || t.hasIcon
    ),
    markedConfidence: "low",
    className: t.className || "",
    hadIcon: Boolean(t.hasIcon)
  })).filter((t) => t.text && t.text.length <= 60);
}

/** The destination link, read from an href and never discovered by clicking. */
export function resolveDestination(links, jobrightUrl) {
  const candidates = (links || []).filter((l) =>
    ORIGINAL_POST_PATTERNS.some((re) => re.test(l.text || "")));

  for (const c of candidates) {
    const href = String(c.href || "");
    if (!UNRESOLVED_HREF.some((re) => re.test(href))) {
      return { destinationUrl: href, resolvesOnOpen: false, via: "original job post href" };
    }
  }
  if (candidates.length) {
    return {
      destinationUrl: jobrightUrl || null,
      resolvesOnOpen: true,
      via: "original job post present but its href does not resolve, so the Jobright URL is stored"
    };
  }
  return {
    destinationUrl: jobrightUrl || null,
    resolvesOnOpen: true,
    via: "no original job post link found, so the Jobright URL is stored"
  };
}

/**
 * @param {object} raw  { panelText, links, tagElements, jobrightUrl }
 */
export function parsePanel(raw) {
  const panelText = String(raw.panelText || "");
  const sections = splitSections(panelText);

  const insider = parseInsider(sections.insider || []);
  const required = bulletsOf(sections.required);
  const preferred = bulletsOf(sections.preferred);

  const record = {
    header: parseHeader(sections.header, panelText),
    match: parseMatch(panelText),
    insider,
    responsibilities: bulletsOf(sections.responsibilities),
    qualificationTags: parseQualificationTags(raw.tagElements),
    required,
    preferred,
    benefits: bulletsOf(sections.benefits),
    companyFacts: parseCompanyFacts(panelText),
    ...resolveDestination(raw.links, raw.jobrightUrl),
    // The text eligibility is actually run against, kept so a verdict is
    // always traceable to what was read.
    eligibilityInput: [...required, ...preferred].join("\n"),
    panelTextLength: panelText.length
  };

  record.missing = [
    ["required", required.length === 0],
    ["preferred", preferred.length === 0],
    ["responsibilities", record.responsibilities.length === 0],
    ["benefits", record.benefits.length === 0],
    ["insider", insider.leads.length === 0 && !Object.values(insider.buckets).some((b) => b.people.length)],
    ["match.overall", record.match.overall === null],
    ["match.subscores", Object.values(record.match.subscores).every((v) => v === null)],
    ["destinationUrl", record.resolvesOnOpen]
  ].filter(([, isMissing]) => isMissing).map(([name]) => name);

  return record;
}
