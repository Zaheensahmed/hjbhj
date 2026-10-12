// rules/field-rules.js -- EDITABLE. This is the file to change when a form
// stumps the extension. Pure data and pure functions. No DOM, no chrome.*,
// no engine logic.
//
// A rule:
//   id        stable name, shown in the popup next to each filled field
//   any       label patterns, at least one must hit
//   not       label patterns, any hit disqualifies the rule
//   types     optional gate on input type ("text", "email", "tel", ...)
//   tags      optional gate on field shape ("select", "radiogroup", "textarea", ...)
//   autocomplete  exact autocomplete attribute values, the strongest signal there is
//   resolve   how to produce the value, see below
//   base      confidence before the label-strategy weight is applied
//
// resolve.kind:
//   "path"      dotted path into the profile
//   "const"     literal
//   "choose"    ordered candidate list, fuzzy-matched against the real options
//   "fn"        pure function of { profile, field, posting, prefs }
//   "assemble"  hand off to the assembler, target "skills" or "lead_bullets"
//   "eeo"       never filled, listed under "your call" with the decline option
//   "manual"    never filled, listed with a note explaining why
//
// A resolver function may return:
//   "string"                        a value
//   { value, note?, tierCap? }      a value with a caveat, optionally capped to review tier
//   { candidates, rejectOption?, note? }   option matching, rejectOption vetoes options
//   { manual: true, note }          refuse to fill, explain
//   { leaveBlank: true, note }      deliberately blank, explain
//   null                            no answer, field becomes unknown

export const TIERS = { CONFIDENT: 0.75, REVIEW: 0.45 };

const isChoice = (f) => f.tag === "select" || f.tag === "radiogroup";
const yearOf = (s) => (String(s).match(/\b(20\d{2})\b/) || [])[1] || null;

// ---------------------------------------------------------------- resolvers

function gpa({ field, profile }) {
  const e = profile.education;
  const L = field.labelNorm;
  if (/high school|hs\b|secondary school/.test(L)) {
    const wantsWeighted = /weighted/.test(L) && !/unweighted/.test(L);
    const allowsAbove4 = field.max != null && Number(field.max) > 4;
    return {
      value: wantsWeighted || allowsAbove4 ? e.high_school_gpa_weighted : e.high_school_gpa_unweighted,
      note: e.gpa_rule
    };
  }
  if (/college|university|cumulative|current|major/.test(L)) {
    return { manual: true, note: `No college GPA to give. ${e.college_gpa}. If the form will not accept blank, say so in the field or leave it for a human.` };
  }
  // Unqualified "GPA" on a student application almost always means college.
  return {
    manual: true,
    note: `Unqualified GPA field. ${e.college_gpa} High school unweighted was ${e.high_school_gpa_unweighted}, weighted ${e.high_school_gpa_weighted}. Decide which this form wants.`
  };
}

function major({ field, profile }) {
  const e = profile.education;
  if (isChoice(field)) {
    return {
      candidates: [e.field_of_study_dropdown_primary, e.field_of_study_dropdown_fallback],
      rejectOption: /cyber/i,
      note: e.field_of_study_NEVER_SELECT
    };
  }
  return { value: e.major };
}

function gradDate({ field, profile }) {
  const e = profile.education;
  const L = field.labelNorm;
  const ph = (field.placeholder || "").toLowerCase();

  if (isChoice(field)) {
    if (/month/.test(L)) return { candidates: ["May", "05", "5"] };
    if (/year/.test(L)) return { candidates: ["2029"] };
    return { candidates: ["May 2029", "2029", "05/2029", "05/29"] };
  }
  if (field.type === "month") return { value: "2029-05" };
  if (field.type === "date" || /mm\s*\/\s*dd\s*\/\s*yyyy|dd\s*\/\s*mm/.test(ph)) {
    return { manual: true, note: `Form wants a full calendar date. The profile has ${e.expected_graduation} with no day. Pick a day yourself.` };
  }
  if (/mm\s*\/\s*yy\b/.test(ph)) return { value: e.graduation_mm_yy };
  if (/mm\s*\/\s*yyyy/.test(ph)) return { value: "05/2029" };
  if (/year/.test(L) && !/month/.test(L)) return { value: yearOf(e.expected_graduation) };
  return { value: e.expected_graduation };
}

