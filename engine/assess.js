// engine/assess.js -- PURE. The stage-2 verdict, and the gate on the queue.
//
// Stage 1 (engine/triage.js) reads structured card fields and can only ever say
// REVIEW or SKIP. APPLY lives here instead, and only here, because it requires
// evidence stage 1 does not have: a panel that actually opened, requirement
// text that was actually found, eligibility actually tested against it, and a
// destination URL that is actually off jobright.ai.
//
// REVIEW means NOT YET ASSESSED. It is not a weak yes. Nothing with a REVIEW
// verdict may enter the work queue.
import { isJobrightUrl } from "./harvest.js";

export const STAGE2_VERDICTS = ["APPLY", "REVIEW", "SKIP"];

/**
 * The three steps that can fail, reported separately so you can see which one
 * broke rather than inferring it from an empty queue.
 */
export function harvestStateOf(harvested) {
  if (!harvested) {
    return {
      attempted: false, panelOpened: false, requiredFound: false, requiredCount: 0,
      preferredCount: 0, originalPostFound: false, destinationUrl: null,
      destinationIsJobright: false, eligibilityAssessed: false, blocked: false,
      requiredFrom: null, failureReason: null
    };
  }
  const ok = harvested.harvestStatus === "ok";
  const rec = ok && harvested.record ? harvested.record : null;
  const elig = harvested.eligibility || null;

  return {
    attempted: true,
    panelOpened: ok,
    requiredFound: Boolean(rec && rec.required && rec.required.length),
    requiredCount: rec && rec.required ? rec.required.length : 0,
    preferredCount: rec && rec.preferred ? rec.preferred.length : 0,
    requiredFrom: rec ? rec.requiredFrom || null : null,
    originalPostFound: Boolean(rec && rec.originalPostFound),
    destinationUrl: rec && rec.destinationUrl && !isJobrightUrl(rec.destinationUrl) ? rec.destinationUrl : null,
    destinationIsJobright: Boolean(rec && rec.destinationIsJobright),
    // Eligibility over an empty or near-empty string reports no blockers, which
    // reads exactly like a clean posting. That is not an assessment.
    eligibilityAssessed: Boolean(elig && !elig.insufficientText),
    blocked: Boolean(harvested.blocked),
    failureReason: ok ? null : harvested.why || "harvest failed"
  };
}

/**
 * @param {object} row       a stage-1 triage row
 * @param {object} harvested the stage-2 record for the same listing, or null
 */
export function assess(row, harvested) {
  const state = harvestStateOf(harvested);
  const reasons = [];
  const held = (code, text) => ({ code, text });

  // Stage 1 already ruled it out.
  if (row.verdict === "SKIP") {
    return {
      verdict: "SKIP", queueEligible: false, state,
      reasons: [held("stage1_skip", "Ruled out at stage 1 on the card's own fields.")]
    };
  }

  if (!state.attempted) {
    reasons.push(held("not_harvested", "Not harvested. The detail panel has never been read for this card, so nothing about its requirements or its destination is known."));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }
  if (!state.panelOpened) {
    reasons.push(held("panel_failed", `The detail panel did not open or did not render: ${state.failureReason}.`));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }
  if (!state.requiredFound) {
    reasons.push(held("no_required", "The panel opened but no Required list was found in it. Eligibility was never really tested, so this is unassessed, not clear."));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }
  if (!state.eligibilityAssessed) {
    reasons.push(held("too_little_text", `Only ${state.requiredCount} requirement line${state.requiredCount === 1 ? "" : "s"} were found, too little to check a graduation window or an institution restriction against.`));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }
  if (state.blocked) {
    const blockers = (harvested.eligibility.blockers || []).map((b) => held("blocked", `${b.filter}: ${b.why}`));
    return { verdict: "SKIP", queueEligible: false, state, reasons: blockers.length ? blockers : [held("blocked", "Blocked on the real requirements.")] };
  }
  if (!state.originalPostFound) {
    reasons.push(held("no_original_post", "No Original Job Post link was found in the panel, so there is no destination to open. This is a selector problem, not a property of the job."));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }
  if (!state.destinationUrl) {
    reasons.push(held("no_destination", "An Original Job Post link exists but its href does not resolve to anything off jobright.ai. A jobright.ai URL is not a destination."));
    return { verdict: "REVIEW", queueEligible: false, state, reasons };
  }

  const flags = (harvested.eligibility.flags || []).map((f) => held("flag", `${f.filter}: ${f.argue}`));
  return {
    verdict: "APPLY",
    queueEligible: true,
    state,
    reasons: [
      held("assessed", `Panel read, ${state.requiredCount} requirement lines checked, no blockers, destination resolves off jobright.ai.`),
      ...flags
    ]
  };
}

/**
 * Board-level harvest state: has it run here, when, how much did it read, and
 * which of the three steps is failing across the board.
 */
