import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

const first = "https://first.rpc.test/private-key-a";
const second = "https://second.rpc.test/private-key-b";
const archive = "https://archive.rpc.test/private-history-key";

function pools(env, respond) {
  let now = 100_000;
  let nextTimer = 0;
  const timers = new Map();
  class Clock extends Date { static now() { return now; } }
  const result = loadModule("lib/rpc.ts", {
    viem: {
      http: url => ({ url }),
      createPublicClient: ({ transport }) => ({
        request: request => respond(transport.url, request),
        scope: ({ signal }) => ({ request: request => respond(transport.url, request, signal) }),
      }),
    },
    "viem/chains": { bsc: { id: 56 } },
  }, {
    process: { env }, Date: Clock,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { ...result, pendingTimers: () => timers.size, advance: ms => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
  } };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

test("ordinary and historical reads use their independently configured providers", async () => {
  const { RpcPool, HistoryRpcPool } = pools({ BSC_RPC_URL: ` ${first}, ${second} `, HISTORY_RPC_URL: archive }, async url => {
    if (url === first) return "ordinary read";
    if (url === archive) return "historical read";
    throw new Error("unexpected provider");
  });
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "ordinary read");
  assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" })), "historical read");
  assert.equal(RpcPool.status().length, 2);
  assert.equal(HistoryRpcPool.status().length, 1);
});

test("an absent or empty history configuration falls back to the ordinary URLs", async () => {
  for (const history of [undefined, "", " , "]) {
    const { RpcPool, HistoryRpcPool } = pools({ BSC_RPC_URL: first, HISTORY_RPC_URL: history }, async url => {
      if (url === first) return "fallback read";
      throw new Error("unexpected provider");
    });
    assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getCode" })), "fallback read");
    assert.equal(RpcPool.status()[0].label, "rpc#1");
    assert.equal(HistoryRpcPool.status()[0].label, "history#1");
  }
});

test("ordinary read failures do not cool historical providers sharing the fallback URLs", async () => {
  const { RpcPool, HistoryRpcPool } = pools({ BSC_RPC_URL: `${first},${second}` }, async (url, request) => {
    if (url === first && request.method === "eth_call") throw new Error("ordinary read failed");
    return url === first ? "first provider" : "second provider";
  });
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "second provider");
  assert.equal(RpcPool.status()[0].fails, 1);
  assert.equal(RpcPool.status()[0].cooldown, true);
  assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" })), "first provider");
  assert.equal(HistoryRpcPool.status()[0].fails, 0);
  assert.equal(HistoryRpcPool.status()[0].cooldown, false);
});

test("historical cooldown and recovery leave ordinary provider health unchanged", async () => {
  let failHistory = true;
  const { RpcPool, HistoryRpcPool, advance } = pools({ BSC_RPC_URL: `${first},${second}` }, async (url, request) => {
    if (url === first && request.method === "eth_getLogs" && failHistory) throw new Error("logs unavailable");
    return url === first ? "first provider" : "second provider";
  });
  assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" })), "second provider");
  assert.equal(HistoryRpcPool.status()[0].cooldown, true);
  assert.equal(RpcPool.status()[0].cooldown, false);
  assert.equal(RpcPool.status()[0].fails, 0);
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "first provider");
  failHistory = false;
  assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" })), "second provider");
  advance(30_001);
  assert.equal(await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" })), "first provider");
  assert.equal(HistoryRpcPool.status()[0].fails, 0);
  assert.equal(HistoryRpcPool.status()[0].cooldown, false);
});

test("ordinary failover still skips a cooling provider until it recovers", async () => {
  let failFirst = true;
  const { RpcPool, advance } = pools({ BSC_RPC_URL: `${first},${second}` }, async url => {
    if (url === first && failFirst) throw new Error("temporarily unavailable");
    return url === first ? "first provider" : "second provider";
  });
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "second provider");
  failFirst = false;
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "second provider");
  advance(30_001);
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_call" })), "first provider");
  assert.equal(RpcPool.status()[0].fails, 0);
});

