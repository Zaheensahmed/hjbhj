// content/jobright-detect.js -- injected, classic script. Shared detection for
// the harvest loop and the DOM dump, so the two cannot drift apart.
//
// The detail view is a FULL-PAGE view that replaces the board, not a drawer or
// a dialog. So detection does not require a container selector at all: it reads
// evidence text off document.body, the same "read text, not class names"
// approach the rest of the rules use. PANEL_SELECTORS is kept only as a fast
// path, and its failure never means "no detail view".

(() => {
  console.log("[JAF injected] jobright-detect.js (shared detail-view detection)");
  const JR = (globalThis.JAF_JR = globalThis.JAF_JR || {});

  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/[^\S\n]+/g, " ").trim() : "");
  const rx = (p) => new RegExp(p.source, String(p.flags || "").replace("g", ""));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clickLabel(el) {
    return [
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      text(el).slice(0, 120),
      typeof el.className === "string" ? el.className : ""
    ].filter(Boolean).join(" | ");
  }

  function isForbidden(el, rules) {
    const label = clickLabel(el);
    for (const p of rules.FORBIDDEN_CLICK || []) if (rx(p).test(label)) return p.source;
    return null;
  }

  /** Which evidence patterns are present in a root's text, and where. */
  function evidenceIn(rules, root) {
    const body = text(root || document.body);
    const hits = [];
    for (const p of rules.PANEL_EVIDENCE || []) {
      if (rx(p).test(body)) hits.push(p.source);
    }
    return { hits, bodyLength: body.length, body };
  }

  /** The deepest element whose own text still carries the pattern. */
  function deepestMatch(pattern, root) {
    const re = rx(pattern);
    let best = null;
    const walk = (el) => {
      if (!el || !el.children) return;
      if (!re.test(text(el))) return;
      best = el;
      for (const child of el.children) walk(child);
    };
    walk(root || document.body);
    return best;
  }

  function nearestCommonAncestor(elements) {
    const els = elements.filter(Boolean);
    if (!els.length) return null;
    let anc = els[0];
    while (anc && anc !== document.documentElement && !els.every((e) => anc.contains(e))) {
      anc = anc.parentElement;
    }
    return anc || null;
  }

  /**
   * @returns {{found:boolean, scope:Element|null, via:string, evidence:string[],
   *            diagnostics:object}}
   */
  function findDetailView(rules) {
    const MIN_EVIDENCE = 2;

    // Fast path, never fatal: a container selector that happens to fit.
    for (const sel of rules.PANEL_SELECTORS || []) {
      let found;
      try { found = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hit = found.find((el) => el.getClientRects().length && evidenceIn(rules, el).hits.length >= MIN_EVIDENCE);
      if (hit) {
        return { found: true, scope: hit, via: `selector ${sel}`, evidence: evidenceIn(rules, hit).hits, diagnostics: null };
      }
    }

    // The real test: evidence text anywhere in the body.
    const inBody = evidenceIn(rules, document.body);
    if (inBody.hits.length < MIN_EVIDENCE) {
      return {
        found: false, scope: null, via: "none", evidence: inBody.hits,
        diagnostics: {
          reason: `Only ${inBody.hits.length} of ${(rules.PANEL_EVIDENCE || []).length} evidence patterns matched the page body, and ${MIN_EVIDENCE} are required.`,
          evidenceMatched: inBody.hits,
          evidenceMissed: (rules.PANEL_EVIDENCE || []).map((p) => p.source).filter((s) => !inBody.hits.includes(s)),
          bodyTextLength: inBody.bodyLength,
          bodyFirstLines: inBody.body.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 25),
          url: location.href
        }
      };
    }

    // Scope: the nearest common ancestor of the evidence, body as the fallback.
    const anchors = (rules.PANEL_EVIDENCE || [])
      .filter((p) => inBody.hits.includes(p.source))
      .map((p) => deepestMatch(p, document.body))
      .filter(Boolean);

    let scope = nearestCommonAncestor(anchors);
    let via = "evidence text, scoped to the nearest common ancestor";
    if (!scope || scope === document.documentElement || text(scope).length < 200) {
      scope = document.body;
      via = "evidence text, scoped to document.body";
    }
    return { found: true, scope, via, evidence: inBody.hits, diagnostics: null };
  }

  /**
   * How to leave the detail view. A full-page route needs history.back(); an
   * overlay needs its X. Returns the close control when there is one.
   */
  function findCloseAffordance(scope, rules) {
    const root = scope || document.body;
    const rect = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0 };
    const candidates = [];

    for (const sel of rules.CLOSE_SELECTORS || []) {
      let found;
      try { found = [...root.querySelectorAll(sel)]; } catch { continue; }
      for (const el of found) {
        if (!el.getClientRects().length) continue;
        if (isForbidden(el, rules)) continue;
        const label = clickLabel(el);
        const looksClose = /close|back/i.test(label) || (rules.CLOSE_TEXTS || []).some((p) => rx(p).test(text(el)));
        if (!looksClose) continue;
        const b = el.getBoundingClientRect();
        // The X sits at the top-left of the detail view.
        candidates.push({ el, score: (b.left - rect.left) + (b.top - rect.top) * 1.5, label: label.slice(0, 60) });
      }
      if (candidates.length) break;
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates.length ? candidates[0] : null;
  }

  /** Wall-clock wait that treats a hidden tab as slow, never as failed. */
  async function waitFor(predicate, rules, label) {
    const h = rules.HARVEST || { renderTimeoutMs: 15000, hiddenMultiplier: 4, minPolls: 4, pollMs: 250 };
    const started = Date.now();
    let polls = 0;
    let wasHidden = document.hidden;

    while (true) {
      polls++;
      let hit = false;
      try { hit = Boolean(predicate()); } catch { hit = false; }
      if (hit) return { ok: true, polls, ms: Date.now() - started, throttled: wasHidden };
      if (document.hidden) wasHidden = true;
      const budget = h.renderTimeoutMs * (wasHidden ? h.hiddenMultiplier : 1);
      if (polls >= h.minPolls && Date.now() - started > budget) {
        return { ok: false, polls, ms: Date.now() - started, throttled: wasHidden, label };
      }
      await sleep(h.pollMs);
    }
  }

  JR.detect = {
    text, rx, sleep, clickLabel, isForbidden,
    evidenceIn, deepestMatch, nearestCommonAncestor,
    findDetailView, findCloseAffordance, waitFor,
    urlNow: () => location.href
  };
})();
