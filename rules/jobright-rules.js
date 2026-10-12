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
  // "Baltimore, MD", "New York, NY", "Remote, US"
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

// Commutable from your campus. Everything else counts as far.
// eligibility_filters records a school-year on-site role away from campus as a
// hard blocker, and always_viable allows remote any term and local flexible
// term-time. Edit this list to match where you actually are.
export const NEAR_HOME = [
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
  // EVERYTHING an injected content script reads off `rules.` has to be here.
  // It is not enough to add a rule above: a content script cannot import this
  // module, so anything missing here arrives as undefined and the script throws
  // on first use. test/smoke.mjs cross-checks this list against every
  // `rules.X` in content/, which is the check that was missing when the
  // stage-2 rules were added and silently never sent.
  return conv({
    // stage 1, board scan
    CARD_SELECTORS, CARD_EVIDENCE, MIN_CARD_TEXT, MAX_CARD_TEXT,
    FIELD_PATTERNS, MATCH_PANEL_TAGS, APPLY_BUTTONS, LISTING_HREF_PATTERNS,
    // stage 2, detail panel harvest and the DOM dump
    PANEL_EVIDENCE, PANEL_SELECTORS, CLOSE_SELECTORS, CLOSE_TEXTS,
    FORBIDDEN_CLICK, ORIGINAL_POST_PATTERNS, UNRESOLVED_HREF,
    SECTION_HEADINGS, INSIDER_BUCKETS, MATCH_SUBSCORES, TAG_MARKED_CLASS,
    HARVEST
  });
}

// ============================================================== stage 2
// Detail-panel harvest. Same caveat as above: written without a live page.

// A detail panel is recognised by its own content, not its class name.
export const PANEL_EVIDENCE = [
  /\binsider connection\b/i,
  /\bqualification\b/i,
  /\boriginal job post\b/i,
  /\bresponsibilit(?:y|ies)\b/i
];

export const PANEL_SELECTORS = [
  "[class*='drawer']",
  "[class*='Drawer']",
  "[class*='detail']",
  "[class*='Detail']",
  "[role='dialog']",
  "aside",
  "[class*='panel']"
];

// The X at top-left of the panel. Candidates are filtered by FORBIDDEN_CLICK
// first, then the one nearest the panel's top-left corner wins.
export const CLOSE_SELECTORS = [
  "[aria-label*='close' i]",
  "[title*='close' i]",
  "[class*='close']",
  "[class*='Close']",
  "button"
];
export const CLOSE_TEXTS = [/^[\u00d7\u2715\u2716\u2717\u274c x]$/i, /^close$/i];

// NOTHING matching these is ever clicked, whatever else matches. safeClick()
// in content/jobright-harvest.js refuses and records a refusal.
export const FORBIDDEN_CLICK = [
  /apply\s*with\s*autofill/i,
  /easy\s*apply/i,
  /apply\s*now/i,
  /quick\s*apply/i,
  /\bapply\b/i,
  /\bsave\b/i,
  /\bdismiss\b/i,
  /\bhide\b/i,
  /not\s*interested/i,
  /find\s*any\s*email/i,
  /\breport\s*issue\b/i,
  /\bshare\b/i,
  /did\s*you\s*apply/i,
  /\bmark\s*as\s*applied\b/i,
  /\bsubmit\b/i,
  /\bupgrade\b/i,
  /\bsubscribe\b/i
];

// Section headings, matched against whole lines of the panel's text.
export const SECTION_HEADINGS = [
  { key: "insider", patterns: [/^insider connection/i] },
  { key: "responsibilities", patterns: [/^responsibilit(?:y|ies)\b/i] },
  { key: "qualification", patterns: [/^qualification/i] },
  { key: "required", patterns: [/^required\b/i, /^requirements?\b/i, /^minimum qualifications?\b/i] },
  { key: "preferred", patterns: [/^preferred\b/i, /^nice to have\b/i, /^preferred qualifications?\b/i] },
  { key: "benefits", patterns: [/^benefits?\b/i, /^perks?\b/i, /^compensation and benefits\b/i] },
  { key: "company", patterns: [/^company\b/i, /^about (?:the )?company\b/i, /^about us\b/i] }
];

