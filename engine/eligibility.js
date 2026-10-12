// engine/eligibility.js -- PURE. Runs before anything is assembled.
//
// Every finding carries the sentence it matched, verbatim, so you are judging
// the posting rather than my regex. A hard blocker stops assembly; the popup
// offers an override if you disagree.
import { HARD_DETECTORS, SOFT_DETECTORS } from "../rules/eligibility-rules.js";
import { squash } from "./normalize.js";

/**
 * The smallest readable unit around a match. A newline is as strong a boundary
 * as a full stop, because requirements usually arrive as bullets, and "3.0" is
 * not the end of a sentence.
 */
function sentenceAround(text, index, len) {
  const isBoundary = (i) => {
    const c = text[i];
    if (c === "\n") return true;
    if (c !== ".") return false;
    return !/\d/.test(text[i + 1] || " ") || !/\d/.test(text[i - 1] || " ");
  };
  let start = 0;
  for (let i = index - 1; i >= 0; i--) if (isBoundary(i)) { start = i + 1; break; }
  let end = text.length - 1;
  for (let i = index + len; i < text.length; i++) if (isBoundary(i)) { end = i; break; }
  return squash(text.slice(start, end + 1)).replace(/^[-*\u2022\s]+/, "").slice(0, 320);
}

function runFinders(detector, text) {
  const out = [];
  for (const re of detector.find) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = rx.exec(text)) !== null) {
      out.push({ matched: squash(m[0]), sentence: sentenceAround(text, m.index, m[0].length) });
      if (rx.lastIndex === m.index) rx.lastIndex++;
      if (out.length >= 4) break;
    }
    if (out.length >= 4) break;
  }
  return out;
}

export function checkEligibility(profile, posting) {
  const text = posting && posting.text ? posting.text : "";
  const blockers = [];
  const flags = [];
  const cleared = [];

  if (!text || text.length < 200) {
    return {
      blocked: false,
      insufficientText: true,
      blockers: [], flags: [], cleared: [],
      note: "Not enough posting text to check eligibility. Paste the job description into the box above and rescan."
    };
  }

  for (const d of HARD_DETECTORS) {
    const hits = runFinders(d, text);
    if (!hits.length) continue;
    for (const hit of hits) {
      const judged = d.judge(hit.matched, profile, posting);
      const row = {
        id: d.id, filter: d.filter, confidence: d.confidence,
        matched: hit.matched, sentence: hit.sentence, why: judged.why
      };
      if (judged.verdict === "blocked") blockers.push(row);
      else if (judged.verdict === "unclear") flags.push({ ...row, argue: judged.why, unclear: true });
      else cleared.push(row);
    }
  }

  for (const d of SOFT_DETECTORS) {
    const hits = runFinders(d, text);
    for (const hit of hits) {
      flags.push({
        id: d.id, filter: d.filter,
        matched: hit.matched, sentence: hit.sentence,
        argue: d.argue(profile, posting)
      });
    }
  }

  const dedupe = (rows) => {
    const seen = new Set();
    return rows.filter((r) => {
      const k = r.id + "|" + r.matched;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    blocked: blockers.length > 0,
    insufficientText: false,
    blockers: dedupe(blockers),
    flags: dedupe(flags),
    cleared: dedupe(cleared),
    alwaysViable: profile.eligibility_filters.always_viable,
    note: null
  };
}
