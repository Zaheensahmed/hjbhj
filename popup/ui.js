// popup/ui.js -- shared rendering. Both the page tab and the paste tab use
// these, so the two paths cannot drift in how they report eligibility, role
// inference or assembled output.
//
// Everything that originates on a page or in pasted text goes through esc().

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function show(el, on) {
  const node = typeof el === "string" ? $(el) : el;
  if (node) node.hidden = !on;
}

export function setStatus(text, kind) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

export function eligibilityHtml(e, profile, opts = {}) {
  const out = [];
  if (e.insufficientText) {
    out.push(`<div class="banner blue">${esc(e.note)}</div>`);
    return out.join("");
  }
  if (e.blockers.length) {
    out.push(`<div class="banner red"><strong>${e.blockers.length} hard blocker${e.blockers.length > 1 ? "s" : ""}.</strong> ${
      opts.blocked ? "Assembly skipped." : "Continuing anyway at your request."
    }</div>`);
  }
  for (const b of e.blockers) {
    out.push(`<div class="card red">
      <div><strong>${esc(b.filter)}</strong>${b.confidence === "low" ? ' <span class="tagline">(low confidence, read it yourself)</span>' : ""}</div>
      <blockquote>${esc(b.sentence)}</blockquote>
      <div class="why">${esc(b.why)}</div>
    </div>`);
  }
  for (const f of e.flags) {
    out.push(`<div class="card amber">
      <div><strong>${esc(f.filter)}</strong>${f.unclear ? ' <span class="tagline">(unclear, read it yourself)</span>' : ""}</div>
      <blockquote>${esc(f.sentence)}</blockquote>
      <div class="why">${esc(f.argue)}</div>
    </div>`);
  }
  if (e.cleared.length) {
    out.push(`<p class="note">Checked and cleared: ${e.cleared.map((c) => esc(c.id)).join(", ")}.</p>`);
  }
  if (!e.blockers.length && !e.flags.length) {
    out.push(`<div class="banner blue">No blockers or flags found. ${esc(e.alwaysViable)}</div>`);
  }
  if (e.blockers.length && opts.showOverride) {
    out.push(`<div class="row"><button id="${esc(opts.overrideId || "override")}">Assemble anyway</button></div>`);
  }
  return out.join("");
}

export function roleHtml(posting, assembled, opts = {}) {
  const roles = posting.roles.all;
  const current = opts.override || (assembled && assembled.roleType) || "";
  const selectId = opts.selectId || "role-select";

  const options = ['<option value="">Infer from the posting</option>']
    .concat(roles.map((r) => `<option value="${esc(r.role)}"${r.role === opts.override ? " selected" : ""}>${esc(r.role)} (${r.score})</option>`))
    .join("");

  const hits = roles[0] && roles[0].hits.length
    ? roles[0].hits.map((h) => esc(h.pattern) + (h.inTitle ? " [title]" : "")).join(", ")
    : "nothing matched";

  return `
    <div class="card ${assembled && assembled.roleType ? "blue" : "amber"}">
      <div><strong>${esc(current || "Role type not inferred")}</strong></div>
      <div class="meta">${esc(posting.roles.reason)}</div>
      <div class="meta">Top matches: ${hits}</div>
      ${posting.term ? `<div class="meta">Term reads as: ${esc(posting.term)}</div>` : ""}
      ${posting.payRange ? `<div class="meta">Pay range found: ${esc(posting.payRange.raw)}</div>` : ""}
      ${assembled && assembled.tagList ? `<div class="meta">Tags in use: ${assembled.tagList.map((t) => esc(t.tag) + " " + t.weight).join(", ")}</div>` : ""}
      <table class="scores">${roles.map((r) => `<tr><td>${r.score}</td><td>${esc(r.role)}</td></tr>`).join("")}</table>
    </div>
    <label class="inline" for="${esc(selectId)}">Override the role type</label>
    <select id="${esc(selectId)}">${options}</select>`;
}

