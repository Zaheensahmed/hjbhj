// popup/inject.js -- the one place that injects into a page and calls into it.
//
// Both tabs had their own copy of this, and both swallowed failures: the
// injected wrapper returned `api[name](payload)` without awaiting it, so an
// async content function that threw produced `result: undefined` and the caller
// saw a falsy value with no error, no stack and nothing in either console.
//
// Everything here logs. If a call fails you should be able to read what was
// injected, what was sent, and the real stack, from the popup console.

const PREFIX = "[JAF popup]";

export function makeInjector(getTabId, namespace) {
  async function inject(files) {
    const tabId = getTabId();
    console.log(`${PREFIX} injecting`, files, "into tab", tabId);
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId }, files });
      console.log(`${PREFIX} injected ok`, files, res);
      return { ok: true };
    } catch (err) {
      console.error(`${PREFIX} INJECTION FAILED for`, files, "tab", tabId, err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function call(fnName, arg) {
    const tabId = getTabId();
    console.log(`${PREFIX} call ${namespace}.${fnName}`, { tabId, arg });
    let frames;
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId },
        args: [namespace, fnName, arg === undefined ? null : arg],
        // Awaits the result and converts a throw into a value, so a rejected
        // promise can never arrive as a silent undefined.
        func: async (ns, name, payload) => {
          const api = globalThis[ns];
          if (!api) {
            return { __error: `${ns} is not defined in this page. The content script was not injected, or it threw while loading.`,
                     __globals: Object.keys(globalThis).filter((k) => k.startsWith("JAF")) };
          }
          if (typeof api[name] !== "function") {
            return { __error: `${ns}.${name} is not a function in this page.`,
                     __available: Object.keys(api) };
          }
          try {
            return await api[name](payload);
          } catch (err) {
            return { __error: String(err && err.message ? err.message : err),
                     __stack: String(err && err.stack ? err.stack : "").slice(0, 2000),
                     __fn: name };
          }
        }
      });
    } catch (err) {
      console.error(`${PREFIX} executeScript REJECTED for ${namespace}.${fnName}`, err);
      return { __error: `executeScript rejected: ${err && err.message ? err.message : err}` };
    }

    if (!frames || !frames.length) {
      console.error(`${PREFIX} ${namespace}.${fnName} returned no frames at all`, frames);
      return { __error: "executeScript returned no frames. The tab may have navigated." };
    }
    const result = frames[0].result;
    if (result && result.__error) {
      console.error(`${PREFIX} ${namespace}.${fnName} failed in the page:`, result.__error,
        result.__stack || "", result.__available || result.__globals || "");
    } else {
      console.log(`${PREFIX} ${namespace}.${fnName} returned`, result);
    }
    return result === undefined ? { __error: `${namespace}.${fnName} returned undefined.` } : result;
  }

  return { inject, call };
}
