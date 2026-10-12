// Thin chrome.storage.local wrapper. No network, ever.

const K = { PROFILE: "profile", LEARNED: "learned", PREFS: "prefs", TRIAGE: "triage" };

async function get(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return key in o ? o[key] : fallback;
}

export const getProfile = () => get(K.PROFILE, null);
export const setProfile = (p) => chrome.storage.local.set({ [K.PROFILE]: p });

export const getLearned = () => get(K.LEARNED, {});
export const getPrefs = () => get(K.PREFS, { useGenericOrgName: false, roleTypeOverride: null });
export const setPrefs = (p) => chrome.storage.local.set({ [K.PREFS]: p });

// Values that must never reach disk, regardless of what the page called the field.
const UNSAFE_VALUE = [
  /\b\d{3}-\d{2}-\d{4}\b/,                       // SSN
  /\b(?:\d[ -]?){13,19}\b/,                      // card-ish
  /\b\d{9}\b/                                    // bare SSN / routing
];

export async function learnAnswer({ labelRaw, labelNorm, derivedPattern, answer, tag, type, options, host }) {
  if (type === "password" || tag === "file") {
    return { ok: false, reason: "Refusing to store anything typed into a password or file field." };
  }
  for (const re of UNSAFE_VALUE) {
    if (re.test(String(answer))) {
      return { ok: false, reason: "That looks like an SSN or card number. Not storing it. Type it into the page yourself." };
    }
  }
  const learned = await getLearned();
  const key = labelNorm;
  const prev = learned[key];
  learned[key] = {
    labelRaw, labelNorm, derivedPattern, answer, tag, type,
    options: options || null,
    host: host || null,
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    useCount: prev?.useCount || 0
  };
  await chrome.storage.local.set({ [K.LEARNED]: learned });
  return { ok: true };
}

export async function bumpUse(keys) {
  const learned = await getLearned();
  let dirty = false;
  for (const k of keys) {
    if (learned[k]) { learned[k].useCount = (learned[k].useCount || 0) + 1; dirty = true; }
  }
  if (dirty) await chrome.storage.local.set({ [K.LEARNED]: learned });
}

export async function forgetAnswer(key) {
  const learned = await getLearned();
  delete learned[key];
  await chrome.storage.local.set({ [K.LEARNED]: learned });
}

// -------------------------------------------------------------------- triage
//
// Keyed by listing URL throughout, so a dismissal survives a rescan, a board
// reorder and a browser restart.

const EMPTY_TRIAGE = { dismissed: {}, shortlist: {}, harvested: {}, run: null };

export async function getTriage() {
  const t = await get(K.TRIAGE, null);
  return { ...EMPTY_TRIAGE, ...(t || {}) };
}

async function mutateTriage(fn) {
  const t = await getTriage();
  fn(t);
  await chrome.storage.local.set({ [K.TRIAGE]: t });
  return t;
}

export const dismissCard = (url, reason) =>
  mutateTriage((t) => { t.dismissed[url] = { at: new Date().toISOString(), reason: reason || "" }; });

export const restoreCard = (url) =>
  mutateTriage((t) => { delete t.dismissed[url]; });

export const setShortlisted = (url, record, on) =>
  mutateTriage((t) => {
    if (on) t.shortlist[url] = { ...record, at: new Date().toISOString(), queueStatus: (t.shortlist[url] || {}).queueStatus || "queued" };
    else delete t.shortlist[url];
  });

export const setQueueStatus = (url, status) =>
  mutateTriage((t) => { if (t.shortlist[url]) t.shortlist[url].queueStatus = status; });

/** Stage 2 writes one record at a time, so a partial run is still useful. */
export const putHarvested = (url, record) =>
  mutateTriage((t) => { t.harvested[url] = { ...(t.harvested[url] || {}), ...record, at: new Date().toISOString() }; });

export const setRun = (run) => mutateTriage((t) => { t.run = run; });

export const clearTriage = () => chrome.storage.local.set({ [K.TRIAGE]: { ...EMPTY_TRIAGE } });

// ------------------------------------------------------------ harvest control
//
// The loop runs in the page and polls these, rather than listening for a
// message, so Stop still works after the popup has closed.

export const getHarvestControl = () => get("harvest_control", { stop: false });
export const setHarvestStop = (stop) => chrome.storage.local.set({ harvest_control: { stop: Boolean(stop), at: new Date().toISOString() } });
export const getHarvestProgress = () => get("harvest_progress", null);

// ------------------------------------------------------------ tracker overlay
//
// tracker/data.json stays the source of truth. The extension only ever adds to
// an overlay, which tracker/index.html merges on top, additively, and which you
// fold into the file when you choose.

export const getTrackerOverlay = () => get("tracker_overlay", { applications: [], deadlines: [] });

export async function addTrackerRecord(record) {
  const overlay = await getTrackerOverlay();
  const i = overlay.applications.findIndex((a) => a.id === record.id);
  if (i === -1) overlay.applications.push(record);
  else overlay.applications[i] = { ...overlay.applications[i], ...record };
  await chrome.storage.local.set({ tracker_overlay: overlay });
  return { overlay, added: i === -1 };
}
