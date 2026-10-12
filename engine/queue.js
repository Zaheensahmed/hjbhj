// engine/queue.js -- PURE. Work-queue transitions and the tracker record a
// submitted item becomes.
//
// Nothing here can mark an item submitted. advanceOnOpen() returns "opened" and
// never anything else, so opening a link cannot become a record that you
// applied. A false applied-record is worse than none.

export const QUEUE_STATUSES = ["queued", "opened", "submitted", "skipped"];

/** Statuses a machine may set. "submitted" is deliberately absent. */
export const AUTO_SETTABLE = ["opened"];

export const OPEN_ORDER = ["queued", "opened"];

export function advanceOnOpen(status) {
  // Opening is not applying. The only automatic transition in the whole queue.
  return status === "queued" ? "opened" : status;
}

/** The next thing to open: queued first, then anything opened but unresolved. */
export function nextToOpen(entries) {
  const open = entries.filter((e) => e.queueStatus === "queued");
  if (open.length) return open[0];
  return entries.find((e) => e.queueStatus === "opened") || null;
}

export function queueSummary(entries) {
  const count = (s) => entries.filter((e) => e.queueStatus === s).length;
  return {
    total: entries.length,
    queued: count("queued"),
    opened: count("opened"),
    submitted: count("submitted"),
    skipped: count("skipped"),
    withDestination: entries.filter((e) => e.destinationUrl).length,
    withReferral: entries.filter((e) => e.referralLeads && e.referralLeads.length).length
  };
}

const ATS_BY_HOST = [
  [/greenhouse\.io/i, "Greenhouse"],
  [/lever\.co/i, "Lever"],
  [/myworkdayjobs\.com|workday/i, "Workday"],
  [/ashbyhq\.com/i, "Ashby"],
  [/icims\.com/i, "iCIMS"],
  [/taleo\.net/i, "Taleo"],
  [/smartrecruiters\.com/i, "SmartRecruiters"],
  [/jobvite\.com/i, "Jobvite"],
  [/workable\.com/i, "Workable"],
  [/jobright\.ai/i, ""]
];

export function atsFromUrl(url) {
  if (!url) return "";
  for (const [re, name] of ATS_BY_HOST) if (re.test(url)) return name;
  return "";
}

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

/**
 * A shortlist entry, once you mark it submitted, becomes a tracker record.
 *
 * Only facts that exist are written. The account email is left blank because
 * nothing here knows which one you used, and a plausible guess in that field is
 * worse than an obvious hole.
 *
 * @param {object} entry      shortlist entry
 * @param {object} harvested  the stage-2 record for the same listing, if any
 * @param {string} todayIso   YYYY-MM-DD
 */
export function toTrackerRecord(entry, harvested, todayIso) {
  const rec = harvested && harvested.record ? harvested.record : null;
  const header = rec ? rec.header : {};

  const notes = [];
  if (entry.referralLeads && entry.referralLeads.length) {
    notes.push(...entry.referralLeads.map((l) => l.text));
  }
  if (rec && rec.resolvesOnOpen) notes.push("Destination link resolved only on open, so the Jobright URL is stored.");
  if (rec && rec.match && rec.match.overall != null) notes.push(`Jobright match ${rec.match.overall}%.`);
  if (harvested && harvested.eligibility && harvested.eligibility.flags.length) {
    notes.push(...harvested.eligibility.flags.map((f) => `Flag: ${f.filter}`));
  }

  const term = header.startTerm ? header.startTerm.label : "";

  return {
    id: `jr-${slugify(entry.company || header.company || entry.title)}${term ? "-" + slugify(term) : ""}`,
    company: entry.company || header.company || "",
    role: entry.title || header.title || "",
    location: header.location || "",
    term,
    portal_url: entry.destinationUrl || entry.listingUrl || "",
    ats: atsFromUrl(entry.destinationUrl || ""),
    account_email: "",
    date_applied: todayIso,
    status: "Applied",
    date_last_checked: todayIso,
    deadline: "",
    notes: notes.join(" "),
    next_action: ""
  };
}

/** The completion message. Plain counts, no editorialising. */
export function harvestSummaryMessage({ reviewed, worthApplying, skipped, failed }) {
  return `${reviewed} reviewed. ${worthApplying} worth applying to, ${skipped} skipped, ${failed} failed to harvest.`;
}

export function earlyTerminationMessage({ reason, done, total, failed }) {
  return `Stopped after ${done} of ${total}${failed ? `, ${failed} failed` : ""}. Reason: ${reason}. Everything read so far was saved.`;
}
