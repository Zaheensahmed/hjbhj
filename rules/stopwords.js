// rules/stopwords.js -- EDITABLE
// Noise stripped from label text before matching, and words ignored when
// comparing a claim against job-description text.

export const LABEL_NOISE = [
  /\(\s*required\s*\)/gi,
  /\(\s*optional\s*\)/gi,
  /\brequired\b/gi,
  /\boptional\b/gi,
  /\bthis field is required\b/gi,
  /\*/g,
  / /g
];

export const STOPWORDS = new Set([
  "the","a","an","and","or","of","for","to","in","on","at","by","with","from",
  "your","you","our","we","us","this","that","these","those","is","are","was",
  "were","be","been","do","did","does","have","has","had","will","would","can",
  "could","should","may","please","enter","select","provide","list","any","all",
  "most","more","other","using","used","use","its","their","they","as","if","not"
]);
