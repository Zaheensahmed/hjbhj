// tracker/tracker.js -- the tracker UI. Classic script, so this page works
// straight from the filesystem. All view logic lives in logic.js; this file is
// rendering and event wiring only.
//
// data.json is the source of truth. The page cannot write to disk, so edits are
// in memory and you copy or download the result and replace the file by hand.
// When the page is opened from the extension origin it also reads anything the
// extension has written to chrome.storage and overlays it, additively.

(() => {
  const T = globalThis.JAF_TRACKER;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TODAY = new Date();
  const state = { data: null, view: "status", overlayCount: 0 };

  // ------------------------------------------------------------------ loading

  // data.json holds your real tracker and is gitignored. A clean clone has only
  // data.example.json, which has the same shape with example rows.
  async function loadSeed() {
    for (const path of ["data.json", "data.example.json"]) {
      const res = await fetch(path, { cache: "no-store" });
      if (res.ok) return { data: await res.json(), source: path };
    }
    throw new Error("neither data.json nor data.example.json could be read");
  }

  async function loadOverlay() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null;
    const o = await chrome.storage.local.get("tracker_overlay");
    return o.tracker_overlay || null;
  }

  async function boot() {
    let seed = null;
    let seedSource = null;
    try {
      const loaded = await loadSeed();
      seed = loaded.data;
      seedSource = loaded.source;
    } catch (err) {
      $("load").hidden = false;
      $("load-why").textContent = String(err && err.message ? err.message : err);
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        $("ext-url").textContent = chrome.runtime.getURL("tracker/index.html");
      }
      $("out").innerHTML = `<p class="empty">Nothing loaded yet.</p>`;
    }

    const overlay = await loadOverlay().catch(() => null);
    if (seed) {
      adopt(seed, overlay);
      if (seedSource === "data.example.json") {
        $("overlay-note").hidden = false;
        $("overlay-note").innerHTML = "Showing <code>data.example.json</code>, the example rows. Copy it to <code>tracker/data.json</code> and put your own applications in.";
      }
    }

    $("load-file").onchange = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        adopt(JSON.parse(await file.text()), overlay);
        $("load").hidden = true;
      } catch (err) {
        $("load-why").textContent = `That file did not parse: ${err.message}`;
      }
    };

    for (const btn of $("views").querySelectorAll("button")) {
      btn.onclick = () => { state.view = btn.dataset.view; render(); };
    }
    $("copy-json").onclick = async () => {
      if (!state.data) return;
      await navigator.clipboard.writeText(T.toJson(state.data));
      flash($("copy-json"));
    };
    $("download-json").onclick = () => {
      if (!state.data) return;
      const blob = new Blob([T.toJson(state.data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "data.json";
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  function adopt(seed, overlay) {
    state.data = overlay ? T.mergeOverlay(seed, overlay) : T.normalize(seed);
    state.overlayCount = state.data.applications.filter((a) => a._fromOverlay || a._overlaid).length;
    if (state.overlayCount) {
      $("overlay-note").hidden = false;
      $("overlay-note").innerHTML = `${state.overlayCount} record${state.overlayCount > 1 ? "s" : ""} came from, or were updated by, the extension's own storage. They are marked <span class="tag overlay">ext</span>. Copy or download the JSON to fold them into data.json for good.`;
    }
    render();
  }

  function flash(btn, label = "Copied") {
    const prev = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = prev; }, 900);
  }

  // ------------------------------------------------------------------- render

  function render() {
    for (const btn of $("views").querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.view === state.view);
    }
    if (!state.data) return;

    const d = state.data;
    const problems = T.validate(d);
    const staleRows = T.stale(d, TODAY);
    const due = T.upcoming(d, TODAY);
    const overdue = due.filter((r) => r.overdue).length;

    $("meta").textContent =
      `${d.applications.length} applications, ${d.deadlines.length} deadlines. ` +
      `${staleRows.length} not checked in 30+ days. ${overdue} deadline${overdue === 1 ? "" : "s"} past. ` +
      `${problems.length} thing${problems.length === 1 ? "" : "s"} to fill in. ` +
      `Seed last updated ${d._last_updated || "unknown"}. Today is ${TODAY.toISOString().slice(0, 10)}.`;

    const views = { status: viewStatus, stale: viewStale, deadlines: viewDeadlines, problems: viewProblems };
    $("out").innerHTML = views[state.view](d, { problems, staleRows, due });
    wireEdits();
  }

  const FIELD_LABELS = {
    company: "Company", role: "Role", location: "Location", term: "Term",
    portal_url: "Portal URL", ats: "ATS", account_email: "Account email",
    date_applied: "Applied", status: "Status", date_last_checked: "Last checked",
    deadline: "Deadline", notes: "Notes", next_action: "Next action"
  };

  function tags(a) {
    let out = "";
    if (a.status_assumed) out += `<span class="tag assumed" title="Status inferred from a grouping, not stated. Correct this.">assumed</span>`;
    if (a._fromOverlay || a._overlaid) out += `<span class="tag overlay" title="From the extension's storage.">ext</span>`;
    if (a.priority === "low") out += `<span class="tag">low</span>`;
    return out;
  }

  function cell(a, field) {
    const v = a[field] || "";
    if (field === "status") {
      return `<td class="edit"><select data-id="${esc(a.id)}" data-field="status">${
        state.data.statuses.map((s) => `<option value="${esc(s)}"${s === v ? " selected" : ""}>${esc(s)}</option>`).join("")
      }</select></td>`;
    }
    const type = /^date_|^deadline$/.test(field) ? "date" : "text";
    return `<td class="edit"><input type="${type}" data-id="${esc(a.id)}" data-field="${esc(field)}" value="${esc(v)}" placeholder="${type === "date" ? "" : "blank"}"></td>`;
  }

  function viewStatus(d) {
    const groups = T.byStatus(d);
    if (!groups.length) return `<p class="empty">No applications in data.json.</p>`;
    return groups.map((g) => `
      <h2>${esc(g.status)} <span class="count">(${g.items.length})</span></h2>
      <table>
        <thead><tr>
          <th style="width:17%">Company</th><th style="width:15%">Role</th><th style="width:12%">Location</th>
          <th style="width:9%">Term</th><th style="width:8%">Applied</th><th style="width:8%">Checked</th>
          <th style="width:10%">Account</th><th>Notes and next action</th>
        </tr></thead>
        <tbody>${g.items.map((a) => `
          <tr class="${a.priority === "low" ? "low" : ""}">
            <td><span class="company">${esc(a.company)}</span>${tags(a)}
              ${a.portal_url ? `<div class="sub"><a href="${esc(a.portal_url)}" target="_blank" rel="noreferrer">portal</a>${a.ats ? " &middot; " + esc(a.ats) : ""}</div>` : `<div class="blank">no portal URL</div>`}</td>
            ${cell(a, "role")}${cell(a, "location")}${cell(a, "term")}
            ${cell(a, "date_applied")}${cell(a, "date_last_checked")}${cell(a, "account_email")}
            <td class="edit">
              <input type="text" data-id="${esc(a.id)}" data-field="notes" value="${esc(a.notes)}" placeholder="notes">
              <input type="text" data-id="${esc(a.id)}" data-field="next_action" value="${esc(a.next_action)}" placeholder="next action">
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`).join("");
  }

  function viewStale(d, { staleRows }) {
    if (!staleRows.length) return `<p class="empty">Everything open has been checked inside 30 days.</p>`;
    return `
      <h2>Not checked in 30+ days <span class="count">(${staleRows.length})</span></h2>
      <p class="note">Open applications only. Records with no dates at all are listed last, because an unknown is not the same as a zero.</p>
      <table>
        <thead><tr><th style="width:8%">Days</th><th style="width:20%">Company</th><th style="width:16%">Status</th><th style="width:22%">Basis</th><th>Next action</th></tr></thead>
        <tbody>${staleRows.map((r) => `
          <tr class="${r.app.priority === "low" ? "low" : ""}">
            <td class="days ${r.days === null ? "warn" : r.days >= 60 ? "bad" : "warn"}">${r.days === null ? "unknown" : r.days}</td>
            <td><span class="company">${esc(r.app.company)}</span>${tags(r.app)}
              ${r.app.role ? `<div class="sub">${esc(r.app.role)}</div>` : ""}</td>
            ${cell(r.app, "status")}
            <td class="sub">${esc(r.basis)}</td>
            <td class="edit"><input type="text" data-id="${esc(r.app.id)}" data-field="next_action" value="${esc(r.app.next_action)}" placeholder="next action"></td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function viewDeadlines(d, { due }) {
    if (!due.length) return `<p class="empty">No deadlines on record.</p>`;
    return `
      <h2>Upcoming deadlines <span class="count">(${due.length})</span></h2>
      <p class="note">Standalone deadlines and application deadlines together, soonest first. A window shows its start date for sorting and its real wording beside it.</p>
      <table>
        <thead><tr><th style="width:9%">Days</th><th style="width:13%">Due</th><th style="width:7%">Kind</th><th style="width:26%">Item</th><th>Note</th></tr></thead>
        <tbody>${due.map((r) => `
          <tr class="${r.overdue ? "overdue" : ""}">
            <td class="days ${r.daysAway === null ? "" : r.daysAway < 0 ? "bad" : r.daysAway <= 21 ? "warn" : ""}">${
              r.daysAway === null ? "unknown" : r.overdue ? `${Math.abs(r.daysAway)} past` : r.daysAway
            }</td>
            <td>${esc(r.dueText || "unknown")}${r.approx ? `<div class="sub">approximate</div>` : ""}</td>
            <td class="sub">${esc(r.kind)}</td>
            <td class="company">${esc(r.label)}</td>
            <td class="sub">${esc(r.note || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function viewProblems(d, { problems }) {
    if (!problems.length) return `<p class="empty">Nothing missing and no bad dates.</p>`;
    const byRecord = new Map();
    for (const p of problems) {
      if (!byRecord.has(p.id)) byRecord.set(p.id, []);
      byRecord.get(p.id).push(p);
    }
    const nameOf = (id) => {
      const a = d.applications.find((x) => x.id === id);
      if (a) return a.company || id;
      const dl = d.deadlines.find((x) => x.id === id);
      return dl ? dl.item || id : id;
    };
    const assumed = d.applications.filter((a) => a.status_assumed);
    return `
      ${assumed.length ? `<div class="banner amber"><strong>${assumed.length} statuses were inferred, not stated:</strong> ${assumed.map((a) => esc(a.company)).join(", ")}. These came from a grouping in your notes rather than from you saying so. Correct them before trusting any view.</div>` : ""}
      <h2>Needs filling in <span class="count">(${problems.length})</span></h2>
      <table>
        <thead><tr><th style="width:22%">Record</th><th style="width:14%">Kind</th><th>Detail</th></tr></thead>
        <tbody>${[...byRecord.entries()].map(([id, list]) => list.map((p, i) => `
          <tr>
            <td>${i === 0 ? `<span class="company">${esc(nameOf(id))}</span><div class="sub">${esc(id)}</div>` : ""}</td>
            <td class="sub">${esc(p.kind)}</td>
            <td>${esc(p.detail)}</td>
          </tr>`).join("")).join("")}
        </tbody>
      </table>`;
  }

  function wireEdits() {
    for (const el of $("out").querySelectorAll("[data-field]")) {
      el.onchange = () => {
        const rec = state.data.applications.find((a) => a.id === el.dataset.id);
        if (!rec) return;
        rec[el.dataset.field] = el.value.trim();
        if (el.dataset.field === "status") rec.status_assumed = false;
        render();
      };
    }
  }

  boot();
})();
