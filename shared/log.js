// shared/log.js -- serialization that never produces "[object Object]".
//
// Thrown values are not always Errors. `String(err)` on a plain object gives
// "[object Object]", and once that string is stored in an __error field the
// real information is gone before anything can display it. Every catch in this
// extension goes through describeError() instead.

/** JSON.stringify that survives cycles, Errors, RegExps and functions. */
export function safeJson(value, space = 2) {
  const seen = new WeakSet();
  try {
    // JSON.stringify(undefined) returns undefined, not a string, which would
    // put the literal word undefined into a template and lose the point.
    const out = JSON.stringify(value, (key, v) => {
      if (v instanceof Error) return { __type: "Error", name: v.name, message: v.message, stack: v.stack };
      if (v instanceof RegExp) return v.toString();
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "bigint") return String(v);
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }, space);
    return out === undefined ? String(value) : out;
  } catch (err) {
    return `[unserializable: ${err && err.message ? err.message : "unknown"}]`;
  }
}

/**
 * A thrown value, described without losing it.
 * @returns {{text:string, name:string|null, message:string|null, stack:string|null, raw:*}}
 */
export function describeError(err) {
  if (err instanceof Error) {
    return { text: `${err.name}: ${err.message}`, name: err.name, message: err.message,
             stack: err.stack || null, raw: null };
  }
  if (typeof err === "string") return { text: err, name: null, message: err, stack: null, raw: err };
  if (err === null || err === undefined) return { text: String(err), name: null, message: null, stack: null, raw: err };
  // The case that used to become "[object Object]".
  return { text: safeJson(err, 0), name: null, message: null, stack: null, raw: err };
}

/**
 * Log something you will need to read.
 *
 * Passes the object as its own console argument so it expands in DevTools, and
 * follows it with pretty JSON so it can be copied out of the console in one
 * piece. Both, because expanding a deep object by hand is not reading it.
 */
export function logObj(label, obj) {
  console.log(label, obj);
  console.log(`${label} — JSON:\n${safeJson(obj)}`);
}

export function errorObj(label, obj) {
  console.error(label, obj);
  console.error(`${label} — JSON:\n${safeJson(obj)}`);
}
