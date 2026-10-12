// popup/inject.js -- the one place that injects into a page and calls into it.
//
// Both tabs had their own copy of this, and both swallowed failures: the
// injected wrapper returned `api[name](payload)` without awaiting it, so an
// async content function that threw produced `result: undefined` and the caller
// saw a falsy value with no error, no stack and nothing in either console.
//
// Everything here logs. If a call fails you should be able to read what was
// injected, what was sent, and the real stack, from the popup console.

import { describeError, safeJson, logObj, errorObj } from "../shared/log.js";

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
      const d = describeError(err);
      errorObj(`${PREFIX} INJECTION FAILED for ${files.join(", ")} in tab ${tabId}`, d);
      return { ok: false, error: d.text, errorDetail: d };
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
            // Serialized here, in the page, because String(nonError) is
            // "[object Object]" and that would destroy the diagnostic before it
            // ever crossed back.
            const described = err instanceof Error
              ? { text: `${err.name}: ${err.message}`, stack: String(err.stack || "").slice(0, 2000) }
              : { text: (() => {
                    try {
                      const j = JSON.stringify(err);
                      if (j !== undefined) return j;
                    } catch { /* cyclic or unserializable */ }
                    // Last resort still has to say something: pull the usual
                    // fields off by hand rather than letting it stringify to
                    // "[object Object]".
                    const bits = ["name", "message", "code", "reason"]
                      .filter((k) => err && err[k] != null)
                      .map((k) => `${k}=${err[k]}`);
                    return bits.length ? bits.join(" ") : Object.prototype.toString.call(err);
                  })(), stack: null };
            return { __error: described.text, __stack: described.stack, __fn: name };
          }
        }
      });
    } catch (err) {
      const d = describeError(err);
      errorObj(`${PREFIX} executeScript REJECTED for ${namespace}.${fnName}`, d);
      return { __error: `executeScript rejected: ${d.text}`, __errorDetail: d };
    }

    if (!frames || !frames.length) {
      errorObj(`${PREFIX} ${namespace}.${fnName} returned no frames at all`, { frames, tabId });
      return { __error: "executeScript returned no frames. The tab may have navigated." };
    }
    const result = frames[0].result;
    if (result && result.__error) {
      errorObj(`${PREFIX} ${namespace}.${fnName} FAILED in the page`, result);
    } else {
      logObj(`${PREFIX} ${namespace}.${fnName} returned`, result);
    }
    return result === undefined ? { __error: `${namespace}.${fnName} returned undefined.` } : result;
  }

  return { inject, call };
}
