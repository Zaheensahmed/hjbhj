// rules/jobright-rules.js -- EDITABLE. Everything about reading a Jobright
// board lives here, so fixing a pattern never means touching engine/.
//
// IMPORTANT: these patterns were written without access to a live Jobright
// page. They read card text rather than class names, which survives a CSS
// refactor but still has to be checked against the real thing. Every card the
// scanner finds keeps a raw-text sample, and the popup has a copy button for
// it, so the fix loop is: copy the raw text, correct the pattern here, rescan.

// Containers tried in order. The scanner falls back to a text heuristic when
// none of these match, so a wrong guess here is not fatal.
export const CARD_SELECTORS = [
  "[class*='jobCard']",
  "[class*='job-card']",
  "[data-testid*='job-card']",
  "[class*='JobCard']",
  "li[class*='card']",
  "div[class*='listItem']",
  "article"
];

// A card has to look like a job card before it is treated as one.
export const CARD_EVIDENCE = [
  /\bstart in\b/i,
  /\d+\s*%\s*match/i,
  /\bapplicants?\b/i,
  /\bapply with autofill\b/i,
  /\beasy apply\b/i
];

export const MIN_CARD_TEXT = 40;
export const MAX_CARD_TEXT = 4000;

export const FIELD_PATTERNS = {
  // "Start in 2027 Summer", "Start in Summer 2027", "Summer 2027 start"
  startTerm: [
    /\bstart\s+in\s+(20\d{2})\s+(summer|fall|autumn|winter|spring)\b/i,
    /\bstart\s+in\s+(summer|fall|autumn|winter|spring)\s+(20\d{2})\b/i,
    /\b(summer|fall|autumn|winter|spring)\s+(20\d{2})\s+(?:start|internship|intern|co-?op)\b/i,
    /\bstart\s+in\s+(summer|fall|autumn|winter|spring)\b/i
  ],
  applicants: [
    /\b([\d,]+)\s*\+?\s*applicants?\b/i,
    /\bapplicants?\s*[:\-]?\s*([\d,]+)/i
  ],
  matchPercent: [
    /\b(\d{1,3})\s*%\s*match\b/i,
    /\bmatch\s*(?:score)?\s*[:\-]?\s*(\d{1,3})\s*%/i
  ],
  matchLabel: [
    /\b(strong|good|fair|weak|great|excellent|low)\s+match\b/i
  ],
  posted: [
    /\b(re)?posted\s+(?:about\s+)?(\d+)\s+(minute|hour|day|week|month)s?\s+ago\b/i,
    /\b(re)?posted\s+(today|yesterday)\b/i
  ],
  pay: [
    /\$\s?[\d,]+(?:\.\d{2})?\s*(?:-|to|–|—)\s*\$?\s?[\d,]+(?:\.\d{2})?\s*(?:\/\s*|per\s+)?(?:hr|hour|yr|year|annually)?/i,
    /\$\s?[\d,]+(?:\.\d{2})?\s*(?:\/\s*|per\s+)(?:hr|hour|yr|year)/i
  ],
  arrangement: [
    /\b(remote|hybrid|on-?site|in-?person|in\s+office)\b/i
  ],
  jobType: [
    /\b(internship|intern|co-?op|full[- ]time|part[- ]time|contract|temporary|apprenticeship)\b/i
  ],
  // "Your City, MD", "New York, NY", "Remote, US"
  location: [
    /\b([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3},\s*(?:[A-Z]{2}\b|[A-Z][a-z]+\b))/
  ],
  alumni: [
    /\b(\d+)\s+(?:school\s+)?alumni\b/i,
    /\b(\d+)\s+(?:people\s+)?from\s+your\s+school\b/i,
    /\byour\s+school\s*[:\-]?\s*(\d+)\b/i
  ],
  earlyApplicant: [
    /\bearly\s+applicant\b/i
  ]
};

// Exact tags shown in the match panel. Matched case-insensitively as whole
// phrases against the card text.
export const MATCH_PANEL_TAGS = [
  "Security Clearance",
  "U.S. Citizen Only",
  "US Citizen Only",
  "No H1B",
  "H1B Sponsor Likely",
  "Growth Opportunities",
  "Entry Level",
  "Experience Level",
  "Skill Match",
  "Education Match",
  "Advanced Degree",
  "Remote",
  "Hybrid",
  "Onsite"
];

