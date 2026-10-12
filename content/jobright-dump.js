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
  const JR = (globalThis.JAF_JR = globalThis.JAF_JR || {});
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/[^\S\n]+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rx = (p) => new RegExp(p.source, String(p.flags || "").replace("g", ""));
  const cut = (s, n) => (s == null ? "null" : String(s).length > n ? String(s).slice(0, n) + ` …(+${String(s).length - n})` : String(s));

  function label(el) {
    return [el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("title"),
            text(el).slice(0, 120), typeof el.className === "string" ? el.className : ""].filter(Boolean).join(" | ");
  }
  function forbidden(el, rules) {
    const l = label(el);
    for (const p of rules.FORBIDDEN_CLICK) if (rx(p).test(l)) return p.source;
    return null;
  }

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

  function findPanel(rules) {
    const score = (body) => rules.PANEL_EVIDENCE.filter((p) => rx(p).test(body)).length;
    for (const sel of rules.PANEL_SELECTORS) {
      let found; try { found = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hit = found.find((el) => el.getClientRects().length && score(text(el)) >= 2);
      if (hit) return { panel: hit, via: sel };
    }
    const all = [...document.querySelectorAll("div, aside, section")].filter(
      (el) => el.getClientRects().length && score(text(el)) >= 3 && text(el).length > 200);
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    return { panel: inner[0] || null, via: inner.length ? "text heuristic" : "none" };
  }

  function findCloseButton(panel, rules) {
    const r = panel.getBoundingClientRect();
    const out = [];
    for (const sel of rules.CLOSE_SELECTORS) {
      let found; try { found = [...panel.querySelectorAll(sel)]; } catch { continue; }
      for (const el of found) {
        if (!el.getClientRects().length || forbidden(el, rules)) continue;
        if (!/close/i.test(label(el)) && !rules.CLOSE_TEXTS.some((p) => rx(p).test(text(el)))) continue;
        const b = el.getBoundingClientRect();
        out.push({ el, score: (b.left - r.left) + (b.top - r.top) * 1.5 });
      }
      if (out.length) break;
    }
    out.sort((a, b) => a.score - b.score);
    return out.length ? out[0].el : null;
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

    const block = forbidden(card, rules);
    if (block) { report.refusals.push({ what: "the card itself", matched: block }); return { ...report, error: "Refused to click the card." }; }

    const before = findPanel(rules).panel;
    card.click();
    report.steps.push("clicked the card open");

    const deadline = Date.now() + (document.hidden ? 60000 : 15000);
    let panel = null, via = "none";
    while (Date.now() < deadline) {
      const f = findPanel(rules);
      if (f.panel && f.panel !== before && text(f.panel).length > 200) { panel = f.panel; via = f.via; break; }
      await sleep(250);
    }
    if (!panel) return { ...report, error: "The detail panel never rendered. PANEL_SELECTORS and PANEL_EVIDENCE are the things to check." };

    report.panel = {
      foundVia: via, tagName: panel.tagName,
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

    // ---- close it again, through the same guard
    const closeBtn = findCloseButton(panel, rules);
    if (closeBtn) { closeBtn.click(); report.steps.push("clicked the panel's close control"); }
    else {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      report.steps.push("no close control found; sent Escape");
    }
    report.finishedAt = new Date().toISOString();
    return report;
  };
})();
