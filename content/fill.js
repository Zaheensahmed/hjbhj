// content/fill.js -- injected, classic script.
//
// This file writes .value and .checked on input, select and textarea elements
// and dispatches the input and change events a framework needs to notice.
//
// It contains no call to .submit(), .requestSubmit() or .click(), and it never
// touches a button or an input of type submit. test/smoke.mjs asserts that by
// reading this file's source, so the guarantee survives future edits.

(() => {
  console.log("[JAF injected] fill.js (form filler)");
  const JAF = (globalThis.JAF = globalThis.JAF || {});
  const STYLE_ID = "jaf-highlight-style";

  const CSS_TEXT = `
    .jaf-confident { outline: 2px solid #16a34a !important; outline-offset: 1px !important; }
    .jaf-review    { outline: 2px solid #2563eb !important; outline-offset: 1px !important; }
    .jaf-unknown   { outline: 2px solid #d97706 !important; outline-offset: 1px !important; }
    .jaf-manual    { outline: 2px dashed #d97706 !important; outline-offset: 1px !important; }
    .jaf-upload    { outline: 3px dashed #dc2626 !important; outline-offset: 2px !important; }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    document.head.appendChild(s);
  }

  function byJafId(id) {
    return document.querySelector(`[data-jaf-id="${id}"]`);
  }

  function clearMarks() {
    for (const el of document.querySelectorAll(".jaf-confident, .jaf-review, .jaf-unknown, .jaf-manual, .jaf-upload")) {
      el.classList.remove("jaf-confident", "jaf-review", "jaf-unknown", "jaf-manual", "jaf-upload");
    }
  }

  // React and Vue track their own value, so a plain assignment gets reverted on
  // the next render. Going through the prototype's native setter makes the
  // framework see a real user edit.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, names) {
    for (const n of names) el.dispatchEvent(new Event(n, { bubbles: true }));
  }

  JAF.applyPlan = function applyPlan(payload) {
    ensureStyle();
    clearMarks();

    const applied = [];
    const failed = [];

    for (const item of payload.plan || []) {
      const el = byJafId(item.targetJafId);
      if (!el) { failed.push({ ...item, why: "element no longer on the page" }); continue; }

      try {
        if (item.kind === "check") {
          el.checked = true;
          fire(el, ["input", "change"]);
        } else if (item.kind === "select") {
          setNativeValue(el, item.value);
          if (el.value !== item.value) {
            const opt = [...el.options].find((o) => o.value === item.value);
            if (opt) el.selectedIndex = opt.index;
          }
          fire(el, ["input", "change"]);
        } else {
          el.focus({ preventScroll: true });
          setNativeValue(el, item.value);
          fire(el, ["input", "change"]);
          el.blur();
        }
        el.classList.add(item.tier === "confident" ? "jaf-confident" : "jaf-review");
        applied.push({ jafId: item.targetJafId, ruleId: item.ruleId, tier: item.tier });
      } catch (err) {
        failed.push({ ...item, why: String(err && err.message ? err.message : err) });
      }
    }

    for (const id of payload.unknownIds || []) {
      const el = byJafId(id);
      if (el) el.classList.add("jaf-unknown");
    }
    for (const id of payload.manualIds || []) {
      const el = byJafId(id);
      if (el) el.classList.add("jaf-manual");
    }
    for (const id of payload.uploadIds || []) {
      const el = byJafId(id);
      if (el) el.classList.add("jaf-upload");
    }

    return { applied, failed };
  };

  JAF.focusField = function focusField(jafId) {
    const el = byJafId(jafId);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    try { el.focus({ preventScroll: true }); } catch { /* not focusable, scrolling is enough */ }
    return true;
  };

  JAF.clearMarks = clearMarks;
})();