// Apply affordances. The scanner records which is present. NOTHING in this
// codebase clicks any of them.
export const APPLY_BUTTONS = [
  { id: "autofill", label: "Apply with Autofill", patterns: [/\bapply\s+with\s+autofill\b/i] },
  { id: "easy", label: "Easy Apply", patterns: [/\beasy\s+apply\b/i] },
  { id: "external", label: "Apply Now", patterns: [/\bapply\s+now\b/i, /\bapply\s+externally\b/i] }
];

// Links we treat as a Jobright listing URL, used as the storage key.
export const LISTING_HREF_PATTERNS = [
  /\/jobs\/info\//i,
  /\/job\/[a-z0-9-]+/i,
  /jobright\.ai\/.*\b(job|jobs)\b/i
];

// -------------------------------------------------------------- triage inputs

export const SUMMER_TERMS = ["summer"];
export const TERM_TIME_TERMS = ["fall", "autumn", "winter", "spring"];

// Commutable from your campus. Everything else counts as far. eligibility_filters
// records school-year on-site away from your campus as a hard blocker, and
// always_viable allows remote any term and local flexible term-time.
export const NEAR_your campus = [
  /\bmaryland\b/i, /\bmd\b/, /\bbaltimore\b/i, /\bcatonsville\b/i, /\bcolumbia\b/i,
  /\bellicott city\b/i, /\btowson\b/i, /\bhanover\b/i, /\blinthicum\b/i, /\bannapolis\b/i,
  /\bfort meade\b/i, /\bft\.? meade\b/i, /\baberdeen\b/i, /\bbethesda\b/i, /\brockville\b/i,
  /\bsilver spring\b/i, /\bgaithersburg\b/i, /\bgermantown\b/i, /\bclarksburg\b/i,
  /\bwashington,?\s*d\.?c\.?\b/i, /\bdistrict of columbia\b/i,
  /\barlington\b/i, /\balexandria\b/i, /\btysons\b/i, /\bmclean\b/i, /\breston\b/i,
  /\bherndon\b/i, /\bfairfax\b/i, /\bvienna,?\s*va\b/i, /\bfalls church\b/i,
  /\bchantilly\b/i, /\bspringfield,?\s*va\b/i, /\bquantico\b/i, /\bnorthern virginia\b/i
];

export const REMOTE_PATTERNS = [/\bremote\b/i, /\bwork from home\b/i, /\bwfh\b/i];
export const ONSITE_PATTERNS = [/\bon-?site\b/i, /\bin-?person\b/i, /\bin\s+office\b/i];
export const HYBRID_PATTERNS = [/\bhybrid\b/i];

// A field that is only worth a boost when the pool is genuinely small.
export const LOW_APPLICANT_THRESHOLD = 25;

// Ranking weights. Verdict dominates; these only order within a verdict.
export const WEIGHTS = {
  citizenOnly: 3,
  earlyApplicant: 2,
  lowApplicants: 2,
  alumni: 4,
  matchPercent: 0.05,
  clearanceFlag: -2,
  missingTerm: -1
};

/**
 * A JSON-safe copy for crossing into a content script.
 *
 * chrome.scripting.executeScript args must be JSON-serializable, and a RegExp
 * serializes to {}. Every pattern becomes {source, flags}, which the scanner
 * rebuilds. RegExp itself exposes .source and .flags, so the scanner's code
 * reads both shapes identically.
 */
export function toPlain() {
  const conv = (v) => {
    if (v instanceof RegExp) return { source: v.source, flags: v.flags };
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = conv(val);
      return out;
    }
    return v;
  };
  return conv({
    CARD_SELECTORS, CARD_EVIDENCE, MIN_CARD_TEXT, MAX_CARD_TEXT,
    FIELD_PATTERNS, MATCH_PANEL_TAGS, APPLY_BUTTONS, LISTING_HREF_PATTERNS
  });
}
