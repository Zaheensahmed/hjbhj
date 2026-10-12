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

  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/[^\S\n]+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rx = (p) => new RegExp(p.source, String(p.flags || "").replace("g", ""));

  let control = { stop: false };
  let run = null;

  // ------------------------------------------------------------- click policy

  function clickLabel(el) {
    return [
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      el.getAttribute && el.getAttribute("data-testid"),
      text(el).slice(0, 120),
      el.className && typeof el.className === "string" ? el.className : ""
    ].filter(Boolean).join(" | ");
  }

  function isForbidden(el, rules) {
    const label = clickLabel(el);
    for (const p of rules.FORBIDDEN_CLICK) {
      if (rx(p).test(label)) return p.source;
    }
    return null;
  }

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

  // ------------------------------------------------------------------ waiting

  /**
   * Wall-clock waiting. A hidden tab has its timers throttled, so a sleep can
   * stretch from 250ms to a minute. That is slowness, not failure: the budget
   * is multiplied while hidden, and nothing fails before minPolls attempts
   * however long the gaps were.
   */
  async function waitFor(predicate, rules, label) {
    const started = Date.now();
    let polls = 0;
    let wasHidden = document.hidden;

    while (true) {
      polls++;
      let hit = false;
      try { hit = Boolean(predicate()); } catch { hit = false; }
      if (hit) return { ok: true, polls, ms: Date.now() - started, throttled: wasHidden };

      if (document.hidden) wasHidden = true;
      const budget = rules.HARVEST.renderTimeoutMs * (wasHidden ? rules.HARVEST.hiddenMultiplier : 1);
      if (polls >= rules.HARVEST.minPolls && Date.now() - started > budget) {
        return { ok: false, polls, ms: Date.now() - started, throttled: wasHidden, label };
      }
      if (control.stop) return { ok: false, polls, ms: Date.now() - started, stopped: true };
      await sleep(rules.HARVEST.pollMs);
    }
  }

  // ------------------------------------------------------------------- panels

  function findPanel(rules) {
    const evidence = (body) => rules.PANEL_EVIDENCE.filter((p) => rx(p).test(body)).length;

    for (const sel of rules.PANEL_SELECTORS) {
      let found;
      try { found = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hit = found.find((el) => {
        if (!el.getClientRects().length) return false;
        return evidence(text(el)) >= 2;
      });
      if (hit) return hit;
    }
    // Fallback: the smallest visible element carrying the panel's own content.
    const all = [...document.querySelectorAll("div, aside, section")].filter(
      (el) => el.getClientRects().length && evidence(text(el)) >= 3 && text(el).length > 200
    );
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    return inner[0] || null;
  }

  function findCloseButton(panel, rules) {
    const rect = panel.getBoundingClientRect();
    const candidates = [];
    for (const sel of rules.CLOSE_SELECTORS) {
      let found;
      try { found = [...panel.querySelectorAll(sel)]; } catch { continue; }
      for (const el of found) {
        if (!el.getClientRects().length) continue;
        if (isForbidden(el, rules)) continue;
        const label = clickLabel(el);
        const looksClose =
          /close/i.test(label) ||
          rules.CLOSE_TEXTS.some((p) => rx(p).test(text(el)));
        if (!looksClose) continue;
        const r = el.getBoundingClientRect();
        // The X is at the top-left of the panel, so score by distance from it.
        candidates.push({ el, score: (r.left - rect.left) + (r.top - rect.top) * 1.5 });
      }
      if (candidates.length) break;
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates.length ? candidates[0].el : null;
  }

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

    run = {
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      total: capped.length,
      done: 0, failed: 0, stoppedEarly: false, stopReason: null,
      current: null, clicks: [], refusals: [], results: []
    };
    control = { stop: false };
    await chrome.storage.local.set({ harvest_control: { stop: false } });
    await writeProgress();
    await report("harvest:start", { total: run.total });

    // A navigation ends the run cleanly. Everything already read is in storage.
    const onUnload = () => {
      run.stoppedEarly = true;
      run.stopReason = "navigation";
      report("harvest:end", summary());
    };
    window.addEventListener("beforeunload", onUnload);

    let consecutiveFailures = 0;

    for (const cardEl of capped) {
      await readControl();
      if (control.stop) { run.stoppedEarly = true; run.stopReason = "stopped by you"; break; }
      if (Date.now() - run.startedMs > rules.HARVEST.maxRunMs) {
        run.stoppedEarly = true; run.stopReason = "hard cap on run length reached"; break;
      }
      if (consecutiveFailures >= rules.HARVEST.maxConsecutiveFailures) {
        run.stoppedEarly = true;
        run.stopReason = `${consecutiveFailures} cards in a row failed to render, so something has changed on the page`;
        break;
      }

      const cardId = cardEl.dataset.jafCard;
      run.current = cardId;
      await writeProgress();

      const before = findPanel(rules);
      const opened = safeClick(cardEl, `open card ${cardId}`, rules);

      if (!opened.ok) {
        run.failed++; consecutiveFailures++;
        run.results.push({ cardId, status: "harvest failed", why: `could not open: ${opened.reason}` });
        await report("harvest:record", { cardId, status: "failed", why: opened.reason });
        continue;
      }

      const waited = await waitFor(() => {
        const p = findPanel(rules);
        return p && p !== before && text(p).length > 200;
      }, rules, "panel render");

      if (!waited.ok) {
        run.failed++; consecutiveFailures++;
        const why = waited.stopped
          ? "stopped while waiting"
          : `panel did not render inside the budget (${waited.polls} polls over ${Math.round(waited.ms / 1000)}s${waited.throttled ? ", tab was hidden so the budget was extended" : ""})`;
        run.results.push({ cardId, status: "harvest failed", why });
        await report("harvest:record", { cardId, status: "failed", why });
        // Try to leave the page as it was found.
        const stray = findPanel(rules);
        if (stray) safeClick(findCloseButton(stray, rules), "close after failure", rules);
        await writeProgress();
        if (waited.stopped) { run.stoppedEarly = true; run.stopReason = "stopped by you"; break; }
        await sleep(rules.HARVEST.pollMs * 4);
        continue;
      }

      consecutiveFailures = 0;
      const panel = findPanel(rules);
      const raw = harvestPanelDom(panel);
      const listingUrl = opts.urlByCardId ? opts.urlByCardId[cardId] || null : null;

      // Parsing and eligibility happen in the service worker, which can import
      // engine/. A classic content script cannot.
      await report("harvest:record", {
        cardId,
        listingUrl,
        status: "ok",
        raw,
        pageUrl: location.href.split("?")[0],
        throttled: waited.throttled,
        renderMs: waited.ms
      });

      run.done++;
      run.results.push({ cardId, status: "ok", renderMs: waited.ms });
      await writeProgress();
      await report("harvest:progress", { done: run.done, failed: run.failed, total: run.total });

      const closeBtn = findCloseButton(panel, rules);
      const closed = safeClick(closeBtn, `close card ${cardId}`, rules);
      if (!closed.ok) {
        // Escape is not a click, and it is the only fallback used. If the panel
        // stays open the next card's click still works on most layouts.
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        run.results[run.results.length - 1].closeNote = `close control not clicked (${closed.reason}); sent Escape instead`;
      }
      await waitFor(() => !findPanel(rules), rules, "panel close");

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

  function summary() {
    return {
      total: run.total, done: run.done, failed: run.failed,
      stoppedEarly: run.stoppedEarly, stopReason: run.stopReason,
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
