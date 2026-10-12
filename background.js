// Seeds the profile into chrome.storage.local on install. Nothing else.
// There is no content_scripts block in the manifest and nothing registered here,
// so no code of ours can run on page load. Injection happens only from the popup,
// which only exists because you clicked the toolbar button.

import { getProfile, setProfile } from "./shared/store.js";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getProfile();
  if (existing) return; // never clobber edits
  const res = await fetch(chrome.runtime.getURL("data/profile.json"));
  await setProfile(await res.json());
});