export function assembledHtml(a, opts = {}) {
  if (!a) return "";
  const out = [];

  if (a.needsRoleType) {
    return `<div class="banner amber">${esc(a.reason)}</div>`;
  }
  if (a.violations && a.violations.length) {
    out.push(`<div class="banner red"><strong>Output refused by the verifier.</strong> Nothing was filled or offered from the assembler.<ul>${
      a.violations.map((v) => `<li>${esc(v.reason)}<br><code>${esc(v.text)}</code></li>`).join("")
    }</ul></div>`);
  }
  for (const n of a.notices || []) {
    out.push(`<div class="banner ${n.level === "warn" ? "amber" : "blue"}">${esc(n.text)}</div>`);
  }

  out.push(sectionHead("Resume bullets", "bullets", opts));
  for (const e of a.entries) {
    const head = e.kind === "experience"
      ? `${e.header.employer}, ${e.header.title} (${e.header.focus})`
      : `${e.header.name}, ${e.header.subtitle}`;
    out.push(`<div class="card ${e.isLead ? "green" : ""}">
      <div><strong>${esc(head)}</strong>${e.isLead ? ' <span class="tagline">lead</span>' : ""}</div>
      <ul>${e.bullets.map((b) => `<li>${esc(b.text)}${b.merged ? ' <span class="tagline">(approved merge)</span>' : ""}<br><span class="tagline">${esc(b.ids.join(" + "))}${
        b.jdHits && b.jdHits.length ? " &middot; posting terms: " + b.jdHits.map(esc).join(", ") : ""
      }</span></li>`).join("")}</ul>
      ${e.kind === "project" && e.header.my_scope ? `<div class="why">Scope on record: ${esc(e.header.my_scope)}</div>` : ""}
    </div>`);
  }

  out.push(sectionHead("Skills", "skills", opts));
  out.push(`<div class="card">
    <div class="val">${esc(a.skills.map((s) => s.skill).join(", "))}</div>
    ${a.skillsHeld && a.skillsHeld.length ? `<div class="why">Held back past the limit: ${a.skillsHeld.map((s) => esc(s.skill)).join(", ")}</div>` : ""}
  </div>`);

  out.push(sectionHead("Gaps", "gaps", opts));
  out.push(a.gaps.length
    ? `<div class="card amber">
        <div class="val">${a.gaps.map(esc).join(", ")}</div>
        <div class="why">Omitted rather than stretched. If any of these is actually true, add it to the profile yourself.</div>
      </div>`
    : `<p class="note">Nothing the posting asked for is missing from the pools.</p>`);

  if (a.mergeCandidates.length) {
    out.push(sectionHead("Merge candidates", "merges", opts));
    out.push(`<div class="card">
      <div class="why">Not merged. Add a pair to <code>assembly_rules.merge_pairs</code> only if both read true as written and the join asserts nothing new.</div>
      ${a.mergeCandidates.map((c) => `<div class="merge">
        <div class="val">${esc(c.preview)}</div>
        <div class="meta">${esc(c.a)} + ${esc(c.b)} &middot; shares: ${c.sharedTags.map(esc).join(", ")}</div>
        <div class="row"><code>${esc(c.snippet)}</code><button class="small" data-copy-text="${esc(c.snippet)}">Copy</button></div>
      </div>`).join("")}
    </div>`);
  }

  return out.join("");
}

function sectionHead(title, key, opts) {
  const copy = opts.copySections ? `<button class="small ghost" data-copy-section="${esc(key)}">Copy</button>` : "";
  return `<h3 class="subhead">${esc(title)}${copy}</h3>`;
}

/** Wire every [data-copy-text] button inside a container. */
export function wireCopyText(container) {
  for (const btn of container.querySelectorAll("[data-copy-text]")) {
    btn.onclick = async () => {
      await navigator.clipboard.writeText(btn.dataset.copyText);
      flash(btn);
    };
  }
}

/** Wire every [data-copy-section] button using a text provider. */
export function wireCopySections(container, textFor) {
  for (const btn of container.querySelectorAll("[data-copy-section]")) {
    btn.onclick = async () => {
      await navigator.clipboard.writeText(textFor(btn.dataset.copySection));
      flash(btn);
    };
  }
}

export function flash(btn, label = "Copied") {
  const prev = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
}
