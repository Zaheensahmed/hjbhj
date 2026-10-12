// shared/load-data.js -- where the profile comes from.
//
// data/profile.json holds real personal data and is gitignored. A clean clone
// has only data/profile.example.json, which is structurally identical with
// placeholder values, so the extension runs out of the box and you replace the
// values at your own pace.

export const PROFILE_PATH = "data/profile.json";
export const PROFILE_EXAMPLE_PATH = "data/profile.example.json";

/** @returns {{profile:object, source:string, isExample:boolean}} */
export async function fetchProfile() {
  for (const [path, isExample] of [[PROFILE_PATH, false], [PROFILE_EXAMPLE_PATH, true]]) {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) continue;
      return { profile: await res.json(), source: path, isExample };
    } catch { /* try the next one */ }
  }
  throw new Error(`Neither ${PROFILE_PATH} nor ${PROFILE_EXAMPLE_PATH} could be read.`);
}
