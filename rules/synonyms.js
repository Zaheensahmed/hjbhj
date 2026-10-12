// rules/synonyms.js -- EDITABLE
// Alternate phrasings for a desired value, so "Yes" still matches an option
// labelled "Yes, I am authorized" and "MD" matches "Maryland".

export const DECLINE_OPTIONS = [
  "decline to self identify",
  "i do not wish to answer",
  "i don't wish to answer",
  "prefer not to say",
  "prefer not to answer",
  "choose not to disclose",
  "i do not want to answer",
  "decline to answer",
  "not disclosed",
  "undisclosed"
];

const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",
  LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
  NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
  OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",
  WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"
};

// Each group is a set of interchangeable surface forms for the same answer.
export const SYNONYM_GROUPS = [
  ["yes", "y", "true", "yes i am", "yes i do", "i am", "i do", "affirmative"],
  ["no", "n", "false", "no i am not", "no i do not", "i am not", "i do not", "negative"],
  ["united states", "united states of america", "usa", "us", "u s", "u s a", "america"],
  [
    "a citizen of the u.s.",
    "a citizen of the us",
    "u.s. citizen",
    "us citizen",
    "united states citizen",
    "citizen",
    "yes i am a citizen of the united states",
    "us citizen or national",
    "u.s. citizen or national"
  ],
  ["bachelor of science", "bachelors degree", "bachelor's degree", "bachelors", "bachelor's", "bs", "undergraduate degree", "bachelor"],
  ["information systems", "information systems management", "management information systems", "mis"],
  ["campus program (intern/co-op)", "internship", "intern", "co-op", "coop", "intern / co-op", "campus program", "student intern"],
  ["online job board", "job board", "job boards", "online", "internet job board", "online posting", "job posting website"],
  ["sophomore", "2nd year", "second year", "sophomore standing"],
  ["junior", "3rd year", "third year", "junior standing", "rising junior"],
  ["negotiable", "open", "flexible", "open to discussion", "doe", "depends on experience"],
  ["monday through friday", "monday - friday", "mon-fri", "weekdays", "full time", "m-f"]
];

const index = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const form of group) {
    const bucket = index.get(form) || new Set();
    for (const f of group) bucket.add(f);
    index.set(form, bucket);
  }
}

/** All surface forms worth trying for a desired value, best first. */
export function expand(candidate) {
  const base = String(candidate ?? "").toLowerCase().trim();
  if (!base) return [];
  const out = [base];
  const push = (v) => { const k = String(v).toLowerCase().trim(); if (k && !out.includes(k)) out.push(k); };

  const group = index.get(base.replace(/[.,'"()]/g, "").replace(/\s+/g, " ").trim()) || index.get(base);
  if (group) for (const f of group) push(f);

  const upper = base.toUpperCase();
  if (STATE_NAMES[upper]) push(STATE_NAMES[upper]);
  for (const [abbr, name] of Object.entries(STATE_NAMES)) {
    if (name.toLowerCase() === base) push(abbr);
  }
  return out;
}