function classStanding({ profile }) {
  const e = profile.education;
  return {
    candidates: [e.current_class_standing.replace(/\s*\(.*\)$/, ""), e.class_standing_fall_2027],
    tierCap: TIERS.REVIEW,
    note: `${e.class_year_explanation} Current standing is ${e.current_class_standing}. From fall 2027 it is ${e.class_standing_fall_2027}. Which one this form wants depends on the term it is asking about.`
  };
}

function clearanceEligible({ field, profile }) {
  const w = profile.work_authorization;
  return isChoice(field)
    ? { candidates: ["Yes"], note: w.clearance_eligible }
    : { value: "Yes", note: w.clearance_eligible };
}

function selectiveService({ profile }) {
  return {
    manual: true,
    note: `NOT auto-filled on purpose. Profile says: "${profile.work_authorization.selective_service_registered}" Verify at sss.gov and answer this one yourself.`
  };
}

function relocate({ profile, posting }) {
  const rule = profile.standard_answers.willing_to_relocate;
  if (posting && posting.term === "summer") {
    return { value: "Yes", note: `Posting reads as a summer term. ${rule}` };
  }
  return { manual: true, note: `${rule} The term did not read as summer, so this answer depends on the role. Yours to call.` };
}

function salary({ field, profile, posting }) {
  const c = profile.compensation_rules;
  if (posting && posting.payRange) {
    return {
      value: posting.payRange.top,
      tierCap: TIERS.REVIEW,
      note: `${c.if_range_posted} Detected in the posting: ${posting.payRange.raw}`
    };
  }
  if (isChoice(field)) {
    return { candidates: ["Negotiable", "Open", "Prefer not to say"], note: c.if_bracket_dropdown_with_optout };
  }
  if (!field.required) {
    return { leaveBlank: true, note: `${c.if_optional_and_rate_fixed} ${c.if_no_range_posted}` };
  }
  return { value: "Negotiable", tierCap: TIERS.REVIEW, note: c.if_no_range_posted };
}

function certifications({ profile }) {
  const active = profile.certifications.filter((c) => c.status === "Active");
  return {
    value: active.map((c) => c.name).join(", "),
    tierCap: TIERS.REVIEW,
    note: active.map((c) => `${c.name} (ID ${c.credential_id}, ${c.issued})`).join(" / ")
  };
}

function essay({ profile }) {
  return {
    manual: true,
    note: "Free-text essay. The assembler only selects and orders claims you already wrote, so it cannot draft this. Assembled material for this posting is listed above as reference. Per writing_rules, cover letters are one page, four paragraphs, drafted as text before any PDF."
  };
}

function orgList({ profile, prefs }) {
  const items = profile.extracurriculars.map((x) => {
    const name = prefs && prefs.useGenericOrgName && x.org_generic_variant ? x.org_generic_variant : x.org;
    return `${name}, ${x.role}`;
  });
  const hasVariant = profile.extracurriculars.some((x) => x.org_generic_variant);
  return {
    value: items.join("; "),
    tierCap: TIERS.REVIEW,
    note: hasVariant
      ? "One of these has a generic variant available. Applications often say you need not name organizations indicating race, ancestry or ethnic origin. Toggle it in the popup if you want the generic form."
      : null
  };
}

function reference({ profile, field }) {
  const r = profile.standard_answers.references[0];
  if (!r) return null;
  const L = field.labelNorm;
  if (/e-?mail/.test(L)) return { value: r.email };
  if (/title|position|role/.test(L)) return { value: r.title };
  if (/organization|company|employer|institution/.test(L)) return { value: r.org };
  if (/relationship|how do you know/.test(L)) return { value: r.relationship };
  if (/phone/.test(L)) return { manual: true, note: `No phone on file for ${r.name}. Ask him before giving one out.` };
  return { value: r.name };
}

