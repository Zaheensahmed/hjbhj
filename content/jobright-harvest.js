// content/jobright-harvest.js -- injected, classic script. Stage 2.
//
// The loop runs HERE, in the page, not in the popup, so closing the popup or
// switching tabs does not stop it. Progress is written to chrome.storage after
// every card, so a stop, a navigation or a crash still leaves what was read.
//
// CLICK POLICY, which is the point of this file:
//   every click goes through safeClick(), which refuses anything matching
//   FORBIDDEN_CLICK: Apply with Autofill, Easy Apply, Apply Now, Save,
//   Dismiss, Share, Report Issue, Find Any Email, "Did you apply", and the
//   rest. Only two things are ever clicked on purpose: a card, to open it, and
//   the panel's own close control. Refusals are recorded on the run.
//
// The destination link is read from the "Original Job Post" href. It is never
// clicked, and Apply is never clicked to discover it.

(() => {
  console.log("[JAF injected] jobright-harvest.js (detail harvest loop)");
  const JR = (globalThis.JAF_JR = globalThis.JAF_JR || {});

  // Detection is shared with the DOM dump, in content/jobright-detect.js.
  const D = () => globalThis.JAF_JR.detect;
  const text = (el) => D().text(el);
  const sleep = (ms) => D().sleep(ms);
  const rx = (p) => D().rx(p);

  let control = { stop: false };
  let run = null;

  // ------------------------------------------------------------- click policy

  const clickLabel = (el) => D().clickLabel(el);
  const isForbidden = (el, rules) => D().isForbidden(el, rules);

  /**
   * The only way anything in this file clicks. Refuses on FORBIDDEN_CLICK and
   * records the refusal so a run reports what it declined to touch.
   */
  function safeClick(el, why, rules) {
    if (!el) return { ok: false, reason: "no element" };
    const forbidden = isForbidden(el, rules);
    if (forbidden) {
      run.refusals.push({ why, label: clickLabel(el).slice(0, 160), matched: forbidden, at: new Date().toISOString() });
      return { ok: false, reason: `refused: matches ${forbidden}` };
    }
    el.click();
    run.clicks.push({ why, label: clickLabel(el).slice(0, 80) });
    return { ok: true };
  }

  const waitFor = (pred, rules, label) => D().waitFor(pred, rules, label);

  // ------------------------------------------------------------------- panels

  function harvestPanelDom(panel) {
    const links = [...panel.querySelectorAll("a[href], button")].map((el) => ({
      text: text(el).slice(0, 80),
      href: el.getAttribute ? (el.getAttribute("href") || "") : ""
    }));
    const tagElements = [...panel.querySelectorAll("[class*='tag'], [class*='Tag'], [class*='chip'], [class*='Chip'], [class*='skill']")]
      .map((el) => ({
        text: text(el).slice(0, 80),
        className: typeof el.className === "string" ? el.className : "",
        hasIcon: Boolean(el.querySelector("svg, img, [class*='icon'], [class*='check']"))
      }))
      .filter((t) => t.text);
    return { panelText: text(panel), links, tagElements };
  }

  // --------------------------------------------------------------------- loop

  function cardsOnPage() {
    return [...document.querySelectorAll("[data-jaf-card]")];
  }

  /**
   * Re-find a card after the board has been re-rendered.
   *
   * Opening a card can change the URL, and coming back rebuilds the board, so
   * the data-jaf-card stamps are gone and the original element references are
   * detached. The listing URL is the stable key, so the board is re-scanned and
   * matched on that.
   */
  function resolveCard(target, rules) {
    const direct = document.querySelector(`[data-jaf-card="${target.cardId}"]`);
    if (direct && direct.isConnected) return direct;

    if (typeof JR.scanBoard !== "function") return null;
    let rescan;
    try { rescan = JR.scanBoard(rules); } catch { return null; }
    const hit = (rescan.cards || []).find((c) => c.listingUrl && c.listingUrl === target.listingUrl);
    return hit ? document.querySelector(`[data-jaf-card="${hit.cardId}"]`) : null;
  }

  async function report(type, payload) {
    try {
      await chrome.runtime.sendMessage({ type, payload });
    } catch {
      // The service worker may be asleep or the extension reloading. Progress is
      // already in storage, so losing a progress ping is not losing data.
    }
  }

  async function readControl() {
    try {
      const o = await chrome.storage.local.get("harvest_control");
      control = o.harvest_control || { stop: false };
    } catch { /* keep the last known control */ }
    return control;
  }

  async function writeProgress() {
    try {
      await chrome.storage.local.set({ harvest_progress: { ...run, updatedAt: new Date().toISOString() } });
    } catch { /* nothing to do */ }
  }

  JR.harvest = async function harvest(opts) {
    const rules = opts.rules;
    const targets = opts.cardIds && opts.cardIds.length
      ? cardsOnPage().filter((el) => opts.cardIds.includes(el.dataset.jafCard))
      : cardsOnPage();

    const capped = targets.slice(0, rules.HARVEST.maxCards);
    const plan = capped.map((el) => ({
      cardId: el.dataset.jafCard,
      listingUrl: opts.urlByCardId ? opts.urlByCardId[el.dataset.jafCard] || null : null
    }));

    run = {
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      total: plan.length,
      done: 0, failed: 0, stoppedEarly: false, stopReason: null,
      navigationMode: null, boardUrl: location.href,
      current: null, clicks: [], refusals: [], results: []
    };
    control = { stop: false };
    await chrome.storage.local.set({ harvest_control: { stop: false } });
    await writeProgress();
    await report("harvest:start", { total: run.total });

    // A hard navigation would destroy this script. Client-side routing does not
    // fire beforeunload, so if this ever runs, the run is genuinely over.
    const onUnload = () => {
      run.stoppedEarly = true;
      run.stopReason = "the page navigated away and the loop was unloaded";
      report("harvest:end", summary());
    };
    window.addEventListener("beforeunload", onUnload);

    let consecutiveFailures = 0;

    for (const target of plan) {
      await readControl();
      if (control.stop) { run.stoppedEarly = true; run.stopReason = "stopped by you"; break; }
      if (Date.now() - run.startedMs > rules.HARVEST.maxRunMs) {
        run.stoppedEarly = true; run.stopReason = "hard cap on run length reached"; break;
      }
      if (consecutiveFailures >= rules.HARVEST.maxConsecutiveFailures) {
        run.stoppedEarly = true;
        run.stopReason = `${consecutiveFailures} cards in a row failed, so something has changed on the page`;
        break;
      }

      run.current = target.cardId;
      await writeProgress();

      const cardEl = resolveCard(target, rules);
      if (!cardEl) {
        run.failed++; consecutiveFailures++;
        run.results.push({ ...target, status: "harvest failed", why: "the card is no longer on the board and could not be re-found by listing URL" });
        await report("harvest:record", { ...target, status: "failed", why: "card not found after re-render" });
        continue;
      }

      const urlBefore = location.href;
      const evidenceBefore = D().evidenceIn(rules, document.body).hits.length;
      const opened = safeClick(cardEl, `open card ${target.cardId}`, rules);

      if (!opened.ok) {
        run.failed++; consecutiveFailures++;
        run.results.push({ ...target, status: "harvest failed", why: `could not open: ${opened.reason}` });
        await report("harvest:record", { ...target, status: "failed", why: opened.reason });
        continue;
      }

      const waited = await waitFor(() => {
        const found = D().findDetailView(rules);
        return (found.found && found.evidence.length > evidenceBefore) || location.href !== urlBefore;
      }, rules, "detail view");

      await sleep(500); // let a route finish painting

      const routed = location.href !== urlBefore;
      if (run.navigationMode === null) run.navigationMode = routed ? "route" : "overlay";

      const detail = D().findDetailView(rules);
      if (!waited.ok || !detail.found) {
        run.failed++; consecutiveFailures++;
        const why = waited.stopped
          ? "stopped while waiting"
          : `the detail view did not appear (${waited.polls} polls over ${Math.round(waited.ms / 1000)}s${waited.throttled ? ", tab hidden so the budget was extended" : ""}). Evidence matched: ${detail.evidence.join(", ") || "none"}`;
        run.results.push({ ...target, status: "harvest failed", why, detection: detail.diagnostics || null });
        await report("harvest:record", { ...target, status: "failed", why });
        await leaveDetailView(routed, urlBefore, detail.scope, rules);
        await writeProgress();
        if (waited.stopped) { run.stoppedEarly = true; run.stopReason = "stopped by you"; break; }
        await sleep(rules.HARVEST.pollMs * 4);
        continue;
      }

      consecutiveFailures = 0;
      const raw = harvestPanelDom(detail.scope);

      await report("harvest:record", {
        cardId: target.cardId,
        listingUrl: target.listingUrl,
        status: "ok",
        raw,
        pageUrl: run.boardUrl,
        detailUrl: routed ? location.href : null,
        throttled: waited.throttled,
        renderMs: waited.ms
      });

      run.done++;
      run.results.push({ ...target, status: "ok", renderMs: waited.ms, routed });
      await writeProgress();
      await report("harvest:progress", { done: run.done, failed: run.failed, total: run.total });

      await leaveDetailView(routed, urlBefore, detail.scope, rules);

      const gap = rules.HARVEST.gapMinMs + Math.random() * (rules.HARVEST.gapMaxMs - rules.HARVEST.gapMinMs);
      await sleep(gap);
    }

    window.removeEventListener("beforeunload", onUnload);
    run.current = null;
    run.finishedAt = new Date().toISOString();
    await writeProgress();
    await report("harvest:end", summary());
    return summary();
  };

  /**
   * Leave the detail view the way it was entered. A full-page route goes back
   * in history; an overlay gets its X clicked, through the same guard.
   */
  async function leaveDetailView(routed, urlBefore, scope, rules) {
    if (routed) {
      history.back();
      const back = await waitFor(() => location.href === urlBefore, rules, "return to the board");
      if (!back.ok) run.results[run.results.length - 1] && (run.results[run.results.length - 1].closeNote = "history.back() did not return to the board in time");
      // The board re-renders, so the card stamps are gone. resolveCard handles it.
      await waitFor(() => cardsOnPage().length > 0 || typeof JR.scanBoard === "function", rules, "board back");
      return;
    }
    const closeCand = D().findCloseAffordance(scope, rules);
    const closed = closeCand ? safeClick(closeCand.el, "close detail view", rules) : { ok: false, reason: "no close control found" };
    if (!closed.ok) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (run.results.length) run.results[run.results.length - 1].closeNote = `close control not clicked (${closed.reason}); sent Escape instead`;
    }
    await waitFor(() => !D().findDetailView(rules).found, rules, "detail view closed");
  }

  function summary() {
    return {
      total: run.total, done: run.done, failed: run.failed,
      stoppedEarly: run.stoppedEarly, stopReason: run.stopReason,
      navigationMode: run.navigationMode,
      elapsedMs: Date.now() - run.startedMs,
      refusals: run.refusals,
      clickKinds: [...new Set(run.clicks.map((c) => c.why.replace(/ card-\d+$/, "")))],
      results: run.results
    };
  }

  JR.harvestStatus = async function harvestStatus() {
    const o = await chrome.storage.local.get("harvest_progress");
    return o.harvest_progress || null;
  };
})();
