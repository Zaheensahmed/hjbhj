// content/scan.js -- injected, classic script. Reads the DOM into plain JSON.
// Writes one attribute (data-jaf-id) so the fill pass can find the same element
// again. No values are changed here, nothing is clicked, nothing is submitted.

(() => {
  console.log("[JAF injected] scan.js (form scanner)");
  const JAF = (globalThis.JAF = globalThis.JAF || {});
  let counter = 0;

  const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset"]);

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // Some ATS forms hide the real control and style a sibling. A zero box with
    // an opacity of 0 is still a control we can fill, so only reject it when it
    // is detached from layout entirely.
    if (!el.getClientRects().length && !el.offsetParent && style.position !== "fixed") return false;
    return true;
  }

  function tagFor(el) {
    const t = el.tagName.toLowerCase();
    if (t === "textarea") return "textarea";
    if (t === "select") return "select";
    if (el.type === "file") return "file";
    if (el.type === "radio") return "radio";
    if (el.type === "checkbox") return "checkbox";
    return "input";
  }

  function stamp(el) {
    if (!el.dataset.jafId) el.dataset.jafId = "jaf-" + ++counter;
    return el.dataset.jafId;
  }

  function optionsOfSelect(el) {
    return [...el.options]
      .filter((o) => !o.disabled)
      .map((o) => ({ value: o.value, textRaw: (o.text || "").replace(/\s+/g, " ").trim() }))
      .filter((o) => o.textRaw || o.value);
  }

  function optionLabelFor(input) {
    const { labelRaw } = JAF.resolveLabel(input, false);
    return labelRaw || input.value || "";
  }

  function detectAts() {
    const h = location.hostname;
    const html = document.documentElement.innerHTML;
    if (/myworkdayjobs\.com|workday/.test(h) || /data-automation-id/.test(html)) return "workday";
    if (/greenhouse\.io/.test(h) || /greenhouse/i.test(html)) return "greenhouse";
    if (/lever\.co/.test(h)) return "lever";
    if (/ashbyhq\.com/.test(h)) return "ashby";
    if (/icims\.com/.test(h)) return "icims";
    if (/taleo\.net/.test(h)) return "taleo";
    return "generic";
  }

  /** Job-description text, with the form's own text removed. */
  function postingText() {
    const root = document.querySelector("main, article, [role='main'], #content, .content") || document.body;
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll("form, nav, footer, header, script, style, noscript, select, textarea, input, button, label, [aria-hidden='true']")) {
      el.remove();
    }
    const t = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 300) return t.slice(0, 40000);
    // Form-dominated page, for instance an embedded Greenhouse iframe. Fall back
    // to the whole body and let the popup tell you the text looked thin.
    const body = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    return body.slice(0, 40000);
  }

  function postingTitle() {
    const h1 = document.querySelector("h1");
    const t = h1 ? (h1.innerText || "").trim() : "";
    return (t || document.title || "").slice(0, 300);
  }

  JAF.scan = function scan() {
    counter = 0;
    for (const el of document.querySelectorAll("[data-jaf-id]")) delete el.dataset.jafId;

    const controls = [...document.querySelectorAll("input, select, textarea")];
    const fields = [];
    const groups = new Map();

    for (const el of controls) {
      const type = (el.type || "text").toLowerCase();
      if (SKIP_TYPES.has(type)) continue;
      if (type !== "file" && !visible(el)) continue;

      const tag = tagFor(el);

      if (tag === "radio" || (tag === "checkbox" && el.name && controls.filter((c) => c.type === "checkbox" && c.name === el.name).length > 1)) {
        const key = (tag === "radio" ? "r:" : "c:") + (el.name || stamp(el));
        if (!groups.has(key)) groups.set(key, { kind: tag, name: el.name, members: [] });
        groups.get(key).members.push(el);
        continue;
      }

      const label = JAF.resolveLabel(el, false);
      fields.push({
        jafId: stamp(el),
        tag,
        type,
        name: el.name || null,
        id: el.id || null,
        autocomplete: (el.getAttribute("autocomplete") || "").trim().toLowerCase() || null,
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
        maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
        max: el.getAttribute("max"),
        placeholder: (el.getAttribute("placeholder") || "").trim() || null,
        currentValue: tag === "checkbox" ? String(el.checked) : (el.value || ""),
        options: tag === "select" ? optionsOfSelect(el) : [],
        ...label
      });
    }

    for (const [, group] of groups) {
      const first = group.members[0];
      const label = JAF.resolveLabel(first, true);
      fields.push({
        jafId: stamp(first),
        tag: group.kind === "radio" ? "radiogroup" : "checkboxgroup",
        type: group.kind,
        name: group.name,
        id: null,
        autocomplete: null,
        required: group.members.some((m) => m.required),
        maxLength: null,
        max: null,
        placeholder: null,
        currentValue: (group.members.find((m) => m.checked) || {}).value || "",
        options: group.members.map((m) => ({
          jafId: stamp(m),
          value: m.value,
          textRaw: optionLabelFor(m),
          checked: m.checked
        })),
        ...label
      });
    }

    const uploads = [...document.querySelectorAll("input[type=file]")].map((el) => {
      const label = JAF.resolveLabel(el, false);
      return {
        jafId: stamp(el),
        tag: "file",
        type: "file",
        name: el.name || null,
        id: el.id || null,
        required: Boolean(el.required),
        accept: el.getAttribute("accept") || null,
        hasFile: Boolean(el.files && el.files.length),
        autocomplete: null, maxLength: null, max: null, placeholder: null,
        currentValue: "", options: [],
        ...label
      };
    });

    return {
      ats: detectAts(),
      host: location.hostname,
      url: location.href.split("?")[0],
      title: postingTitle(),
      postingText: postingText(),
      fields: fields.filter((f) => f.tag !== "file"),
      uploads,
      formCount: document.forms.length
    };
  };

  // Nothing runs on its own. The popup calls JAF.scan() explicitly.
})();
