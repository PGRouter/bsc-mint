import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { loadModule, deferred, buyer } from "./helpers.mjs";

for (const [file, url] of [["snapshot", "http://audit.local/api/snapshot?me=0xABC"], ["klines", "http://audit.local/api/klines?sec=60&asset=relic&limit=200"]]) {
  test(`${file} returns cached data without waiting for a slow background sync`, async () => {
    const pending = deferred();
    const scheduled = [];
    let syncCalls = 0;
    const indexer = {
      PERIODS: [30, 60, 300, 900, 3600],
      sync: () => { syncCalls++; return pending.promise; },
      snapshot: me => ({ ready: true, block: 100, me }),
      klines: () => [{ t: 1000, o: 1, h: 2, l: 1, c: 2 }],
    };
    const { GET } = loadModule(`app/api/${file}/route.ts`, {
      "@/lib/indexer": { Indexer: indexer },
      "next/server": { after: fn => scheduled.push(fn) },
    });
    try {
      const result = await Promise.race([
        GET(new Request(url)),
        new Promise(resolve => setTimeout(() => resolve("blocked by sync"), 40)),
      ]);
      assert.notEqual(result, "blocked by sync");
      const json = await result.json();
      assert.equal(file === "snapshot" ? json.block : json.candles[0].c, file === "snapshot" ? 100 : 2);
      if (file === "snapshot") assert.equal(json.me, "0xabc");
      assert.equal(syncCalls, 0);
      assert.equal(scheduled.length, 1);
      const refresh = scheduled[0]();
      assert.equal(syncCalls, 1);
      pending.resolve(); await refresh;
    } finally { pending.resolve(); }
  });
}

function state(overrides = {}) {
  return {
    fromBlock: 1n, lastBlock: 0n, bids: new Map(), fills: [],
    holders: { relic: new Map(), loom: new Map() }, mint: null, feeBps: 0,
    syncedAt: 0, lastError: null, syncing: null, lastAttempt: 0, head: 20n,
    ...overrides,
  };
}

function fixture(overrides = {}, cached = state(), globals = {}, cache = { read: async () => null, write: async () => {} }) {
  const client = {
    getBlockNumber: async () => 20n,
    multicall: async () => [1n, 100n, { perHandle: 4, firstPrice: 0n, paidPrice: 0n, firstPriceBnb: 0n, paidPriceBnb: 0n }, 0n, false, 100, 1n],
    getLogs: async () => [],
    ...overrides,
  };
  const { Indexer } = loadModule("lib/indexer.ts", {
    "./rpc": {
      RpcPool: {
        call: () => { throw new Error("index synchronization must use historical providers"); },
        status: () => [{ label: "rpc#1", fails: 0, cooldown: false, ms: 10, lastOk: 1000 }],
      },
      HistoryRpcPool: {
        call: fn => fn(client),
        status: () => [{ label: "history#1", fails: 0, cooldown: false, ms: 20, lastOk: 1000 }],
      },
    },
    "@/lib/index-cache": { IndexCache: cache },
  }, { __monitor: cached, console: { error() {} }, ...globals });
  return { Indexer, cached };
}

test("chain synchronization uses history providers while snapshots expose both pool statuses", async () => {
  const { Indexer, cached } = fixture();
  await Indexer.sync();
  assert.equal(cached.lastError, null);
  assert.equal(cached.lastBlock, 20n);
  const snapshot = Indexer.snapshot();
  assert.equal(snapshot.rpc[0].label, "rpc#1");
  assert.equal(snapshot.historyRpc[0].label, "history#1");
});

test("rate-limit failures do not recursively multiply getLogs requests", async () => {
  let count = 0;
  const { Indexer, cached } = fixture({ getLogs: async () => { count++; throw new Error("429 Too Many Requests"); } });
  await Indexer.sync();
  assert.equal(count, 1);
  assert.equal(cached.lastBlock, 0n);
  assert.match(cached.lastError, /429/);
});

test("an ambiguous provider limit error does not fan out into smaller requests", async () => {
  let count = 0;
  const { Indexer, cached } = fixture({ getLogs: async () => { count++; throw new Error("limit exceeded"); } });
  await Indexer.sync();
  assert.equal(count, 1);
  assert.equal(cached.lastBlock, 0n);
});

test("backfill retries respect the sync cooldown after an upstream failure", async () => {
  let count = 0;
  class Clock extends Date { static now() { return 1001; } }
  const { Indexer } = fixture({ getBlockNumber: async () => { count++; return 20n; } }, state({ lastAttempt: 1000 }), { Date: Clock });
  await Indexer.sync();
  assert.equal(count, 0);
});

test("range-limited responses are split and every bid is indexed exactly once", async () => {
  const { Contracts } = loadModule("lib/contracts.ts");
  const { Indexer, cached } = fixture({
    getLogs: async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock > 4n) throw new Error("block range is too wide");
      return Array.from({ length: Number(toBlock - fromBlock + 1n) }, (_, i) => {
        const block = fromBlock + BigInt(i);
        return {
          address: Contracts.market, blockNumber: block, blockTimestamp: 1700000000n + block,
          transactionHash: "0x" + "1".repeat(64),
          topics: encodeEventTopics({ abi: Contracts.marketAbi, eventName: "BidPlaced", args: { id: block, buyer, asset: 0 } }),
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }, { type: "uint16" }], [1000000000000000000n, 1, 100]),
        };
      });
    },
  });
  await Indexer.sync();
  assert.equal(cached.lastBlock, 20n);
  assert.equal(Indexer.snapshot().asset.relic.count, 20);
  assert.equal(Indexer.snapshot().asset.relic.demand, 20);
  assert.equal(cached.lastError, null);
});

