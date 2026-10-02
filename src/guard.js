// Protects against a model that keeps repeating tool calls.
// An MCP server cannot see where one chat turn ends, so the guard works with a sliding time window.
// A session is whatever the transport can tell apart: one HTTP connection, or one stdio process.

const MAX_REPEATS = 3;

function signatureOf(tool, args) {
  const normalized = {};
  for (const key of Object.keys(args || {}).sort()) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    normalized[key] = typeof value === "string" ? value.trim() : value;
  }
  return `${tool} ${JSON.stringify(normalized)}`;
}

/**
 * @param {object} options
 * @param {number} options.windowMs            how long calls are remembered
 * @param {number} options.maxCallsPerWindow   executed calls allowed per window and session
 * @param {number} options.maxCallsTotal       executed calls allowed per window over all sessions together
 */
export function createGuard({ windowMs = 60_000, maxCallsPerWindow = 20, maxCallsTotal = 120, now = Date.now } = {}) {
  const sessions = new Map();

  function prune() {
    const cutoff = now() - windowMs;
    for (const [key, calls] of sessions) {
      const kept = calls.filter((call) => call.at >= cutoff);
      if (kept.length) sessions.set(key, kept);
      else sessions.delete(key);
    }
  }

  function refusal(limit) {
    return {
      text: `Too many library calls in a short time (limit: ${limit} per ${Math.round(windowMs / 1000)} seconds). Do not call tools again now: answer with what you have, or tell the user what is missing.`,
      isError: false,
    };
  }

  /**
   * Run `execute` unless the same call was made moments ago or the call budget is used up.
   * `execute` returns { text, isError? }; the guard returns the same shape.
   */
  async function run(sessionKey, tool, args, execute) {
    prune();
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
    const calls = sessions.get(sessionKey);
    const signature = signatureOf(tool, args);
    const earlier = calls.find((call) => call.signature === signature);
    if (earlier) {
      earlier.repeats += 1;
      if (earlier.repeats > MAX_REPEATS) {
        return { text: "This identical call has now been repeated several times. Stop calling tools: answer with the results you already have, or tell the user they are insufficient.", isError: false };
      }
      const result = await earlier.result;
      const notice = result.isError
        ? "NOTE: this exact call failed moments ago and will fail again. Do not repeat it; change the arguments or answer without it. The earlier error:"
        : "NOTE: this exact call was already made moments ago; the earlier result is repeated below. Do not repeat this call: answer from these results, or say that they are insufficient.";
      return { text: `${notice}\n\n${result.text}`, isError: false };
    }
    if (calls.length >= maxCallsPerWindow) return refusal(maxCallsPerWindow);
    let total = 0;
    for (const list of sessions.values()) total += list.length;
    if (total >= maxCallsTotal) return refusal(maxCallsTotal);
    // The promise is stored, so an identical call made while this one is still running waits for the same result.
    const entry = { at: now(), signature, repeats: 0, result: Promise.resolve().then(execute) };
    calls.push(entry);
    return entry.result;
  }

  return { run };
}
