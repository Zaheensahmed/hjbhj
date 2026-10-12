// rules/eligibility-rules.js -- EDITABLE
// Each detector pairs one entry from eligibility_filters in the profile with a
// way to spot it in a posting. Detectors return a verdict plus the sentence
// they matched, so the call is always yours to make on real text.
//
// kind: "hard" stops assembly. "soft" is a flag with a counter-argument.
// confidence: "high" means the regex is specific. "low" means read it yourself.

export const HARD_DETECTORS = [
  {
    id: "grad_window",
    filter: "Graduation window excluding May 2029",
    confidence: "high",
    find: [
      /\bclass of (?:20\d{2})(?:\s*(?:,|and|or|-|through|to)\s*20\d{2})*/gi,
      /\bgraduat\w*\s+(?:between|in|by|before|no later than|on or before)\s+[^.;\n]{0,60}/gi,
      /\b20\d{2}\s+graduat\w+/gi,
      /\bexpected graduation(?:\s+date)?\s*(?:of|in|:)?\s*[^.;\n]{0,40}/gi,
      /\bmust graduate\s+[^.;\n]{0,60}/gi
    ],
    judge(matchText, profile) {
      const years = [...matchText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
      if (!years.length) return { verdict: "unclear", why: "Graduation language found but no year parsed." };
      const target = Number(profile.education.expected_graduation.match(/\d{4}/)[0]);
      if (years.includes(target)) {
        return { verdict: "ok", why: `Lists ${target}, which is your graduation year.` };
      }
      const lo = Math.min(...years), hi = Math.max(...years);

      // "Must graduate in December 2027 or later" is an open-ended floor, not a
      // list of acceptable years. Reading it as a list rejects every later
      // graduation date, which is exactly backwards.
      if (/\bor\s+(?:later|after|beyond)\b|\band\s+later\b|\bonwards?\b/i.test(matchText)) {
        return target >= lo
          ? { verdict: "ok", why: `An open-ended floor of ${lo} or later. You graduate ${target}.` }
          : { verdict: "blocked", why: `Floor is ${lo} or later. You graduate ${target}.` };
      }
      if (/\bor\s+(?:earlier|before|sooner)\b|\bno later than\b|\bby\b/i.test(matchText)) {
        return target <= hi
          ? { verdict: "ok", why: `A ceiling of ${hi} or earlier. You graduate ${target}.` }
          : { verdict: "blocked", why: `Ceiling is ${hi} or earlier. You graduate ${target}.` };
      }
      if (/between|through|\bto\b|-/.test(matchText) && target >= lo && target <= hi) {
        return { verdict: "ok", why: `${target} falls inside the stated ${lo}-${hi} window.` };
      }
      return {
        verdict: "blocked",
        why: `Posting names ${years.join(", ")}. You graduate ${profile.education.expected_graduation}.`
      };
    }
  },
  {
    id: "active_clearance",
    filter: "Active clearance required at application",
    confidence: "high",
    find: [
      /\b(?:must|required to)\s+(?:currently\s+)?(?:hold|possess|have|maintain)\b[^.;\n]{0,80}clearance[^.;\n]{0,40}/gi,
      /\bactive\s+(?:ts\/sci|top secret|secret|dod|security)\s*(?:clearance)?[^.;\n]{0,40}/gi,
      /\bcurrent\s+(?:ts\/sci|top secret|secret)\s+clearance[^.;\n]{0,40}/gi,
      /\bclearance\s+(?:is\s+)?required\s+(?:at|prior to|before)\s+[^.;\n]{0,40}/gi
    ],
    judge(matchText, profile) {
      // "ability to obtain" is not a blocker: clearance_eligible is Yes.
      if (/\b(?:ability|able|eligible|eligibility)\s+to\s+obtain\b/i.test(matchText)) {
        return { verdict: "ok", why: `Asks for eligibility, not a current clearance. Yours: ${profile.work_authorization.clearance_eligible}.` };
      }
      if (/\bor\s+(?:the\s+)?ability to obtain\b/i.test(matchText)) {
        return { verdict: "ok", why: "Accepts ability to obtain." };
      }
      return {
        verdict: "blocked",
        why: `Wants a clearance in hand. Yours: security_clearance_current = ${profile.work_authorization.security_clearance_current}.`
      };
    }
  },
  {
    id: "institution_restriction",
    filter: "Institution restrictions (e.g. SWVA consortium - blocked VPT)",
    confidence: "low",
    find: [
      /\bmust be (?:currently )?enrolled (?:at|in)\s+[^.;\n]{0,80}/gi,
      /\b(?:students?|applicants?)\s+(?:from|at|attending)\s+(?:the\s+)?(?:following|participating|partner|member)\s+[^.;\n]{0,80}/gi,
      /\bconsortium\b[^.;\n]{0,80}/gi,
      // Anchored on an institution preposition so graduation-window wording
      // like "open to students graduating between 2028 and 2030" does not hit.
      /\b(?:open|limited|restricted|available)\s+(?:only\s+)?to\s+students?\s+(?:at|from|attending|enrolled (?:at|in))\s+[^.;\n]{0,80}/gi,
      /\bpartner (?:school|university|institution)s?\b[^.;\n]{0,60}/gi
    ],
    judge(matchText, profile) {
      const school = profile.education.current_school;
      // Compare against the profile's own school rather than a hard-coded name,
      // so this file carries no one's identity.
      const words = school.split(/[^A-Za-z]+/).filter((w) => w.length > 3);
      const named = words.length && words.every((w) => new RegExp(`\\b${w}\\b`, "i").test(matchText));
      const acronym = words.length > 1 && new RegExp(`\\b${words.map((w) => w[0]).join("")}\\b`, "i").test(matchText);
      if (named || acronym) {
        return { verdict: "ok", why: `Names your school (${school}).` };
      }
      // "must be enrolled at a participating consortium school" restricts by
      // institution. "must be enrolled in a Bachelor's program" does not.
      const specific = /\bconsortium\b|\bparticipating\b|\bpartner\b|\bthe following\b|\bmember (?:school|institution|universit)/i;
      const generic = /\b(?:bachelor|master|undergraduate|graduate|doctoral|associate|degree|program|course|accredited|four[- ]year|two[- ]year|college or university|university or college|an? (?:accredited )?(?:college|university|institution|school))\b/i;

      if (specific.test(matchText)) {
        return {
          verdict: "blocked",
          why: `Restricts applicants to specific institutions and does not name ${school} in the matched text. Read the full posting before trusting this.`
        };
      }
      if (generic.test(matchText)) {
        return {
          verdict: "ok",
          why: "A general enrollment or degree requirement, not an institution restriction. You are enrolled in a Bachelor of Science program."
        };
      }
      return {
        verdict: "unclear",
        why: `Names an enrollment requirement that is neither clearly generic nor clearly a consortium. Read it yourself. Your school is ${school}.`
      };
    }
  },
  {
    id: "school_year_onsite",
    filter: "School-year on-site role away from your campus",
    confidence: "low",
    find: [
      /\b(?:fall|spring|academic year|school year)\s+(?:20\d{2}\s+)?(?:internship|co-?op|term|semester)[^.;\n]{0,60}/gi,
      /\b(?:part[- ]time\s+)?during the (?:school|academic) year[^.;\n]{0,60}/gi,
      /\b(?:fall|spring)\s+20\d{2}\s+(?:start|cohort)[^.;\n]{0,40}/gi
    ],
    judge(matchText, profile, posting) {
      const onsite = /\bon[- ]?site\b|\bin[- ]office\b|\bin person\b|\bhybrid\b/i.test(posting.text);
      const remote = /\bfully remote\b|\b100% remote\b|\bremote[- ]first\b/i.test(posting.text);
      if (remote) return { verdict: "ok", why: "Reads as remote, which is always viable per eligibility_filters.always_viable." };
      if (!onsite) return { verdict: "unclear", why: "Term-time role but no on-site requirement found. Check the location line." };
      const local = /\bmaryland\b|\bbaltimore\b|\bcolumbia, md\b|\bwashington,? d\.?c\.?\b|\bbethesda\b|\brockville\b|\bannapolis\b|\byour campus\b/i.test(posting.text);
      if (local) return { verdict: "ok", why: "On-site but local to your campus." };
      return {
        verdict: "blocked",
        why: "Looks like a term-time on-site role away from your campus. Confirm the location and term yourself before dropping it."
      };
    }
  }
];

export const SOFT_DETECTORS = [
  {
    id: "rising_junior_senior",
    filter: "'Rising junior or senior preferred' - argue junior standing by credits",
    find: [/\brising (?:junior|senior)s?\b[^.;\n]{0,60}/gi, /\b(?:junior|senior)s?\s+(?:and|or)\s+(?:senior|junior)s?\s+(?:only|preferred)[^.;\n]{0,40}/gi],
    argue: (p) => `${p.education.class_year_explanation} Standing from fall 2027 is ${p.education.class_standing_fall_2027}.`
  },
  {
    id: "penultimate_final",
    filter: "'Penultimate or final year' - qualifies; 2027-28 is penultimate on a three-year path",
    find: [/\bpenultimate\b[^.;\n]{0,60}/gi, /\bfinal year\b[^.;\n]{0,60}/gi, /\blast year of (?:your )?(?:degree|study|program)\b[^.;\n]{0,40}/gi],
    argue: (p) => `Qualifies. Penultimate year is ${p.education.penultimate_year}, final year ${p.education.final_year}.`
  },
  {
    id: "years_until_graduation",
    filter: "'Less than 2 years until graduation' - borderline, ~23 months from a June 2027 start",
    find: [/\b(?:within|less than|no more than|at most)\s+\d+\s+years?\s+(?:of|from|until|to)\s+graduat\w+/gi, /\bgraduat\w+\s+within\s+\d+\s+years?/gi],
    argue: () => "Borderline. Roughly 23 months out from a June 2027 start. Worth applying, expect the question."
  },
  {
    id: "gpa_floor",
    filter: "Minimum GPA stated",
    find: [/\b(?:minimum|min\.?|at least)\s+(?:cumulative\s+)?gpa\s+of\s+[\d.]+/gi, /\bgpa\s+of\s+[\d.]+\s+or\s+(?:higher|above)/gi, /\b[\d.]+\s+gpa\s+(?:minimum|or higher)/gi],
    argue: (p) => `No college GPA yet (${p.education.college_gpa}). High school unweighted was ${p.education.high_school_gpa_unweighted}.`
  },
  {
    id: "prior_experience",
    filter: "Years of professional experience requested",
    find: [/\b\d+\+?\s+years?\s+of\s+(?:professional\s+)?(?:relevant\s+)?experience/gi],
    argue: (p) => `${p.standard_answers["3_plus_years_professional_experience"]} to 3+ years professional. Two research internships and one project.`
  }
];