test("public statuses contain only labels and health metrics, never RPC URLs or keys", async () => {
  const { RpcPool, HistoryRpcPool } = pools({ BSC_RPC_URL: first, HISTORY_RPC_URL: archive }, async () => "ok");
  await RpcPool.call(c => c.request({ method: "eth_call" }));
  await HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" }));
  const statuses = [...RpcPool.status(), ...HistoryRpcPool.status()];
  for (const status of statuses) {
    assert.deepEqual(Object.keys(status).sort(), ["cooldown", "fails", "label", "lastOk", "ms"]);
  }
  assert.doesNotMatch(JSON.stringify(statuses), /https?:|private-key|private-history-key|rpc\.test/);
});

test("a fast primary needs no backup request and clears its timers", async () => {
  const calls = [];
  const { RpcPool, advance, pendingTimers } = pools({ BSC_RPC_URL: `${first},${second}` }, async url => {
    calls.push(url); return null;
  });
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_getTransactionReceipt" })), null);
  advance(10_000);
  assert.deepEqual(calls, [first]);
  assert.equal(pendingTimers(), 0);
});

test("a slow primary gets one backup after 350ms and the winning read cancels the loser", async () => {
  const slow = deferred(), calls = [], signals = [];
  const { RpcPool, advance, pendingTimers } = pools({ BSC_RPC_URL: `${first},${second}` }, (url, _request, signal) => {
    calls.push(url); signals.push(signal);
    return url === first ? slow.promise : Promise.resolve("backup result");
  });
  const result = RpcPool.call(c => c.request({ method: "eth_blockNumber" }));
  try {
    await flush(); advance(349); await flush();
    assert.deepEqual(calls, [first]);
    advance(1); await flush();
    assert.deepEqual(calls, [first, second]);
    assert.equal(await result, "backup result");
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    assert.equal(RpcPool.status()[0].fails, 0);
    assert.equal(pendingTimers(), 0);
    slow.resolve("late primary result"); await flush();
    assert.equal(RpcPool.status()[0].lastOk, 0);
  } finally { slow.resolve("cleanup"); }
});

test("an immediate error tries the next provider without waiting for the hedge timer", async () => {
  const calls = [];
  const { RpcPool } = pools({ BSC_RPC_URL: `${first},${second}` }, async url => {
    calls.push(url);
    if (url === first) throw new Error("unavailable");
    return 0;
  });
  assert.equal(await RpcPool.call(c => c.request({ method: "eth_getBalance" })), 0);
  assert.deepEqual(calls, [first, second]);
  assert.equal(RpcPool.status()[0].fails, 1);
});

test("one failed racer cannot reject a pending successful read", async () => {
  const primary = deferred(), backup = deferred(), calls = [];
  const { RpcPool, advance } = pools({ BSC_RPC_URL: `${first},${second}` }, url => {
    calls.push(url); return url === first ? primary.promise : backup.promise;
  });
  let settled = false;
  const result = RpcPool.call(c => c.request({ method: "eth_call" }));
  void result.then(() => { settled = true; }, () => { settled = true; });
  try {
    await flush(); advance(350); await flush();
    assert.deepEqual(calls, [first, second]);
    backup.reject(new Error("backup unavailable")); await flush();
    assert.equal(settled, false);
    primary.resolve(false);
    assert.equal(await result, false);
  } finally { primary.resolve("cleanup"); backup.resolve("cleanup"); }
});

test("failed attempts replenish a free slot while limiting upstream concurrency to two", async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const urls = [first, second, archive, "https://fourth.rpc.test"];
  let active = 0, maximum = 0;
  const calls = [];
  const { RpcPool, advance } = pools({ BSC_RPC_URL: urls.join(",") }, (url, _request, signal) => {
    const i = urls.indexOf(url); calls.push(url); active += 1; maximum = Math.max(maximum, active);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active -= 1; } };
    signal?.addEventListener("abort", finish, { once: true });
    return gates[i].promise.finally(finish);
  });
  const result = RpcPool.call(c => c.request({ method: "eth_call" }));
  try {
    await flush(); advance(350); await flush();
    assert.equal(calls.length, 2);
    gates[0].reject(new Error("first failed")); await flush();
    assert.equal(calls.length, 3);
    gates[1].reject(new Error("second failed")); await flush();
    assert.equal(calls.length, 4);
    gates[3].resolve("fourth result");
    assert.equal(await result, "fourth result");
    assert.equal(maximum, 2);
    assert.equal(active, 0);
  } finally { for (const gate of gates) gate.resolve("cleanup"); }
});

