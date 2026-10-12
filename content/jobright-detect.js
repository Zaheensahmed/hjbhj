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

  // --------------------------------------------------------------- activation

  function describeElement(el) {
    if (!el) return null;
    return {
      tagName: el.tagName,
      id: el.id || null,
      className: typeof el.className === "string" ? el.className.slice(0, 200) : null,
      role: el.getAttribute ? el.getAttribute("role") : null,
      href: el.getAttribute ? el.getAttribute("href") : null,
      text: text(el).slice(0, 80),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      outerHTML: (el.outerHTML || "").slice(0, 300)
    };
  }

  const clickable = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    if (/^(A|BUTTON)$/.test(el.tagName)) return true;
    if (el.getAttribute && el.getAttribute("role") === "button") return true;
    if (typeof el.onclick === "function") return true;
    try { return getComputedStyle(el).cursor === "pointer"; } catch { return false; }
  };

  /**
   * Targets to try, best first. A bare click on the card container is last,
   * because a React card usually binds its handler to an inner control.
   */
  function clickCandidates(cardEl, rules) {
    const out = [];
    const push = (el, why) => {
      if (!el || out.some((c) => c.el === el)) return;
      const blocked = isForbidden(el, rules);
      out.push({ el, why, forbidden: blocked, describe: describeElement(el) });
    };

    push(cardEl.querySelector("h1 a, h2 a, h3 a, h4 a, [class*='title'] a, a[class*='title']"), "title anchor");
    push(cardEl.querySelector("h1, h2, h3, h4, [class*='title'], [class*='Title']"), "title heading");

    for (const p of rules.LISTING_HREF_PATTERNS || []) {
      const re = rx(p);
      const hit = [...cardEl.querySelectorAll("a[href]")].find((a) => re.test(a.getAttribute("href") || "") || re.test(a.href || ""));
      if (hit) { push(hit, "anchor matching LISTING_HREF_PATTERNS"); break; }
    }

    const biggest = [...cardEl.querySelectorAll("*")]
      .filter((el) => el !== cardEl && clickable(el))
      .map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; })
      .sort((a, b) => b.area - a.area)[0];
    if (biggest) push(biggest.el, "largest clickable descendant");

    push(cardEl, "the card container itself");
    return out;
  }

  /**
   * A real pointer sequence. React frequently ignores a bare element.click()
   * on a container, because its handler is bound to pointer or mouse events.
   *
   * This is the ONLY way anything in the extension activates a page element,
   * and it refuses FORBIDDEN_CLICK before dispatching anything.
   */
  function activate(el, rules, why, recorder) {
    if (!el) return { ok: false, reason: "no element" };
    const blocked = isForbidden(el, rules);
    if (blocked) {
      if (recorder) recorder.refusals.push({ why, label: clickLabel(el).slice(0, 160), matched: blocked, at: new Date().toISOString() });
      return { ok: false, reason: `refused: matches ${blocked}`, forbidden: blocked };
    }

    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true,
                   clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    try { el.scrollIntoView({ block: "center" }); } catch { /* not scrollable */ }

    const dispatched = [];
    for (const [type, Ctor] of [["pointerdown", globalThis.PointerEvent || MouseEvent],
                                ["mousedown", MouseEvent], ["pointerup", globalThis.PointerEvent || MouseEvent],
                                ["mouseup", MouseEvent], ["click", MouseEvent]]) {
      try {
        el.dispatchEvent(new Ctor(type, type.startsWith("pointer") ? { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse" } : opts));
        dispatched.push(type);
      } catch (err) {
        dispatched.push(`${type} FAILED: ${err.message}`);
      }
    }
    if (recorder) recorder.clicks.push({ why, label: clickLabel(el).slice(0, 80), dispatched });
    return { ok: true, dispatched, describe: describeElement(el) };
  }

  // ------------------------------------------------------------- dom deltas

  function domSnapshot() {
    const overlays = [...document.querySelectorAll("body *")].filter((el) => {
      try {
        const s = getComputedStyle(el);
        if (!el.getClientRects().length) return false;
        return (s.position === "fixed" || s.position === "absolute") && Number(s.zIndex) >= 100;
      } catch { return false; }
    });
    return {
      bodyTextLength: text(document.body).length,
      elementCount: document.body.querySelectorAll("*").length,
      highLayerCount: overlays.length,
      highLayerSignature: overlays.slice(0, 8).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)}`),
      url: location.href
    };
  }

  function domDelta(before) {
    const after = domSnapshot();
    return {
      before, after,
      bodyTextChanged: after.bodyTextLength - before.bodyTextLength,
      elementsChanged: after.elementCount - before.elementCount,
      newHighLayers: after.highLayerCount - before.highLayerCount,
      urlChanged: after.url !== before.url,
      anythingChanged: after.bodyTextLength !== before.bodyTextLength ||
                       after.elementCount !== before.elementCount ||
                       after.highLayerCount !== before.highLayerCount ||
                       after.url !== before.url
    };
  }

  JR.detect = {
    describeElement, clickCandidates, activate, clickable,
    domSnapshot, domDelta,
    text, rx, sleep, clickLabel, isForbidden,
    evidenceIn, deepestMatch, nearestCommonAncestor,
    findDetailView, findCloseAffordance, waitFor,
    urlNow: () => location.href
  };
})();
