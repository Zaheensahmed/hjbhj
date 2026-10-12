// tracker/logic.js -- pure view logic for the tracker.
//
// Deliberately written with no import and no export, which makes it valid both
// as a classic <script> (so tracker/index.html works straight from the
// filesystem, where module imports are blocked) and as a node import (so
// test/smoke.mjs can assert the date arithmetic). It assigns one global.
//
// No DOM, no chrome.*, no network.

(() => {
  const DAY = 86400000;

  const STATUS_ORDER = [
    "To apply",
    "Applied",
    "Under Review",
    "Under Consideration",
    "Interview",
    "Offer",
    "Rejected",
    "Closed"
  ];

  const OPEN_STATUSES = new Set(["Applied", "Under Review", "Under Consideration", "Interview"]);
  const DEAD_STATUSES = new Set(["Rejected", "Closed"]);

  const FIELDS = [
    "company", "role", "location", "term", "portal_url", "ats", "account_email",
    "date_applied", "status", "date_last_checked", "deadline", "notes", "next_action"
  ];

  /** Strict YYYY-MM-DD only. Anything else is treated as absent. */
  function parseDate(s) {
    if (typeof s !== "string") return null;
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      return null;
    }
    return d;
  }

  function startOfDay(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function daysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY);
  }

  /** Whole days from dateStr to today. Null when the date is absent or unparseable. */
  function daysSince(dateStr, today) {
    const d = parseDate(dateStr);
    if (!d) return null;
    return daysBetween(d, today);
  }

  function normalize(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    const applications = (Array.isArray(data.applications) ? data.applications : []).map((a, i) => {
      const rec = { id: a.id || `app-${i}` };
      for (const f of FIELDS) rec[f] = typeof a[f] === "string" ? a[f].trim() : "";
      rec.priority = a.priority === "low" ? "low" : "normal";
      rec.status_assumed = Boolean(a.status_assumed);
      rec.date_closed = typeof a.date_closed === "string" ? a.date_closed.trim() : "";
      if (!rec.status) rec.status = "To apply";
      return rec;
    });

    const deadlines = (Array.isArray(data.deadlines) ? data.deadlines : []).map((d, i) => ({
      id: d.id || `deadline-${i}`,
      item: typeof d.item === "string" ? d.item : "",
      due: typeof d.due === "string" ? d.due.trim() : "",
      due_text: typeof d.due_text === "string" ? d.due_text : "",
      due_approx: Boolean(d.due_approx),
      note: typeof d.note === "string" ? d.note : ""
    }));

    return {
      _last_updated: typeof data._last_updated === "string" ? data._last_updated : "",
      statuses: Array.isArray(data.statuses) && data.statuses.length ? data.statuses : STATUS_ORDER.slice(),
      applications,
      deadlines
    };
  }

  /** Fields worth filling in, per record. Never blocks anything, just reports. */
  function validate(data) {
    const problems = [];
    const seen = new Set();
    for (const a of data.applications) {
      if (seen.has(a.id)) problems.push({ id: a.id, kind: "duplicate-id", detail: `More than one record uses the id "${a.id}".` });
      seen.add(a.id);
      if (!a.company) problems.push({ id: a.id, kind: "missing", detail: "No company." });
      if (a.status && !data.statuses.includes(a.status)) {
        problems.push({ id: a.id, kind: "unknown-status", detail: `Status "${a.status}" is not in the statuses list.` });
      }
      for (const f of ["date_applied", "date_last_checked", "deadline", "date_closed"]) {
        if (a[f] && !parseDate(a[f])) {
          problems.push({ id: a.id, kind: "bad-date", detail: `${f} is "${a[f]}", which is not YYYY-MM-DD.` });
        }
      }
      if (OPEN_STATUSES.has(a.status) && !a.date_applied) {
        problems.push({ id: a.id, kind: "incomplete", detail: "Marked as applied but has no date applied." });
      }
      const blanks = ["role", "portal_url", "account_email"].filter((f) => !a[f]);
      if (blanks.length) problems.push({ id: a.id, kind: "blank", detail: `Not filled in yet: ${blanks.join(", ")}.` });
    }
    for (const d of data.deadlines) {
      if (d.due && !parseDate(d.due)) problems.push({ id: d.id, kind: "bad-date", detail: `due is "${d.due}", which is not YYYY-MM-DD.` });
      if (!d.due && !d.due_text) problems.push({ id: d.id, kind: "missing", detail: "No due date and no due text." });
    }
    return problems;
  }

  function byStatus(data) {
    const order = data.statuses;
    const groups = order.map((status) => ({ status, items: [] }));
    const index = new Map(groups.map((g) => [g.status, g]));
    const other = { status: "Other", items: [] };
    for (const a of data.applications) {
      (index.get(a.status) || other).items.push(a);
    }
    for (const g of groups) {
      g.items.sort((x, y) =>
        (x.priority === y.priority ? 0 : x.priority === "low" ? 1 : -1) ||
        x.company.localeCompare(y.company));
    }
    const out = groups.filter((g) => g.items.length);
    if (other.items.length) out.push(other);
    return out;
  }

  /**
   * Applications not checked in `days` or more. Falls back to the applied date
   * when nothing has been checked, and reports records with neither date rather
   * than hiding them.
   */
  function stale(data, today, days = 30) {
    const out = [];
    for (const a of data.applications) {
      if (!OPEN_STATUSES.has(a.status)) continue;
      const checked = daysSince(a.date_last_checked, today);
      if (checked !== null) {
        if (checked >= days) out.push({ app: a, days: checked, basis: "date_last_checked" });
        continue;
      }
      const applied = daysSince(a.date_applied, today);
      if (applied !== null) {
        if (applied >= days) out.push({ app: a, days: applied, basis: "date_applied, never checked since" });
        continue;
      }
      out.push({ app: a, days: null, basis: "no dates on record" });
    }
    // Longest gap first, and records with no dates at all last: an unknown is
    // not a zero, and it reads wrong at the top of a list sorted by staleness.
    return out.sort((x, y) => {
      if (x.days === null && y.days === null) return x.app.company.localeCompare(y.app.company);
      if (x.days === null) return 1;
      if (y.days === null) return -1;
      return y.days - x.days;
    });
  }

  /** Deadlines and application deadlines, merged and sorted, overdue first. */
  function upcoming(data, today, withinDays = null) {
    const rows = [];
    for (const d of data.deadlines) {
      const due = parseDate(d.due);
      rows.push({
        kind: "deadline",
        id: d.id,
        label: d.item,
        due: d.due,
        dueDate: due,
        dueText: d.due_text || d.due,
        approx: d.due_approx,
        note: d.note,
        daysAway: due ? daysBetween(today, due) : null
      });
    }
    for (const a of data.applications) {
      const due = parseDate(a.deadline);
      if (!due) continue;
      if (DEAD_STATUSES.has(a.status)) continue;
      rows.push({
        kind: "application",
        id: a.id,
        label: `${a.company}${a.role ? " - " + a.role : ""}`,
        due: a.deadline,
        dueDate: due,
        dueText: a.deadline,
        approx: false,
        note: a.next_action || a.notes,
        daysAway: daysBetween(today, due)
      });
    }
    const filtered = withinDays == null
      ? rows
      : rows.filter((r) => r.daysAway === null || r.daysAway <= withinDays);

    return filtered
      .map((r) => ({ ...r, overdue: r.daysAway !== null && r.daysAway < 0 }))
      .sort((x, y) => {
        if (x.daysAway === null && y.daysAway === null) return x.label.localeCompare(y.label);
        if (x.daysAway === null) return 1;
        if (y.daysAway === null) return -1;
        return x.daysAway - y.daysAway;
      });
  }

  /**
   * Seed file plus anything the extension has written to chrome.storage.
   * The JSON file stays the source of truth; the overlay is additive, matched
   * by id, and never silently drops a field the file already had.
   */
  function mergeOverlay(seed, overlay) {
    const base = normalize(seed);
    const extra = normalize(overlay || {});
    const index = new Map(base.applications.map((a) => [a.id, a]));

    for (const a of extra.applications) {
      const existing = index.get(a.id);
      if (!existing) {
        base.applications.push({ ...a, _fromOverlay: true });
        index.set(a.id, a);
        continue;
      }
      for (const f of [...FIELDS, "date_closed"]) {
        if (a[f]) existing[f] = a[f];
      }
      if (a.priority === "low") existing.priority = "low";
      existing._overlaid = true;
    }
    const ids = new Set(base.deadlines.map((d) => d.id));
    for (const d of extra.deadlines) if (!ids.has(d.id)) base.deadlines.push({ ...d, _fromOverlay: true });

    return base;
  }

  /** Serialize back to the shape of data.json, dropping internal markers. */
  function toJson(data) {
    const clean = (o) => {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (k.startsWith("_")) continue;
        if (v === "" || v === "normal" || v === false) continue;
        out[k] = v;
      }
      return out;
    };
    return JSON.stringify({
      _README: "Application tracker data. Hand-editable. Dates are YYYY-MM-DD. Anything the page cannot parse is reported rather than guessed.",
      _last_updated: new Date().toISOString().slice(0, 10),
      statuses: data.statuses,
      applications: data.applications.map(clean),
      deadlines: data.deadlines.map(clean)
    }, null, 2) + "\n";
  }

  globalThis.JAF_TRACKER = {
    STATUS_ORDER, OPEN_STATUSES, DEAD_STATUSES, FIELDS,
    parseDate, daysBetween, daysSince,
    normalize, validate, byStatus, stale, upcoming, mergeOverlay, toJson
  };
})();
