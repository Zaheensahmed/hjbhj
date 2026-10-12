// content/label.js -- injected, classic script. Runs only after you click the
// toolbar button. Reads the DOM. Writes nothing.
//
// Label resolution is a cascade. The strategy that fires is recorded along with
// a weight, because that weight is what separates a confident match from a
// guess: autocomplete="email" is not the same evidence as an id of "fld_7".

(() => {
  const JAF = (globalThis.JAF = globalThis.JAF || {});

  const STRATEGIES = [
    { name: "autocomplete", weight: 1.0 },
    { name: "aria-labelledby", weight: 0.95 },
    { name: "aria-label", weight: 0.95 },
    { name: "label-for", weight: 0.95 },
    { name: "label-ancestor", weight: 0.9 },
    { name: "legend", weight: 0.9 },
    { name: "ats-container", weight: 0.8 },
    { name: "preceding-text", weight: 0.7 },
    { name: "placeholder", weight: 0.6 },
    { name: "attribute", weight: 0.45 }
  ];
  const weightOf = (name) => (STRATEGIES.find((s) => s.name === name) || { weight: 0.4 }).weight;

  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");

  // Containers used by Greenhouse, Lever and most simple career sites.
  const ATS_CONTAINER = [
    ".field", ".application-question", ".application-field", ".form-field",
    "[class*='question']", "[class*='field']", ".input-wrapper", "fieldset",
    "[data-qa]", ".form-group", "li"
  ].join(",");

  function labelForAttr(el) {
    if (!el.id) return "";
    const esc = globalThis.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
    const lbl = document.querySelector(`label[for="${esc}"]`);
    return text(lbl);
  }

  function ancestorLabel(el) {
    const lbl = el.closest("label");
    if (!lbl) return "";
    const clone = lbl.cloneNode(true);
    for (const ctl of clone.querySelectorAll("input,select,textarea,button")) ctl.remove();
    return text(clone);
  }

  function labelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return "";
    return ids.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(" ");
  }

  function legendFor(el) {
    const fs = el.closest("fieldset");
    if (!fs) return "";
    return text(fs.querySelector("legend"));
  }

  function atsContainerLabel(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth++ < 5) {
      if (node.matches && node.matches(ATS_CONTAINER)) {
        const cand = node.querySelector("label, .label, legend, [class*='label'], h3, h4, p, span, div");
        if (cand && !cand.contains(el)) {
          const t = text(cand);
          if (t && t.length < 300) return t;
        }
        const clone = node.cloneNode(true);
        for (const ctl of clone.querySelectorAll("input,select,textarea,button,option")) ctl.remove();
        const t = text(clone);
        if (t && t.length < 300) return t;
      }
      node = node.parentElement;
    }
    return "";
  }

  function precedingText(el) {
    let node = el.previousSibling;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, " ").trim();
        if (t.length > 1) return t;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!node.matches("input,select,textarea,script,style")) {
          const t = text(node);
          if (t && t.length < 300) return t;
        }
      }
      node = node.previousSibling;
    }
    const parent = el.parentElement;
    if (parent) {
      const prev = parent.previousElementSibling;
      if (prev && !prev.matches("input,select,textarea,script,style")) {
        const t = text(prev);
        if (t && t.length < 300) return t;
      }
    }
    return "";
  }

  function fromAttributes(el) {
    const raw = el.getAttribute("name") || el.id || "";
    if (!raw) return "";
    return raw
      .replace(/[_\-.]+/g, " ")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/\[\]|\d{3,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** @returns {{labelRaw:string, labelSource:string, labelWeight:number}} */
  JAF.resolveLabel = function resolveLabel(el, isGroup) {
    const attempts = [
      ["aria-labelledby", labelledBy(el)],
      ["aria-label", (el.getAttribute("aria-label") || "").trim()],
      ["label-for", labelForAttr(el)],
      ["label-ancestor", isGroup ? "" : ancestorLabel(el)],
      ["legend", isGroup ? legendFor(el) : ""],
      ["ats-container", atsContainerLabel(el)],
      ["preceding-text", precedingText(el)],
      ["placeholder", (el.getAttribute("placeholder") || "").trim()],
      ["attribute", fromAttributes(el)]
    ];
    if (isGroup) {
      // For a radio or checkbox group the question lives on the fieldset or
      // container, so try those before anything attached to one input.
      attempts.unshift(["legend", legendFor(el)]);
    }
    for (const [name, value] of attempts) {
      if (value && value.length > 1) {
        return { labelRaw: value.slice(0, 400), labelSource: name, labelWeight: weightOf(name) };
      }
    }
    return { labelRaw: "", labelSource: "none", labelWeight: 0.2 };
  };

  JAF.labelWeightOf = weightOf;
})();
