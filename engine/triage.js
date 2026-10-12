// engine/triage.js -- PURE. Stage-1 verdicts from structured card fields only.
//
// Stage 1 has no job description text. It therefore cannot check graduation
// windows, institution restrictions or anything else that lives in prose, and
// the best verdict it can reach is REVIEW. There is deliberately no APPLY
// verdict in this module: VERDICTS has two members and nothing can widen it.
import {
  SUMMER_TERMS, TERM_TIME_TERMS, NEAR_HOME, REMOTE_PATTERNS, ONSITE_PATTERNS,
  LOW_APPLICANT_THRESHOLD, WEIGHTS
} from "../rules/jobright-rules.js";

/** The complete set. Stage 1 never says apply. */
export const VERDICTS = ["REVIEW", "SKIP"];

const isSummer = (term) => Boolean(term) && SUMMER_TERMS.includes(term.season);
const isTermTime = (term) => Boolean(term) && TERM_TIME_TERMS.includes(term.season);

function nearHome(location) {
  if (!location) return null;
  return NEAR_HOME.some((re) => re.test(location));
}

function arrangementOf(card) {
  if (card.arrangement) return card.arrangement.toLowerCase();
  const text = card.rawText || "";
  if (REMOTE_PATTERNS.some((re) => re.test(text))) return "remote";
  if (ONSITE_PATTERNS.some((re) => re.test(text))) return "onsite";
  return null;
}

function hasTag(card, name) {
  return (card.tags || []).some((t) => t.toLowerCase().replace(/[.\s]/g, "") === name.toLowerCase().replace(/[.\s]/g, ""));
}

/**
 * @param {object} card  a scanned card
 * @returns {{verdict:string, score:number, reasons:Array, flags:Array, boosts:Array, referralLead:object|null, missing:string[]}}
 */
export function triageCard(card) {
  const reasons = [];
  const flags = [];
  const boosts = [];
  let score = 0;
  let verdict = "REVIEW";

  const term = card.startTerm || null;
  const arrangement = arrangementOf(card);
  const near = nearHome(card.location);

  // ---- SKIP: the start term is not summer.
  if (term && !isSummer(term)) {
    verdict = "SKIP";
    reasons.push({
      kind: "skip",
      code: "term_not_summer",
      text: `Start term is ${term.label}. Winter and spring terms are term-time and conflict with full-time enrollment at your campus.`
    });
  }

  // ---- SKIP: onsite, term-time, and far from Baltimore.
  if (arrangement === "onsite" && (isTermTime(term) || (!term && card.location)) && near === false) {
    verdict = "SKIP";
    reasons.push({
      kind: "skip",
      code: "onsite_termtime_far",
      text: `Onsite in ${card.location}${term ? ` for a ${term.label} term` : ""}, which is not commutable from your campus. eligibility_filters lists a school-year on-site role away from campus as a hard blocker.`
    });
  }

  // ---- FLAG: security clearance.
  if (hasTag(card, "Security Clearance")) {
    flags.push({
      code: "clearance",
      text: "Security Clearance tag present. You hold none now, though you are eligible as a U.S. citizen. Stage 2 has to read whether it is required at application or only to start."
    });
    score += WEIGHTS.clearanceFlag;
  }

  // ---- BOOST: citizen-only narrows the field in your favour.
  if (hasTag(card, "U.S. Citizen Only") || hasTag(card, "US Citizen Only")) {
    boosts.push({ code: "citizen_only", text: "U.S. Citizen Only. You qualify, and it thins the applicant pool." });
    score += WEIGHTS.citizenOnly;
  }

  // ---- BOOST: early, or a small pool.
  if (card.earlyApplicant) {
    boosts.push({ code: "early_applicant", text: "Early applicant badge." });
    score += WEIGHTS.earlyApplicant;
  }
  if (typeof card.applicants === "number" && card.applicants <= LOW_APPLICANT_THRESHOLD) {
    boosts.push({ code: "low_applicants", text: `${card.applicants} applicants, at or under the ${LOW_APPLICANT_THRESHOLD} threshold.` });
    score += WEIGHTS.lowApplicants;
  }

  // ---- BOOST: alumni present, which is a referral lead.
  let referralLead = null;
  if (typeof card.alumni === "number" && card.alumni > 0) {
    referralLead = { kind: "school", count: card.alumni, text: `${card.alumni} alumni from your school at this company. Worth a referral ask before applying cold.` };
    boosts.push({ code: "alumni", text: referralLead.text });
    score += WEIGHTS.alumni;
  }

  if (typeof card.matchPercent === "number") score += card.matchPercent * WEIGHTS.matchPercent;

  // ---- notes, which never change the verdict
  const missing = [];
  for (const f of ["title", "company", "location", "startTerm", "listingUrl"]) {
    if (card[f] == null || card[f] === "") missing.push(f);
  }
  if (!term) {
    reasons.push({
      kind: "note",
      code: "term_unknown",
      text: "No start term found on the card. Not skipped on a guess, but check it in stage 2."
    });
    score += WEIGHTS.missingTerm;
  }
  if (near === null && arrangement === "onsite") {
    reasons.push({ kind: "note", code: "location_unknown", text: "Onsite but no location parsed, so the commute could not be judged." });
  }
  if (arrangement === "remote") {
    reasons.push({ kind: "note", code: "remote", text: "Remote, which eligibility_filters.always_viable allows in any term." });
  }
  if (missing.length) {
    reasons.push({ kind: "note", code: "fields_missing", text: `Could not read: ${missing.join(", ")}. Patterns may need correcting in rules/jobright-rules.js.` });
  }

  for (const f of flags) reasons.push({ kind: "flag", code: f.code, text: f.text });
  for (const b of boosts) reasons.push({ kind: "boost", code: b.code, text: b.text });

  if (verdict === "REVIEW") {
    reasons.unshift({
      kind: "verdict",
      code: "review_only",
      text: "REVIEW. Stage 1 has no job description text, so graduation windows and institution restrictions are unchecked. This is the best verdict stage 1 can give."
    });
  }

  return { verdict, score: Number(score.toFixed(3)), reasons, flags, boosts, referralLead, missing };
}

/**
 * Triage a whole board. Dismissed listing URLs are dropped.
 * @param {Array} cards
 * @param {{dismissed?:object, shortlist?:object}} store
 */
export function triageAll(cards, store = {}) {
  const dismissed = store.dismissed || {};
  const shortlist = store.shortlist || {};

  const rows = cards
    .filter((c) => !(c.listingUrl && dismissed[c.listingUrl]))
    .map((card) => ({
      card,
      ...triageCard(card),
      shortlisted: Boolean(card.listingUrl && shortlist[card.listingUrl])
    }));

  rows.sort((a, b) => {
    const rank = (r) => (r.verdict === "REVIEW" ? 0 : 1);
    return rank(a) - rank(b) ||
      b.score - a.score ||
      String(a.card.company || "").localeCompare(String(b.card.company || ""));
  });

  return {
    rows,
    counts: {
      total: cards.length,
      shown: rows.length,
      dismissed: cards.length - rows.length,
      review: rows.filter((r) => r.verdict === "REVIEW").length,
      skip: rows.filter((r) => r.verdict === "SKIP").length,
      flagged: rows.filter((r) => r.flags.length).length,
      referralLeads: rows.filter((r) => r.referralLead).length,
      incomplete: rows.filter((r) => r.missing.length).length
    }
  };
}