export function boardReport({ rows, harvestedByUrl, run, boardUrl }) {
  const assessed = rows.map((r) => ({ row: r, ...assess(r, r.card.listingUrl ? harvestedByUrl[r.card.listingUrl] : null) }));

  const forThisBoard = Object.values(harvestedByUrl || {}).filter(
    (h) => !boardUrl || !h.pageUrl || h.pageUrl === boardUrl
  );
  const okRecords = forThisBoard.filter((h) => h.harvestStatus === "ok");

  const counts = {
    cardsOnBoard: rows.length,
    attempted: forThisBoard.length,
    panelOpened: okRecords.length,
    panelFailed: forThisBoard.length - okRecords.length,
    requiredFound: okRecords.filter((h) => h.record && h.record.required && h.record.required.length).length,
    requiredFromFallback: okRecords.filter((h) => h.record && /qualification heading/.test(h.record.requiredFrom || "")).length,
    originalPostFound: okRecords.filter((h) => h.record && h.record.originalPostFound).length,
    destinationResolved: okRecords.filter((h) => h.record && h.record.destinationUrl && !isJobrightUrl(h.record.destinationUrl)).length,
    blocked: okRecords.filter((h) => h.blocked).length,
    apply: assessed.filter((a) => a.verdict === "APPLY").length,
    review: assessed.filter((a) => a.verdict === "REVIEW").length,
    skip: assessed.filter((a) => a.verdict === "SKIP").length,
    queueEligible: assessed.filter((a) => a.queueEligible).length
  };

  // The loud cases. Each means a selector is wrong, not that the jobs are bad.
  const alarms = [];
  if (counts.panelOpened > 0 && counts.originalPostFound === 0) {
    alarms.push({
      code: "zero_original_posts",
      severity: "critical",
      text: `Harvest read ${counts.panelOpened} panel${counts.panelOpened === 1 ? "" : "s"} and found an Original Job Post link in none of them. That is a selector problem, not ${counts.panelOpened} jobs without a destination. Nothing will be queued until it is fixed.`
    });
  }
  if (counts.panelOpened > 0 && counts.requiredFound === 0) {
    alarms.push({
      code: "zero_required",
      severity: "critical",
      text: `Harvest read ${counts.panelOpened} panel${counts.panelOpened === 1 ? "" : "s"} and found a Required list in none of them. Eligibility has therefore assessed nothing, and no clean verdict here means anything.`
    });
  }
  if (counts.attempted > 0 && counts.panelOpened === 0) {
    alarms.push({
      code: "zero_panels",
      severity: "critical",
      text: `Harvest attempted ${counts.attempted} card${counts.attempted === 1 ? "" : "s"} and no detail panel ever opened. Check PANEL_EVIDENCE and PANEL_SELECTORS in rules/jobright-rules.js.`
    });
  }
  if (counts.originalPostFound > 0 && counts.destinationResolved === 0) {
    alarms.push({
      code: "zero_resolved",
      severity: "critical",
      text: `An Original Job Post link was found on ${counts.originalPostFound} card${counts.originalPostFound === 1 ? "" : "s"} but none of them carried a usable href. The link is probably a button that navigates in script rather than an anchor.`
    });
  }
  if (counts.requiredFromFallback > 0) {
    alarms.push({
      code: "required_fallback",
      severity: "warn",
      text: `${counts.requiredFromFallback} card${counts.requiredFromFallback === 1 ? "" : "s"} had no "Required" sub-heading, so the whole Qualification block was used instead. Worth checking that is the right text.`
    });
  }

  return {
    ran: Boolean(run && run.startedAt),
    startedAt: run ? run.startedAt || null : null,
    finishedAt: run ? run.finishedAt || null : null,
    stoppedEarly: Boolean(run && run.stoppedEarly),
    stopReason: run ? run.stopReason || null : null,
    boardUrl: boardUrl || null,
    counts,
    alarms,
    assessed,
    // Nothing is queued while a critical alarm stands.
    safeToQueue: !alarms.some((a) => a.severity === "critical")
  };
}

/** Shortlisted entries split into what may enter the queue and what may not. */
export function partitionQueue(entries) {
  const eligible = [];
  const held = [];

  for (const e of entries) {
    const verdict = e.assessment ? e.assessment.verdict : "REVIEW";

    if (e.assessment && e.assessment.queueEligible && e.destinationUrl && !isJobrightUrl(e.destinationUrl)) {
      eligible.push(e);
      continue;
    }

    // Every held row states why. A row held with no reason is the same silent
    // failure in a different place, so the reason is derived here rather than
    // assumed to exist on the assessment.
    const why = [];
    if (!e.assessment) {
      why.push({ code: "unassessed", text: "No stage-2 assessment for this row. It was shortlisted before the harvest gate existed, or its harvested record is gone." });
    } else {
      why.push(...(e.assessment.reasons || []));
    }
    if (!e.destinationUrl) {
      why.push({ code: "no_destination", text: "No destination URL off jobright.ai, so there is nothing to open." });
    } else if (isJobrightUrl(e.destinationUrl)) {
      why.push({ code: "jobright_destination", text: `Its destination is ${e.destinationUrl}, which is a jobright.ai link rather than the employer's posting. That is a harvest bug, not a destination.` });
    }
    if (!why.length) {
      why.push({ code: "unknown", text: "Held back, and the reason could not be determined. This is itself a bug worth reporting." });
    }

    held.push({ ...e, heldBecause: why, verdict });
  }
  return { eligible, held };
}
