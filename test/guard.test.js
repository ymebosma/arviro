import assert from "node:assert/strict";
import test from "node:test";
import { createGuard } from "../src/guard.js";

function counter() {
  let calls = 0;
  return { execute: async () => ({ text: `result ${calls += 1}`, isError: false }), count: () => calls };
}

test("an identical call within the window returns the earlier result with a notice", async () => {
  const guard = createGuard();
  const work = counter();
  const first = await guard.run("s", "search_library", { query: "water", source: "library" }, work.execute);
  const again = await guard.run("s", "search_library", { source: "library", query: " water " }, work.execute);
  assert.equal(first.text, "result 1");
  assert.match(again.text, /^NOTE: this exact call was already made moments ago/);
  assert.match(again.text, /result 1$/);
  assert.equal(work.count(), 1);
});

test("different arguments and different sessions are executed", async () => {
  const guard = createGuard();
  const work = counter();
  await guard.run("s", "search_library", { query: "water" }, work.execute);
  await guard.run("s", "search_library", { query: "fire" }, work.execute);
  await guard.run("other", "search_library", { query: "water" }, work.execute);
  assert.equal(work.count(), 3);
});

test("after several repeats only a stop message is returned", async () => {
  const guard = createGuard();
  const work = counter();
  const replies = [];
  for (let index = 0; index < 6; index += 1) replies.push((await guard.run("s", "read_document", { path: "a" }, work.execute)).text);
  assert.equal(work.count(), 1);
  assert.match(replies[3], /result 1$/);
  assert.match(replies[4], /^This identical call has now been repeated several times/);
});

test("a failed call is not executed again when repeated", async () => {
  const guard = createGuard();
  let calls = 0;
  const failing = async () => ({ text: `no such file (${calls += 1})`, isError: true });
  const first = await guard.run("s", "read_document", { path: "missing" }, failing);
  const again = await guard.run("s", "read_document", { path: "missing" }, failing);
  assert.equal(first.isError, true);
  assert.equal(again.isError, false);
  assert.match(again.text, /^NOTE: this exact call failed moments ago/);
  assert.equal(calls, 1);
});

test("the call budget per window is enforced and renewed", async () => {
  let time = 0;
  const guard = createGuard({ windowMs: 1000, maxCallsPerWindow: 3, now: () => time });
  const work = counter();
  for (let index = 0; index < 3; index += 1) await guard.run("s", "search_library", { query: `q${index}` }, work.execute);
  const refused = await guard.run("s", "search_library", { query: "q3" }, work.execute);
  assert.match(refused.text, /^Too many library calls/);
  assert.equal(work.count(), 3);
  time = 1001;
  const later = await guard.run("s", "search_library", { query: "q3" }, work.execute);
  assert.equal(later.text, "result 4");
});

test("all sessions together have a larger budget, so one client cannot be starved by a loop elsewhere", async () => {
  const guard = createGuard({ maxCallsPerWindow: 2, maxCallsTotal: 5 });
  const work = counter();
  for (const session of ["a", "b"]) {
    await guard.run(session, "search_library", { query: "one" }, work.execute);
    await guard.run(session, "search_library", { query: "two" }, work.execute);
    assert.match((await guard.run(session, "search_library", { query: "three" }, work.execute)).text, /limit: 2 per/);
  }
  assert.equal((await guard.run("c", "search_library", { query: "one" }, work.execute)).text, "result 5");
  assert.match((await guard.run("d", "search_library", { query: "one" }, work.execute)).text, /limit: 5 per/);
  assert.equal(work.count(), 5);
});

test("identical calls made at the same time share one execution", async () => {
  const guard = createGuard();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = async () => { calls += 1; await gate; return { text: "slow result", isError: false }; };
  const both = Promise.all([guard.run("s", "search_library", { query: "x" }, slow), guard.run("s", "search_library", { query: "x" }, slow)]);
  release();
  const [first, second] = await both;
  assert.equal(calls, 1);
  assert.equal(first.text, "slow result");
  assert.match(second.text, /slow result$/);
});