export const INSIDER_BUCKETS = [
  { key: "beyond_network", patterns: [/^beyond your network/i] },
  { key: "previous_company", patterns: [/^from your previous compan(?:y|ies)/i] },
  { key: "school", patterns: [/^from your school/i] }
];

// Affiliation lines under an insider name.
export const AFFILIATION_PATTERNS = [
  /^previously\s*@\s*(.+)$/i,
  /^@\s*(.+)$/,
  /^(?:currently\s*)?at\s+(.+)$/i
];

// The match panel's overall score and its three sub-scores, captured separately.
export const MATCH_SUBSCORES = [
  { key: "experienceLevel", label: "Experience Level", patterns: [/experience\s*level\D{0,20}(\d{1,3})\s*%/i, /experience\s*level\s*[:\-]?\s*(low|fair|good|strong|high|excellent)\b/i] },
  { key: "skill", label: "Skill", patterns: [/skills?\s*(?:match)?\D{0,20}(\d{1,3})\s*%/i, /skills?\s*(?:match)?\s*[:\-]?\s*(low|fair|good|strong|high|excellent)\b/i] },
  { key: "educationMatch", label: "Education Match", patterns: [/education\s*(?:match)?\D{0,20}(\d{1,3})\s*%/i, /education\s*(?:match)?\s*[:\-]?\s*(low|fair|good|strong|high|excellent)\b/i] }
];

export const OVERALL_MATCH_PATTERNS = [
  /\b(\d{1,3})\s*%\s*match\b/i,
  /\bmatch\s*score\D{0,10}(\d{1,3})\s*%/i
];

export const ORIGINAL_POST_PATTERNS = [/original\s*job\s*post/i, /view\s*original/i, /original\s*posting/i];

// Hrefs that are not a real destination, so the Jobright URL is stored instead
// and the record is marked "resolves on open".
export const UNRESOLVED_HREF = [/^#/, /^javascript:/i, /^$/, /^about:blank$/i];

export const COMPANY_FACT_PATTERNS = {
  founded: [/\bfounded\s*(?:in)?\s*[:\-]?\s*(\d{4})/i],
  headquarters: [/\b(?:headquarters|hq|headquartered in)\s*[:\-]?\s*([^\n]{3,60})/i],
  employees: [/\b([\d,]+(?:\s*-\s*[\d,]+)?\+?)\s*employees\b/i, /\bemployees?\s*[:\-]\s*([^\n]{1,40})/i],
  website: [/\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:com|io|ai|net|org|co)(?:\/[^\s]*)?)/i],
  glassdoor: [/\bglassdoor\D{0,20}([0-5](?:\.\d)?)\b/i],
  funding: [/\b(series\s+[a-z]|seed|ipo|public|bootstrapped|acquired)\b/i]
};

// A tag in the qualification row that you already hold is visually marked.
// Marking cannot be read from text, so these are DOM heuristics and every
// result carries low confidence plus the raw className for correcting them.
export const TAG_MARKED_CLASS = [/match/i, /active/i, /selected/i, /checked/i, /owned/i, /\bhave\b/i, /highlight/i, /success/i];

export const HARVEST = {
  // Wall-clock budget for one panel to render.
  renderTimeoutMs: 15000,
  // A hidden tab has its timers throttled, so sleeps stretch. The budget is
  // multiplied rather than the slowness being treated as a failure.
  hiddenMultiplier: 4,
  // Never fail before polling this many times, however long the gaps were.
  minPolls: 4,
  pollMs: 250,
  // Randomized gap between cards.
  gapMinMs: 3000,
  gapMaxMs: 6000,
  // Hard caps on one run.
  maxCards: 60,
  maxRunMs: 45 * 60 * 1000,
  // Give up on a card after this many consecutive failures.
  maxConsecutiveFailures: 5
};
