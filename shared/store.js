// Thin chrome.storage.local wrapper. No network, ever.

const K = { PROFILE: "profile", LEARNED: "learned", PREFS: "prefs" };

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
