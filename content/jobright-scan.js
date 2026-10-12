// content/jobright-scan.js -- injected, classic script. Reads a Jobright board
// into plain JSON. Writes one attribute per card so stage 2 can find the same
// card again.
//
// It reads text and hrefs. It clicks nothing. There is no reference to any
// apply affordance in this file beyond recording which one is present, and
// test/smoke.mjs greps for that.
//
// The patterns live in rules/jobright-rules.js, which cannot be imported into a
// classic content script, so the popup passes them in. That keeps one copy of
// the rules and lets node test them.

(() => {
  console.log("[JAF injected] jobright-scan.js (board scanner)");
  const JR = (globalThis.JAF_JR = globalThis.JAF_JR || {});
  let counter = 0;

  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/[^\S\n]+/g, " ").trim() : "");

  function visible(el) {
    if (!el.getClientRects().length && !el.offsetParent) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  // Patterns arrive as {source, flags} because executeScript args have to be
  // JSON-serializable and a RegExp serializes to {}. A real RegExp also exposes
  // .source and .flags, so this accepts either shape.
  const rx = (p) => new RegExp(p.source, String(p.flags || "").replace("g", ""));

  function firstMatch(patterns, haystack) {
    for (const p of patterns) {
      const m = haystack.match(rx(p));
      if (m) return m;
    }
    return null;
  }

  function dedupeToInnermost(elements) {
    return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
  }

  function evidenceCount(body, rules) {
    return rules.CARD_EVIDENCE.filter((p) => rx(p).test(body)).length;
  }

  function findCards(rules) {
    // Preferred path: a container selector that actually exists on the page.
    for (const sel of rules.CARD_SELECTORS) {
      let found;
      try { found = [...document.querySelectorAll(sel)]; } catch { continue; }
      const good = found.filter((el) => {
        if (!visible(el)) return false;
        const body = text(el);
        return body.length >= rules.MIN_CARD_TEXT && body.length <= rules.MAX_CARD_TEXT && evidenceCount(body, rules) >= 1;
      });
      const inner = dedupeToInnermost(good);
      if (inner.length >= 2) return { cards: inner, strategy: `selector ${sel}` };
    }

    // Fallback: the smallest visible elements that read like a job card. Used
    // when the class names have changed, which is the likely failure mode.
    const all = [...document.querySelectorAll("div, li, article, section")].filter((el) => {
      if (!visible(el)) return false;
      const body = text(el);
      if (body.length < rules.MIN_CARD_TEXT || body.length > rules.MAX_CARD_TEXT) return false;
      return evidenceCount(body, rules) >= 2;
    });
    const inner = dedupeToInnermost(all);
    return { cards: inner, strategy: inner.length ? "text heuristic" : "nothing matched" };
  }

  function listingUrl(el, rules) {
    const anchors = [...el.querySelectorAll("a[href]")];
    for (const p of rules.LISTING_HREF_PATTERNS) {
      const re = rx(p);
      const hit = anchors.find((a) => re.test(a.getAttribute("href") || "") || re.test(a.href || ""));
      if (hit) return new URL(hit.href, location.href).href.split("?")[0];
    }
    const first = anchors.find((a) => /^https?:|^\//.test(a.getAttribute("href") || ""));
    return first ? new URL(first.href, location.href).href.split("?")[0] : null;
  }

  function parseTerm(body, rules) {
    const m = firstMatch(rules.FIELD_PATTERNS.startTerm, body);
    if (!m) return null;
    const parts = [m[1], m[2]].filter(Boolean).map(String);
    const season = (parts.find((p) => /^(summer|fall|autumn|winter|spring)$/i.test(p)) || "").toLowerCase();
    const year = Number(parts.find((p) => /^20\d{2}$/.test(p))) || null;
    if (!season) return null;
    return {
      season: season === "autumn" ? "fall" : season,
      year,
      label: m[0].replace(/^start\s+in\s+/i, "").trim()
    };
  }

  function parseApplicants(body, rules) {
    const m = firstMatch(rules.FIELD_PATTERNS.applicants, body);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function parsePosted(body, rules) {
    const m = firstMatch(rules.FIELD_PATTERNS.posted, body);
    if (!m) return null;
    return { raw: m[0].trim(), reposted: /^re/i.test(m[1] || "") };
  }

  function parseArrangement(body, rules) {
    const m = firstMatch(rules.FIELD_PATTERNS.arrangement, body);
    if (!m) return null;
    const v = m[1].toLowerCase().replace(/[\s-]/g, "");
    if (v === "remote" || v === "workfromhome") return "Remote";
    if (v === "hybrid") return "Hybrid";
    return "Onsite";
  }

  function parseTags(body, rules) {
    const out = [];
    for (const tag of rules.MATCH_PANEL_TAGS) {
      const re = new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i");
      if (re.test(body)) out.push(tag);
    }
    return out;
  }

  function parseApplyButtons(el, body, rules) {
    const labels = [...el.querySelectorAll("button, a, [role='button']")].map((n) => text(n)).join(" | ");
    const haystack = labels + " | " + body;
    const present = [];
    for (const b of rules.APPLY_BUTTONS) {
      if (b.patterns.some((p) => rx(p).test(haystack))) present.push(b.id);
    }
    return present;
  }

  function titleAndCompany(el, body) {
    // Headings first, then the strongest-looking link, then the first two lines.
    const heading = el.querySelector("h1, h2, h3, h4, [class*='title'], [class*='Title']");
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = text(heading) || lines[0] || "";
    const companyEl = el.querySelector("[class*='company'], [class*='Company'], [class*='employer']");
    let company = text(companyEl);
    if (!company) {
      const idx = lines.indexOf(title);
      company = (idx >= 0 ? lines[idx + 1] : lines[1]) || "";
    }
    return { title: title.slice(0, 200), company: company.slice(0, 160) };
  }

  /**
   * @param {object} rules  rules/jobright-rules.js, passed in from the popup
   */
  JR.scanBoard = function scanBoard(rules) {
    counter = 0;
    for (const el of document.querySelectorAll("[data-jaf-card]")) delete el.dataset.jafCard;

    const { cards, strategy } = findCards(rules);
    const out = [];

    for (const el of cards) {
      const body = text(el);
      el.dataset.jafCard = "card-" + ++counter;

      const { title, company } = titleAndCompany(el, body);
      const locMatch = firstMatch(rules.FIELD_PATTERNS.location, body);
      const payMatch = firstMatch(rules.FIELD_PATTERNS.pay, body);
      const typeMatch = firstMatch(rules.FIELD_PATTERNS.jobType, body);
      const pctMatch = firstMatch(rules.FIELD_PATTERNS.matchPercent, body);
      const labelMatch = firstMatch(rules.FIELD_PATTERNS.matchLabel, body);
      const alumniMatch = firstMatch(rules.FIELD_PATTERNS.alumni, body);

      out.push({
        cardId: el.dataset.jafCard,
        index: counter,
        listingUrl: listingUrl(el, rules),
        title,
        company,
        location: locMatch ? locMatch[1].trim() : null,
        arrangement: parseArrangement(body, rules),
        jobType: typeMatch ? typeMatch[1] : null,
        pay: payMatch ? payMatch[0].trim() : null,
        startTerm: parseTerm(body, rules),
        applicants: parseApplicants(body, rules),
        posted: parsePosted(body, rules),
        earlyApplicant: rules.FIELD_PATTERNS.earlyApplicant.some((p) => rx(p).test(body)),
        alumni: alumniMatch ? Number(alumniMatch[1]) : null,
        matchPercent: pctMatch ? Number(pctMatch[1]) : null,
        matchLabel: labelMatch ? labelMatch[0].trim() : null,
        tags: parseTags(body, rules),
        applyButtons: parseApplyButtons(el, body, rules),
        industry: null,
        rawText: body.slice(0, 1500)
      });
    }

    return {
      host: location.hostname,
      url: location.href.split("?")[0],
      strategy,
      cardCount: out.length,
      cards: out,
      // Reported so a zero-card scan is diagnosable rather than mysterious.
      pageTextLength: (document.body.innerText || "").length
    };
  };

  JR.focusCard = function focusCard(cardId) {
    const el = document.querySelector(`[data-jaf-card="${cardId}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.outline = "3px solid #2563eb";
    el.style.outlineOffset = "2px";
    setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 2500);
    return true;
  };
})();
