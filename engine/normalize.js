// engine/normalize.js -- PURE. No DOM, no chrome.*
import { LABEL_NOISE, STOPWORDS } from "../rules/stopwords.js";

export function squash(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Collapse runs of spaces and tabs but keep single newlines, so a bullet list
 * stays a bullet list. Blank-line runs collapse to one.
 */
export function squashLines(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Label text as the matcher sees it. */
export function normLabel(s) {
  let t = squash(s);
  for (const re of LABEL_NOISE) t = t.replace(re, " ");
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  t = t.replace(/[?:;.,]+$/, "").trim();
  return t;
}

/** Option text for comparison against a desired value. */
export function normOption(s) {
  return normLabel(s).replace(/[.,'"()]/g, "").replace(/\s+/g, " ").trim();
}

/** Content words, for job-description overlap scoring. */
export function termsOf(s) {
  return squash(s)
    .toLowerCase()
    .split(/[^a-z0-9+#./_-]+/)
    .map((w) => w.replace(/^[-_.]+|[-_.]+$/g, ""))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(36);
}

/**
 * Turn a concrete label into a reusable pattern by wildcarding the volatile
 * parts: years, dollar amounts, bare numbers, and quoted strings. Used so a
 * learned answer for "Why do you want to work at Acme (2027)?" also matches
 * the 2028 posting.
 */
export function derivePattern(labelNorm) {
  return labelNorm
    .replace(/\b(19|20)\d{2}\b/g, "{{year}}")
    .replace(/\$\s?[\d,.]+/g, "{{money}}")
    .replace(/\b\d+\b/g, "{{n}}")
    .replace(/["“”'][^"“”']{2,40}["“”']/g, "{{quoted}}");
}

export function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\\\{\\\{year\\\}\\\}/g, "(?:19|20)\\d{2}")
    .replace(/\\\{\\\{money\\\}\\\}/g, "\\$?[\\d,.]+")
    .replace(/\\\{\\\{n\\\}\\\}/g, "\\d+")
    .replace(/\\\{\\\{quoted\\\}\\\}/g, ".{2,40}");
  return new RegExp("^" + body + "$");
}
