import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

const first = "https://first.rpc.test/private-key-a";
const second = "https://second.rpc.test/private-key-b";
const archive = "https://archive.rpc.test/private-history-key";

function pools(env, respond) {
  let now = 100_000;
  class Clock extends Date { static now() { return now; } }
  const result = loadModule("lib/rpc.ts", {
    viem: {
      http: url => ({ url }),
      createPublicClient: ({ transport }) => ({ request: request => respond(transport.url, request) }),
    },
    "viem/chains": { bsc: { id: 56 } },
  }, { process: { env }, Date: Clock });
  return { ...result, advance: ms => { now += ms; } };
}

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