function supervisorFor(id) {
  return ({ profile, field }) => {
    const e = profile.experience.find((x) => x.id === id) || profile.experience[0];
    const L = field.labelNorm;
    if (/e-?mail/.test(L)) return { value: e.supervisor_email };
    if (/phone/.test(L)) return { manual: true, note: `No phone on file for ${e.supervisor}.` };
    if (/title/.test(L)) return { value: "Research Advisor", tierCap: TIERS.REVIEW };
    if (/may we contact|ok to contact|permission/.test(L)) return { candidates: ["Yes"] };
    return { value: e.supervisor };
  };
}

// ---------------------------------------------------------------- the rules

export const FIELD_RULES = [
  // ---- identity
  { id: "first_name", autocomplete: ["given-name"], any: [/\bfirst name\b/, /\bgiven name\b/, /\blegal first\b/, /^fname$/], not: [/last|family|sur/], resolve: { kind: "path", path: "identity.first_name" }, base: 0.95 },
  { id: "last_name", autocomplete: ["family-name"], any: [/\blast name\b/, /\bfamily name\b/, /\bsurname\b/, /^lname$/], not: [/first|given/], resolve: { kind: "path", path: "identity.last_name" }, base: 0.95 },
  { id: "full_name", autocomplete: ["name"], any: [/^(?:full |legal |your )?name$/, /\bfull name\b/, /\blegal name\b/], not: [/first|last|middle|preferred|user|file|company|school|reference|supervisor|employer/], resolve: { kind: "path", path: "identity.full_name" }, base: 0.9 },
  { id: "preferred_name", any: [/preferred (?:first )?name/, /\bnickname\b/, /what should we call you/], resolve: { kind: "path", path: "identity.first_name" }, base: 0.7 },
  { id: "email", autocomplete: ["email"], types: ["text", "email"], any: [/\be-?mail\b/], not: [/confirm|verify|re-?enter|re-?type|secondary|alternate|reference|supervisor|school|work e-?mail/], resolve: { kind: "path", path: "identity.email" }, base: 0.95 },
  { id: "email_confirm", types: ["text", "email"], any: [/(?:confirm|verify|re-?enter|re-?type)[^a-z]{0,8}e-?mail/, /e-?mail[^a-z]{0,8}(?:confirm|verif)/], resolve: { kind: "path", path: "identity.email" }, base: 0.9 },
  { id: "phone", autocomplete: ["tel", "tel-national"], types: ["text", "tel"], any: [/\bphone\b/, /\bmobile\b/, /\bcell\b/, /\btelephone\b/], not: [/extension|\bext\b|country code|reference|supervisor|emergency|work phone/], resolve: { kind: "path", path: "identity.phone" }, base: 0.95 },
  { id: "address1", autocomplete: ["street-address", "address-line1"], any: [/street address/, /address line 1/, /^address$/, /mailing address/, /^address 1$/], not: [/line 2|apt|suite|unit|e-?mail|city|state|zip|postal|country/], resolve: { kind: "path", path: "identity.street_address" }, base: 0.9 },
  { id: "city", autocomplete: ["address-level2"], any: [/^city$/, /\bcity\b/, /city\/town/, /\btown\b/], not: [/school|university|college|employer|company|birth|reference|high school/], resolve: { kind: "path", path: "identity.city" }, base: 0.9 },
  { id: "state", autocomplete: ["address-level1"], any: [/^state$/, /\bstate\b/, /state\/province/, /\bprovince\b/, /\bregion\b/], not: [/school|university|college|employer|company|birth|united states|reference|high school/], resolve: { kind: "choose", candidates: ["MD", "Maryland"] }, base: 0.9 },
  { id: "zip", autocomplete: ["postal-code"], any: [/\bzip\b/, /zip code/, /postal code/, /\bpostcode\b/], resolve: { kind: "path", path: "identity.zip" }, base: 0.95 },
  { id: "country", autocomplete: ["country", "country-name"], any: [/^country$/, /\bcountry\b/], not: [/code|citizenship|birth|origin/], resolve: { kind: "choose", candidates: ["United States", "United States of America", "USA", "US"] }, base: 0.9 },
  { id: "linkedin", any: [/linkedin/], resolve: { kind: "path", path: "identity.linkedin" }, base: 0.95 },

  // ---- work authorization
  { id: "authorized_to_work", any: [/legally authorized to work/, /authorized to work/, /work authorization/, /eligible to work/, /right to work/], not: [/sponsorship|visa|future/], resolve: { kind: "choose", candidates: ["Yes"] }, base: 0.9 },
  { id: "visa_sponsorship", any: [/sponsorship/, /require .{0,20}visa/, /need .{0,20}visa/, /will you (?:now or in the future )?require/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.9 },
  { id: "visa_status", any: [/visa status/, /citizenship status/, /immigration status/, /which .{0,30}describes your (?:status|citizenship)/, /work status/], resolve: { kind: "choose", candidates: ["A citizen of the U.S.", "U.S. Citizen", "United States Citizen"] }, base: 0.85 },
  { id: "us_citizen", any: [/are you a (?:u\.?s\.?|united states) citizen/, /\bu\.?s\.? citizen(?:ship)?\b/], not: [/dual/], resolve: { kind: "choose", candidates: ["Yes"] }, base: 0.9 },
  { id: "dual_citizenship", any: [/dual citizen/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.9 },
  { id: "age_18", any: [/\b18 years\b/, /\bage 18\b/, /at least 18/, /18 or older/, /over 18/], resolve: { kind: "choose", candidates: ["Yes"] }, base: 0.9 },
  { id: "drivers_license", any: [/driver'?s? license/, /valid license to drive/], resolve: { kind: "choose", candidates: ["Yes"] }, base: 0.9 },
  { id: "clearance_current", any: [/do you (?:currently )?(?:hold|have|possess).{0,30}clearance/, /active.{0,20}clearance/, /current.{0,20}clearance/, /clearance level/], not: [/eligible|able to obtain|ability/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.85 },
  { id: "clearance_eligible", any: [/eligible.{0,30}clearance/, /able to obtain.{0,20}clearance/, /ability to obtain.{0,20}clearance/, /willing to undergo.{0,30}(?:investigation|clearance)/], resolve: { kind: "fn", fn: clearanceEligible }, base: 0.85 },
  { id: "selective_service", any: [/selective service/, /\bdraft registration\b/], resolve: { kind: "fn", fn: selectiveService }, base: 0.95 },
  { id: "criminal_record", any: [/\bconvicted\b/, /criminal (?:record|history|conviction)/, /\bfelony\b/, /\bmisdemeanor\b/, /pled guilty/], resolve: { kind: "choose", candidates: ["No"], tierCap: 0.45 }, base: 0.8 },

  // ---- education
  { id: "school", any: [/^school$/, /\bschool name\b/, /\buniversity\b/, /\bcollege\b/, /\binstitution\b/, /current school/, /school you attend/], not: [/high school|secondary|graduate school|city|state|location|business school/], resolve: { kind: "path", path: "education.current_school" }, base: 0.85 },
  { id: "school_location", any: [/school (?:city|location)/, /university (?:city|location)/, /college location/], resolve: { kind: "path", path: "education.school_city_state" }, base: 0.8 },
  { id: "degree", any: [/\bdegree\b/, /level of education/, /education level/, /degree type/, /highest level/], not: [/major|field|minor|in progress|high school/], resolve: { kind: "choose", candidates: ["Bachelor of Science", "Bachelor's Degree", "Bachelors", "Bachelor's"] }, base: 0.85 },
  { id: "major", any: [/\bmajor\b/, /field of study/, /\bdiscipline\b/, /area of study/, /course of study/, /\bconcentration\b/], not: [/minor|second major/], resolve: { kind: "fn", fn: major }, base: 0.85 },
  { id: "minor", any: [/\bminor\b/], resolve: { kind: "path", path: "education.minor" }, base: 0.85 },
  { id: "gpa", any: [/\bgpa\b/, /grade point average/], resolve: { kind: "fn", fn: gpa }, base: 0.9 },
  { id: "graduation_date", any: [/graduation date/, /expected graduation/, /anticipated graduation/, /expected completion/, /graduation (?:month|year)/, /when do you graduate/, /degree completion/], resolve: { kind: "fn", fn: gradDate }, base: 0.9 },
  { id: "education_start", any: [/start date/, /attended from/, /enrollment date/], tags: ["input", "select"], not: [/employment|job|work|available|earliest/], resolve: { kind: "path", path: "education.start_date" }, base: 0.6 },
  { id: "class_standing", any: [/class (?:standing|level|year)/, /year in school/, /academic (?:level|year|standing)/, /current year/, /what year are you/], resolve: { kind: "fn", fn: classStanding }, base: 0.85 },
  { id: "high_school", any: [/high school (?:name)?$/, /^high school$/, /secondary school/], not: [/gpa|city|state|graduat/], resolve: { kind: "path", path: "education.high_school" }, base: 0.85 },
  { id: "high_school_location", any: [/high school (?:city|location)/], resolve: { kind: "path", path: "education.high_school_city_state" }, base: 0.85 },
  { id: "high_school_graduation", any: [/high school graduation/], resolve: { kind: "path", path: "education.high_school_graduation" }, base: 0.85 },
  { id: "coursework", any: [/relevant coursework/, /\bcourses?\b.{0,20}(?:taken|completed|relevant)/, /current courses/], resolve: { kind: "fn", fn: ({ profile }) => ({ value: profile.education.current_coursework.map((c) => c.split(" - ")[0]).join(", "), tierCap: 0.45 }) }, base: 0.75 },

  // ---- assembled output
  { id: "skills", any: [/^skills$/, /\bskills\b/, /technical skills/, /relevant skills/, /\btechnologies\b/, /tools (?:and|&) technologies/, /areas of expertise/, /technical proficien/], not: [/soft skills|language skills|communication skills/], resolve: { kind: "assemble", target: "skills" }, base: 0.85 },
  { id: "experience_description", tags: ["textarea"], any: [/describe your (?:relevant )?experience/, /relevant experience/, /tell us about your experience/, /experience description/, /summary of (?:your )?experience/, /qualifications/], resolve: { kind: "assemble", target: "lead_bullets" }, base: 0.8 },

  // ---- essays, which the assembler must not write
  { id: "essay_why_company", tags: ["textarea"], any: [/why (?:do you want to|are you interested)/, /why (?:this|our) (?:company|role|position|team)/, /what (?:interests|excites) you/, /cover letter/, /tell us (?:about yourself|why)/, /personal statement/, /motivation/, /what draws you/], resolve: { kind: "fn", fn: essay }, base: 0.85 },

  // ---- standard answers
  { id: "how_heard", any: [/how did you hear/, /how did you find/, /referral source/, /source\b/, /where did you (?:hear|find|learn)/], not: [/income|funding/], resolve: { kind: "choose", candidates: ["Online job board", "Job board", "Online", "Other"] }, base: 0.85 },
  { id: "earliest_start", any: [/earliest start/, /available start/, /start date/, /when can you start/, /availability date/, /date available/], not: [/school|education|attended|employment history/], resolve: { kind: "path", path: "standard_answers.earliest_start_date" }, base: 0.8 },
  { id: "relocate", any: [/willing to relocate/, /open to relocat/, /able to relocate/, /\brelocation\b/], resolve: { kind: "fn", fn: relocate }, base: 0.85 },
  { id: "previously_employed", any: [/(?:previously|ever been) employed (?:here|by|with)/, /worked (?:here|for us) before/, /former employee/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.85 },
  { id: "interviewed_before", any: [/interviewed (?:here|with us|before)/, /previous(?:ly)? interview/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.85 },
  { id: "employment_type", any: [/employment type/, /type of (?:employment|position|role)/, /position type/, /opportunity type/, /program type/], resolve: { kind: "choose", candidates: ["Campus Program (Intern/Co-op)", "Internship", "Intern", "Co-op"] }, base: 0.8 },
  { id: "days_available", any: [/days available/, /days (?:you )?can work/, /availability\b/, /schedule availability/], not: [/start|date/], resolve: { kind: "path", path: "standard_answers.days_available" }, base: 0.75 },
  { id: "years_experience", any: [/\d\+? years? of (?:professional )?experience/, /do you have (?:at least )?\d/, /3\+ years/], resolve: { kind: "choose", candidates: ["No"] }, base: 0.75 },
  { id: "unemployed_recently", any: [/unemployed/], resolve: { kind: "path", path: "standard_answers.unemployed_last_6_months" }, base: 0.8 },
  { id: "why_leaving", any: [/reason for leaving/, /why did you leave/, /why are you leaving/], resolve: { kind: "path", path: "standard_answers.why_did_you_leave_last_position" }, base: 0.85 },
  { id: "why_seeking", any: [/why (?:are you )?seeking/, /reason for (?:seeking|applying)/, /why (?:a )?change of employment/], resolve: { kind: "path", path: "standard_answers.why_seeking_change_of_employment" }, base: 0.8 },
  { id: "salary", any: [/salary/, /\bcompensation\b/, /desired (?:pay|rate|wage)/, /hourly rate/, /pay expectation/, /expected (?:salary|pay)/, /rate of pay/], resolve: { kind: "fn", fn: salary }, base: 0.85 },
  { id: "certifications", any: [/certification/, /\bcertificates?\b/, /\blicenses?\b/, /credential/], not: [/driver/], resolve: { kind: "fn", fn: certifications }, base: 0.8 },
  { id: "extracurriculars", any: [/extracurricular/, /activities/, /clubs?\b/, /organizations you/, /student (?:groups|organizations)/, /leadership experience/], resolve: { kind: "fn", fn: orgList }, base: 0.75 },
  { id: "patent_awards", any: [/\bawards?\b/, /\bhonors?\b/, /\bpatents?\b/, /recognition/, /achievements/], resolve: { kind: "fn", fn: ({ profile }) => ({ value: profile.awards.map((a) => a.text).join("; "), tierCap: 0.45 }) }, base: 0.75 },

  // ---- references and supervisors
  { id: "reference", any: [/reference/], not: [/do you have|may we|how many|letters? of recommendation upload/], resolve: { kind: "fn", fn: reference }, base: 0.7 },
  { id: "supervisor", any: [/supervisor/, /manager name/, /who did you report to/, /report(?:ed)? to/], resolve: { kind: "fn", fn: supervisorFor("gmu_beholder") }, base: 0.7 },

  // ---- EEO, never auto-filled
  { id: "eeo", any: [/\bgender\b/, /\bsex\b/, /\brace\b/, /\bethnicity\b/, /ethnic (?:group|origin)/, /hispanic or latino/, /\bveteran\b/, /protected veteran/, /\bdisability\b/, /disabled/, /sexual orientation/, /\btransgender\b/, /\bpronouns\b/, /self[- ]identif/], resolve: { kind: "eeo" }, base: 0.9 },

  // ---- consent and agreement checkboxes, never auto-checked
  { id: "consent", tags: ["checkbox"], any: [/\bi (?:certify|agree|acknowledge|consent|authorize|understand|confirm)\b/, /terms (?:and|&) conditions/, /privacy (?:policy|notice)/, /\baccurate and complete\b/, /background check/, /e-?sign/], resolve: { kind: "manual" }, base: 0.9, note: "Agreement checkbox. Yours to read and tick." }
];