test("concurrent refreshes share one upstream sync", async () => {
  let calls = 0;
  const head = deferred();
  const { Indexer } = fixture({ getBlockNumber: async () => { calls++; return head.promise; } });
  const a = Indexer.sync(); const b = Indexer.sync();
  assert.equal(calls, 1);
  head.resolve(20n);
  await Promise.all([a, b]);
});

test("a failed head request keeps its paired state read within the single-flight lock", async () => {
  const pending = deferred();
  let calls = 0;
  const { Indexer, cached } = fixture({
    getBlockNumber: async () => { calls++; throw new Error("head unavailable"); },
    multicall: () => pending.promise,
  });
  const first = Indexer.sync();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  cached.lastAttempt = 0;
  const second = Indexer.sync();
  try { assert.equal(calls, 1, "a pending state read must not overlap the next refresh"); }
  finally {
    pending.resolve([1n, 100n, { perHandle: 4, firstPrice: 0n, paidPrice: 0n, firstPriceBnb: 0n, paidPriceBnb: 0n }, 0n, false, 100, 1n]);
    await Promise.all([first, second]);
  }
});

test("a failed log batch waits for its sibling requests before releasing the sync lock", async () => {
  const pending = deferred();
  let calls = 0;
  const { Indexer, cached } = fixture({
    getBlockNumber: async () => 10000n,
    getLogs: () => ++calls === 1 ? Promise.reject(new Error("logs unavailable")) : pending.promise,
  });
  const first = Indexer.sync();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  cached.lastAttempt = 0;
  const second = Indexer.sync();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  try { assert.equal(calls, 4, "the next batch must not overlap unfinished siblings"); }
  finally { pending.resolve([]); await Promise.all([first, second]); }
});

function checkpoint() {
  const { Contracts } = loadModule("lib/contracts.ts");
  return {
    version: 1, chainId: 56,
    contracts: [Contracts.game, Contracts.market, Contracts.relic, Contracts.loom].map(a => a.toLowerCase()).join(":"),
    fromBlock: "1", lastBlock: "20", head: "20", syncedAt: 1700000000000, feeBps: 100,
    bids: [[7, { id: 7, buyer, asset: "relic", price: 1, qty: 2, remaining: 2, ts: 1700000000000 }]], fills: [],
    holders: { relic: [[buyer, 2]], loom: [] },
    mint: { minted: 1, cap: 100, startTime: 0, requireHandle: false, perHandle: 4, firstUsdt: 0, paidUsdt: 0, firstBnb: 0, paidBnb: 0, relicSupply: 1 },
  };
}

test("a restart restores the complete checkpoint without rescanning old blocks", async () => {
  let logCalls = 0;
  const { Indexer } = fixture({ getLogs: async () => { logCalls++; return []; } }, state({ fromBlock: 0n, head: 0n }), {}, {
    read: async () => checkpoint(), write: async () => {},
  });
  await Indexer.sync();
  const s = Indexer.snapshot();
  assert.equal(s.block, 20);
  assert.equal(s.asset.relic.count, 1);
  assert.equal(s.asset.relic.demand, 2);
  assert.equal(s.asset.relic.holders[0].count, 2);
  assert.equal(logCalls, 0);
});

test("checkpoint from a different chain is ignored", async () => {
  const cp = checkpoint(); cp.chainId = 1;
  let codeReads = 0;
  const { Indexer } = fixture({ getCode: async ({ blockNumber }) => { codeReads++; return blockNumber >= 10n ? "0x1234" : "0x"; } }, state({ fromBlock: 0n, head: 0n }), {}, {
    read: async () => cp, write: async () => {},
  });
  await Indexer.sync();
  assert.equal(Indexer.snapshot().asset.relic.count, 0);
  assert.ok(codeReads > 0);
});

test("mismatched contracts and malformed checkpoint data fall back to a fresh index", async () => {
  for (const mutate of [
    c => { c.contracts = "another deployment"; },
    c => { c.lastBlock = "invalid"; },
    c => { c.lastBlock = "21"; },
    c => { c.bids = [[7, null]]; },
    c => { c.holders.relic = [[buyer, -1]]; },
  ]) {
    const cp = checkpoint(); mutate(cp);
    let codeReads = 0;
    const { Indexer } = fixture({ getCode: async ({ blockNumber }) => { codeReads++; return blockNumber >= 10n ? "0x1234" : "0x"; } }, state({ fromBlock: 0n, head: 0n }), {}, {
      read: async () => cp, write: async () => {},
    });
    await Indexer.sync();
    assert.equal(Indexer.snapshot().asset.relic.count, 0);
    assert.ok(codeReads > 0);
  }
});

test("successful backfill saves a restartable checkpoint with JSON-safe blocks", async () => {
  const saved = [];
  const { Indexer } = fixture({}, state(), {}, { read: async () => null, write: async value => saved.push(value) });
  await Indexer.sync();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lastBlock, "20");
  assert.doesNotThrow(() => JSON.stringify(saved[0]));
});
