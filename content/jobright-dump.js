// content/jobright-dump.js -- injected, classic script. A diagnostic, not part
// of the pipeline.
//
// Opens one card, waits for the detail panel, and dumps everything about the
// control whose text says "Original Job Post": what element it actually is,
// every attribute it carries, its ancestors and descendants, and where a URL
// might be hiding if it has no href.
//
// It clicks exactly one thing, the card, through the same FORBIDDEN_CLICK
// guard the harvest loop uses, and closes the panel the same way. It reads
// everything else. It never clicks the control it is describing.

(() => {
  console.log("[JAF injected] jobright-dump.js (panel DOM dump)");
  const JR = (globalThis.JAF_JR = globalThis.JAF_JR || {});
  // Detection is shared with the harvest loop, in content/jobright-detect.js,
  // so the two cannot drift apart.
  const D = () => globalThis.JAF_JR.detect;
  const text = (el) => D().text(el);
  const sleep = (ms) => D().sleep(ms);
  const rx = (p) => D().rx(p);
  const cut = (s, n) => (s == null ? "null" : String(s).length > n ? String(s).slice(0, n) + ` …(+${String(s).length - n})` : String(s));

  const label = (el) => D().clickLabel(el);
  const forbidden = (el, rules) => D().isForbidden(el, rules);

  /**
   * Classify an href, because "no destination" has four different causes and
   * they need different fixes. A jobright.ai href is especially worth naming:
   * resolveDestination() rejects those outright, so a redirect link would
   * present exactly as "link found, destination null".
   */
  function hrefKind(href) {
    if (href == null) return "no href attribute";
    const h = String(href).trim();
    if (!h) return "empty href";
    if (/^#/.test(h)) return "fragment only";
    if (/^javascript:/i.test(h)) return "javascript: handler";
    if (/jobright\.ai/i.test(h) || /^\/(?!\/)/.test(h)) {
      const target = (h.match(/[?&](?:to|url|target|redirect|dest|u)=([^&]+)/i) || [])[1];
      return target
        ? `jobright-internal redirect, carries a target param: ${cut(decodeURIComponent(target), 160)}`
        : "jobright-internal or relative, no target param found";
    }
    if (/^https?:\/\//i.test(h)) return "external absolute URL";
    return "other";
  }

  function attrs(el) {
    if (!el || !el.attributes) return [];
    return [...el.attributes].map((a) => ({ name: a.name, value: cut(a.value, 300) }));
  }

  function describe(el, why) {
    return {
      why,
      tagName: el.tagName,
      role: el.getAttribute ? el.getAttribute("role") : null,
      text: cut(text(el), 120),
      attributes: attrs(el),
      hasOnclickProperty: typeof el.onclick === "function",
      outerHTML: cut(el.outerHTML, 400)
    };
  }

  /** Walk up, recording any ancestor that is an anchor or carries data-*. */
  function ancestry(el, depth = 8) {
    const out = [];
    let node = el.parentElement;
    for (let i = 0; node && i < depth; i++, node = node.parentElement) {
      const data = attrs(node).filter((a) => a.name.startsWith("data-") || a.name === "href");
      if (node.tagName === "A" || data.length) {
        out.push({ level: i + 1, tagName: node.tagName, href: node.getAttribute("href"), attributes: data,
                   outerHTMLStart: cut(node.outerHTML, 200) });
      }
    }
    return out;
  }

  function anchorsInside(el) {
    return [...el.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"), hrefKind: hrefKind(a.getAttribute("href")),
      text: cut(text(a), 60), attributes: attrs(a)
    }));
  }

  function siblingAnchors(el) {
    const p = el.parentElement;
    if (!p) return [];
    return [...p.children].filter((c) => c !== el).flatMap((c) =>
      (c.tagName === "A" ? [c] : [...c.querySelectorAll("a")]).map((a) => ({
        href: a.getAttribute("href"), text: cut(text(a), 60)
      }))).slice(0, 10);
  }

  /** Any URL-looking value in embedded JSON, reported by key path. */
  function embeddedJson() {
    const found = [];
    const KEYISH = /(apply|job|original|external|source|post|redirect|company)?\s*(url|link|href|uri)$/i;
    const URLISH = /^https?:\/\//i;

    const walk = (obj, path, out, depth = 0) => {
      if (depth > 8 || out.length > 40 || obj == null) return;
      if (typeof obj === "string") {
        if (URLISH.test(obj) && !/jobright\.ai/i.test(obj)) out.push({ path, value: cut(obj, 200) });
        return;
      }
      if (typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (out.length > 40) return;
        if (typeof v === "string" && (KEYISH.test(k) || URLISH.test(v))) {
          if (URLISH.test(v)) out.push({ path: `${path}.${k}`, value: cut(v, 200) });
          else if (KEYISH.test(k) && v.length > 4) out.push({ path: `${path}.${k}`, value: cut(v, 200), note: "key looks like a link but value is not a URL" });
        } else {
          walk(v, `${path}.${k}`, out, depth + 1);
        }
      }
    };

    // Next.js payload
    const next = document.getElementById("__NEXT_DATA__");
    if (next) {
      try { walk(JSON.parse(next.textContent), "__NEXT_DATA__", found); }
      catch (e) { found.push({ path: "__NEXT_DATA__", value: "present but did not parse: " + e.message }); }
    }
    // Any other JSON script blocks
    for (const s of [...document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')].slice(0, 6)) {
      try { walk(JSON.parse(s.textContent), s.id || s.type, found); } catch { /* not JSON */ }
    }
    // Shallow sweep of globals the app may have left behind
    for (const key of ["__NUXT__", "__APOLLO_STATE__", "__INITIAL_STATE__", "__remixContext", "jobData", "appData"]) {
      try { if (globalThis[key]) walk(globalThis[key], `window.${key}`, found); } catch { /* cross-origin or getter */ }
    }
    return {
      hasNextData: Boolean(next),
      jsonScriptCount: document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').length,
      candidates: found.slice(0, 40)
    };
  }

  /**
   * @param {{rules:object, cardId?:string}} opts
   */
  JR.dumpPanel = async function dumpPanel(opts) {
    const rules = opts.rules;
    const report = { startedAt: new Date().toISOString(), steps: [], refusals: [] };

    const cards = [...document.querySelectorAll("[data-jaf-card]")];
    const card = opts.cardId ? cards.find((c) => c.dataset.jafCard === opts.cardId) : cards[0];
    if (!card) return { error: "No scanned cards on the page. Run Scan this board first." };

    const urlBefore = location.href;
    const evidenceBefore = D().evidenceIn(rules, document.body).hits.length;

    // Try targets best-first. A bare click on a React card container often does
    // nothing, so the container is the LAST thing tried, not the first.
    const candidates = D().clickCandidates(card, rules);
    report.clickCandidates = candidates.map((c) => ({ why: c.why, forbidden: c.forbidden, element: c.describe }));

    report.attempts = [];
    let opened = false;

    for (const cand of candidates) {
      if (cand.forbidden) {
        report.attempts.push({ why: cand.why, skipped: `refused by FORBIDDEN_CLICK: ${cand.forbidden}`, element: cand.describe });
        report.refusals.push({ why: cand.why, matched: cand.forbidden });
        continue;
      }

      const before = D().domSnapshot();
      const act = D().activate(cand.el, rules, `open card via ${cand.why}`, report);

      const settled = await D().waitFor(() => {
        const found = D().findDetailView(rules);
        return (found.found && found.evidence.length > evidenceBefore) || location.href !== urlBefore;
      }, { HARVEST: { ...(rules.HARVEST || {}), renderTimeoutMs: 4000, minPolls: 3 } }, "detail view");

      const delta = D().domDelta(before);
      const nowFound = D().findDetailView(rules);

      report.attempts.push({
        why: cand.why,
        element: cand.describe,
        eventsDispatched: act.dispatched || null,
        activateError: act.ok ? null : act.reason,
        waitedMs: settled.ms,
        evidenceAfter: nowFound.evidence,
        domDelta: delta,
        worked: nowFound.found && nowFound.evidence.length > evidenceBefore
      });

      if (nowFound.found && nowFound.evidence.length > evidenceBefore) {
        opened = true;
        report.openedVia = cand.why;
        report.steps.push(`opened the card via ${cand.why} using ${(act.dispatched || []).join(", ")}`);
        break;
      }
    }

    await sleep(600); // let any route finish painting

    const urlAfter = location.href;
    report.navigation = {
      urlBefore, urlAfter,
      urlChanged: urlAfter !== urlBefore,
      mode: urlAfter !== urlBefore ? "route (clicking a card changes the URL)" : "overlay (URL unchanged)",
      closeShouldBe: urlAfter !== urlBefore ? "history.back()" : "click the X",
      scriptSurvived: true,
      note: urlAfter !== urlBefore
        ? "This script is still running after the URL changed, so it is client-side routing and an injected loop survives it."
        : "The board stayed at the same URL, so the detail view is an overlay."
    };

    if (!opened) {
      const anyChange = report.attempts.some((a) => a.domDelta && a.domDelta.anythingChanged);
      return {
        ...report,
        error: anyChange
          ? "Every target was tried and the detail view never appeared, but the DOM did change. Something opened or re-rendered that the evidence patterns do not match."
          : "Every target was tried and NOTHING in the DOM changed. The clicks are not reaching a handler at all.",
        detection: D().findDetailView(rules).diagnostics,
        hint: anyChange
          ? "Compare evidenceAfter and domDelta per attempt below, and check PANEL_EVIDENCE against what actually rendered."
          : "No body text, element count, overlay or URL change from any target. The card may need a real trusted click, or the handler may be on an element outside the scanned card."
      };
    }

    const detail = D().findDetailView(rules);
    if (!detail.found) {
      return {
        ...report,
        error: "The detail view was not detected.",
        detection: detail.diagnostics,
        waited: settle,
        hint: "PANEL_EVIDENCE needs at least two matches in the page body. The diagnostics above list which matched, which did not, and the first lines of the body text."
      };
    }

    const panel = detail.scope;
    report.panel = {
      foundVia: detail.via,
      evidenceMatched: detail.evidence,
      tagName: panel.tagName,
      className: cut(typeof panel.className === "string" ? panel.className : "", 200),
      attributes: attrs(panel), textLength: text(panel).length,
      firstLines: text(panel).split("\n").slice(0, 8)
    };

    // ---- every element whose own text matches ORIGINAL_POST_PATTERNS
    const all = [...panel.querySelectorAll("*")];
    const matches = all.filter((el) => {
      const own = text(el);
      if (!own || own.length > 80) return false;
      return rules.ORIGINAL_POST_PATTERNS.some((p) => rx(p).test(own));
    });
    // keep the innermost, so a wrapper div does not drown the real control
    const innermost = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));

    report.originalPostMatches = innermost.map((el) => ({
      ...describe(el, "text matches ORIGINAL_POST_PATTERNS"),
      isAnchor: el.tagName === "A",
      ownHref: el.getAttribute ? el.getAttribute("href") : null,
      ownHrefKind: hrefKind(el.getAttribute ? el.getAttribute("href") : null),
      closestAnchor: (() => {
        const a = el.closest("a");
        return a ? { href: a.getAttribute("href"), hrefKind: hrefKind(a.getAttribute("href")),
                     attributes: attrs(a), outerHTMLStart: cut(a.outerHTML, 200) } : null;
      })(),
      descendantAnchors: anchorsInside(el),
      siblingAnchors: siblingAnchors(el),
      ancestorsWithDataOrHref: ancestry(el)
    }));

    // Widen the net once, in case the wording differs from our patterns.
    report.looserMatches = all
      .filter((el) => {
        const own = text(el);
        return own && own.length < 60 && /original|company site|company website|view (job|posting)|apply on/i.test(own)
          && !rules.ORIGINAL_POST_PATTERNS.some((p) => rx(p).test(own));
      })
      .filter((el, _, arr) => !arr.some((o) => o !== el && el.contains(o)))
      .slice(0, 8)
      .map((el) => ({ tagName: el.tagName, text: cut(text(el), 60), href: el.getAttribute("href"), attributes: attrs(el) }));

    // Every anchor in the panel, so an unlabelled destination is still visible.
    report.allPanelAnchors = [...panel.querySelectorAll("a[href]")]
      .map((a) => ({ href: cut(a.getAttribute("href"), 160), hrefKind: hrefKind(a.getAttribute("href")), text: cut(text(a), 50) }))
      .filter((a) => !/^#$|^javascript:/i.test(a.href))
      .slice(0, 25);

    // The one-line answer, so the cause is readable without reading the JSON.
    report.verdict = (() => {
      const m = report.originalPostMatches;
      if (!m.length) return "No element in the panel matched ORIGINAL_POST_PATTERNS. Check looserMatches for the real wording.";
      const kinds = m.map((x) => x.ownHrefKind !== "no href attribute" ? x.ownHrefKind
        : x.closestAnchor ? "on an ancestor anchor: " + x.closestAnchor.hrefKind
        : x.descendantAnchors.length ? "on a descendant anchor: " + x.descendantAnchors[0].hrefKind
        : "no href on it, its ancestors or its descendants");
      return `Matched ${m.length}. Href situation: ${kinds.join(" | ")}`;
    })();

    report.embeddedJson = embeddedJson();

    // ---- report the close affordance, then leave the way the mode requires
    const closeCand = D().findCloseAffordance(panel, rules);
    report.closeAffordance = closeCand
      ? { found: true, label: closeCand.label, tagName: closeCand.el.tagName,
          attributes: attrs(closeCand.el), outerHTMLStart: cut(closeCand.el.outerHTML, 200) }
      : { found: false, note: "No element in the detail view looked like a close control." };

    if (report.navigation.urlChanged) {
      history.back();
      report.steps.push("went back in history, since opening a card changed the URL");
      await D().waitFor(() => location.href === urlBefore, rules, "return to the board");
    } else if (closeCand) {
      const act = D().activate(closeCand.el, rules, "close detail view", report);
      report.steps.push(act.ok ? `closed via the X using ${act.dispatched.join(", ")}` : `close refused: ${act.reason}`);
    } else {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      report.steps.push("no close control found; sent Escape");
    }
    report.finishedAt = new Date().toISOString();
    return report;
  };
})();