test("the 7.5-second budget aborts pending reads and ignores late results", async () => {
  const gates = [deferred(), deferred()], signals = [];
  const { RpcPool, advance, pendingTimers } = pools({ BSC_RPC_URL: `${first},${second}` }, (url, _request, signal) => {
    signals.push(signal); return gates[url === first ? 0 : 1].promise;
  });
  const result = RpcPool.call(c => c.request({ method: "eth_call" }));
  const outcome = result.then(() => ({ ok: true }), error => ({ error }));
  try {
    await flush(); advance(350); await flush();
    assert.equal(signals.length, 2);
    advance(7_150); await flush();
    assert.equal(signals.every(signal => signal.aborted), true);
    const error = (await outcome).error;
    assert.match(error.message, /timeout|timed out|budget/i);
    assert.match(error.shortMessage, /timed out/i);
    assert.equal(pendingTimers(), 0);
    assert.equal(RpcPool.status().every(p => p.cooldown && p.fails === 1), true);
    for (const gate of gates) gate.resolve("late"); await flush();
    assert.equal(RpcPool.status().every(p => p.lastOk === 0 && p.fails === 1), true);
  } finally { for (const gate of gates) gate.resolve("cleanup"); }
});

test("concurrent logical calls have independent cancellation scopes", async () => {
  const slowA = deferred(), slowB = deferred(), backupB = deferred();
  const attempts = new Map();
  const { RpcPool, advance } = pools({ BSC_RPC_URL: `${first},${second}` }, (url, request, signal) => {
    attempts.set(`${request.id}:${url}`, signal);
    if (url === first) return request.id === "a" ? slowA.promise : slowB.promise;
    return request.id === "a" ? Promise.resolve("a backup") : backupB.promise;
  });
  const a = RpcPool.call(c => c.request({ method: "eth_call", id: "a" }));
  const b = RpcPool.call(c => c.request({ method: "eth_call", id: "b" }));
  try {
    await flush(); advance(350); await flush();
    assert.equal(attempts.size, 4);
    assert.equal(await a, "a backup");
    assert.equal(attempts.get(`a:${first}`).aborted, true);
    assert.equal(attempts.get(`b:${first}`).aborted, false);
    assert.equal(attempts.get(`b:${second}`).aborted, false);
    slowB.resolve("b primary");
    assert.equal(await b, "b primary");
    assert.equal(attempts.get(`b:${second}`).aborted, true);
  } finally { slowA.resolve("cleanup"); slowB.resolve("cleanup"); backupB.resolve("cleanup"); }
});

test("all failed reads preserve the original RPC error code and data", async () => {
  const error = Object.assign(new Error("execution reverted"), { code: -32000, data: "0x1234" });
  const { RpcPool } = pools({ BSC_RPC_URL: `${first},${second}` }, async () => { throw error; });
  await assert.rejects(RpcPool.call(c => c.request({ method: "eth_call" })), e => e === error);
});

test("historical requests stay serial even when the first provider is slow", async () => {
  const slow = deferred(), calls = [];
  const { HistoryRpcPool, advance } = pools({ BSC_RPC_URL: first, HISTORY_RPC_URL: `${first},${second}` }, url => {
    calls.push(url); return url === first ? slow.promise : Promise.resolve("backup");
  });
  const result = HistoryRpcPool.call(c => c.request({ method: "eth_getLogs" }));
  try {
    await flush(); advance(2_000); await flush();
    assert.deepEqual(calls, [first]);
    slow.resolve("history"); assert.equal(await result, "history");
  } finally { slow.resolve("cleanup"); }
});
