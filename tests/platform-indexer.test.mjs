import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { loadModule, buyer, account } from "./helpers.mjs";

const { Contracts } = loadModule("lib/contracts.ts");
const router = "0x3333333333333333333333333333333333333333";
const other = "0x4444444444444444444444444444444444444444";
const saleAbi = parseAbi(["event PlatformSale(uint256 indexed bidId,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 gross,uint256 marketFee,uint256 platformFee,uint256 proceeds)"]);
const unit = 10n ** 18n;
const tx = "0x" + "a".repeat(64);

test("index fixtures match the shared ABI and compiled router event", () => {
  const shared = loadModule("lib/platform-fee.ts").PLATFORM_SALE_ABI;
  const artifact = JSON.parse(readFileSync(new URL("../lib/platform-fee-bytecode.json", import.meta.url), "utf8"));
  const shape = abi => JSON.stringify(abi.find(x => x.type === "event" && x.name === "PlatformSale").inputs
    .map(({ name, type, indexed }) => ({ name, type, indexed: !!indexed })));
  assert.equal(shape(shared), shape(saleAbi));
  assert.equal(shape(artifact.abi), shape(saleAbi));
});

function log(abi, eventName, address, args, fields, index = 0, block = 10n) {
  const event = abi.find(x => x.type === "event" && x.name === eventName);
  return { address, transactionHash: tx, blockNumber: block, blockTimestamp: 1700000000n + block,
    logIndex: index, topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(event.inputs.filter(x => !x.indexed), fields) };
}
function fill({ id = 7n, tokenId = 19n, seller = router, price = 100n * unit, fee = unit, index = 1, block = 10n, asset = 0 } = {}) {
  return log(Contracts.marketAbi, "BidFilled", Contracts.market, { id, seller, buyer }, [asset, tokenId, price, fee], index, block);
}
function sale({ id = 7n, tokenId = 19n, seller = account, address = router, gross = 100n * unit, marketFee = unit, platformFee = unit / 2n, proceeds = 985n * unit / 10n, index = 2, block = 10n, asset = 0, buyer: saleBuyer = buyer } = {}) {
  return log(saleAbi, "PlatformSale", address, { bidId: id, seller, buyer: saleBuyer }, [asset, tokenId, gross, marketFee, platformFee, proceeds], index, block);
}
function state(overrides = {}) {
  return { fromBlock: 1n, lastBlock: 0n, bids: new Map([[7, { id: 7, buyer, asset: "relic", price: 100, qty: 4, remaining: 4, ts: 1 }]]), fills: [],
    holders: { relic: new Map([[account, 4]]), loom: new Map() }, mint: null, feeBps: 100,
    syncedAt: 0, lastError: null, syncing: null, lastAttempt: 0, head: 20n, ...overrides };
}
function fixture(logs = [], options = {}) {
  const cached = options.state ?? state(); const requests = [], saved = [];
  const client = { getBlockNumber: async () => options.head ?? 20n,
    multicall: async () => [1n, 100n, { perHandle: 4, firstPrice: 0n, paidPrice: 0n, firstPriceBnb: 0n, paidPriceBnb: 0n }, 0n, false, 100, 1n],
    getLogs: async request => { requests.push(request); options.onRequest?.(request); return logs.filter(l => l.blockNumber >= request.fromBlock && l.blockNumber <= request.toBlock); },
    getCode: async () => { throw new Error("must not rescan market deployment"); } };
  const pool = { call: fn => fn(client), status: () => [] };
  const { Indexer } = loadModule("lib/indexer.ts", {
    "./rpc": { HistoryRpcPool: pool, RpcPool: pool },
    "@/lib/platform-fee": { platformFeeRouterAddress: () => options.disabled ? undefined : router, PLATFORM_SALE_ABI: saleAbi },
    "@/lib/index-cache": { IndexCache: { read: async () => options.checkpoint ?? null, write: async value => saved.push(structuredClone(value)) } },
  }, { __monitor: cached, process: { env: { NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK: options.start ?? "5" } }, ...options.globals });
  return { Indexer, cached, requests, saved };
}
function checkpoint(fills) {
  return { version: 1, chainId: 56, contracts: [Contracts.game, Contracts.market, Contracts.relic, Contracts.loom].map(a => a.toLowerCase()).join(":"),
    fromBlock: "1", lastBlock: "20", head: "20", syncedAt: 1, feeBps: 100,
    bids: [[7, { id: 7, buyer, asset: "relic", price: 100, qty: 4, remaining: 3, ts: 1 }]], fills,
    holders: { relic: [[buyer, 1], [account, 3]], loom: [] }, mint: null };
}
const legacyFill = () => ({ asset: "relic", price: 100, ts: 1700000010000, tx, buyer, seller: router, block: 10 });

for (const reversed of [false, true]) test(`router sale enriches one original fill with reverse arrival=${reversed}`, async () => {
  const logs = [fill(), sale()]; if (reversed) logs.reverse();
  const { Indexer, cached, requests } = fixture(logs);
  await Indexer.sync();
  const view = Indexer.snapshot().asset.relic;
  assert.equal(view.volume.totalFills, 1); assert.equal(view.volume.totalUsdt, 100);
  assert.equal(view.fills[0].seller, account); assert.equal(view.fills[0].marketFee, 1);
  assert.equal(view.fills[0].platformFee, 0.5); assert.equal(view.fills[0].proceeds, 98.5);
  assert.equal(cached.bids.get(7).remaining, 3); assert.equal(cached.holders.relic.get(account), 4);
  assert.equal(Indexer.klines(60, "relic", 200)[0].n, 1);
  assert.equal(requests.length, 1); assert.ok(requests[0].address.includes(router));
});

test("same-transaction fills match their NFT and bid, while original direct fills remain unchanged", async () => {
  const { Indexer, cached } = fixture([sale({ tokenId: 20n, seller: other }), fill(), fill({ tokenId: 20n, index: 3 }), sale(), fill({ seller: other, tokenId: 21n, index: 5 })]);
  await Indexer.sync(); const view = Indexer.snapshot().asset.relic;
  assert.deepEqual(Array.from(view.fills, f => f.seller), [other, other, account]);
  assert.equal(view.volume.totalUsdt, 300); assert.equal(view.volume.totalFills, 3);
  assert.equal(view.fills[0].platformFee, undefined); assert.equal(cached.bids.get(7).remaining, 1);
});

for (const mismatch of [{ address: other }, { buyer: other }, { asset: 1 }, { tokenId: 20n }, { id: 8n }, { gross: 101n * unit }, { marketFee: 2n * unit }, { platformFee: unit }, { proceeds: 99n * unit }, { block: 11n }]) test(`unmatched or forged sale cannot rewrite original fill: ${JSON.stringify(mismatch, (_, v) => typeof v === "bigint" ? String(v) : v)}`, async () => {
  const { Indexer } = fixture([fill(), sale(mismatch)]); await Indexer.sync();
  const view = Indexer.snapshot().asset.relic;
  assert.equal(view.fills[0].seller, router); assert.equal(view.fills[0].platformFee, undefined);
  assert.equal(view.volume.totalFills, 1);
});

test("router transfer logs update holdings once and suffix repair never reapplies transfers", async () => {
  const transfers = [
    log(Contracts.erc721Abi, "Transfer", Contracts.relic, { from: account, to: router, tokenId: 19n }, [], 0),
    log(Contracts.erc721Abi, "Transfer", Contracts.relic, { from: router, to: buyer, tokenId: 19n }, [], 3),
  ];
  const logs = [sale(), ...transfers, fill()];
  const fresh = fixture(logs); await fresh.Indexer.sync();
  assert.equal(fresh.cached.holders.relic.get(account), 3);
  assert.equal(fresh.cached.holders.relic.get(buyer), 1);
  assert.equal(fresh.cached.holders.relic.has(router), false);
  const repair = fixture(logs, { checkpoint: checkpoint([legacyFill()]), state: state({ fromBlock: 0n }) });
  await repair.Indexer.sync();
  assert.equal(repair.cached.holders.relic.get(account), 3);
  assert.equal(repair.cached.holders.relic.get(buyer), 1);
  assert.equal(repair.cached.holders.relic.has(router), false);
});

test("LOOMS router fills retain separate asset volume and per-order market fee", async () => {
  const { Indexer } = fixture([fill({ asset: 1, fee: 2n * unit }), sale({ asset: 1, marketFee: 2n * unit, proceeds: 975n * unit / 10n })]);
  await Indexer.sync();
  const snapshot = Indexer.snapshot();
  assert.equal(snapshot.asset.relic.volume.totalFills, 0);
  assert.equal(snapshot.asset.loom.volume.totalFills, 1);
  assert.equal(snapshot.asset.loom.fills[0].seller, account);
  assert.equal(snapshot.asset.loom.fills[0].marketFee, 2);
  assert.equal(snapshot.asset.loom.fills[0].proceeds, 97.5);
});

test("router-shaped events do not rewrite direct market fills or predeployment events", async () => {
  for (const [logs, start] of [[[fill({ seller: account }), sale()], "5"], [[fill(), sale()], "11"]]) {
    const { Indexer } = fixture(logs, { start }); await Indexer.sync();
    assert.equal(Indexer.snapshot().asset.relic.fills[0].platformFee, undefined);
  }
});

test("legacy checkpoint suffix repair restores seller without replaying bids or holders", async () => {
  const cp = checkpoint([legacyFill()]);
  const { Indexer, requests, saved, cached } = fixture([sale(), fill()], { checkpoint: cp, state: state({ fromBlock: 0n }) });
  await Indexer.sync(); const view = Indexer.snapshot().asset.relic;
  assert.equal(view.fills[0].seller, account); assert.equal(view.volume.totalFills, 1);
  assert.equal(cached.bids.get(7).remaining, 3); assert.equal(view.holders.find(x => x.address === buyer).count, 1);
  assert.equal(requests[0].fromBlock, 5n); assert.equal(requests[0].toBlock, 20n);
  assert.equal(saved[0].version, 2);
  const restart = fixture([fill(), sale()], { checkpoint: saved[0], state: state({ fromBlock: 0n }) });
  await restart.Indexer.sync(); assert.equal(restart.requests.length, 0);
  assert.equal(restart.Indexer.snapshot().asset.relic.fills[0].seller, account);
});

test("router activation after a seed checkpoint continues forward without history replay", async () => {
  const { Indexer, requests } = fixture([], { checkpoint: checkpoint([]), start: "25", state: state({ fromBlock: 0n }), head: 30n });
  await Indexer.sync(); assert.equal(requests.length, 1); assert.equal(requests[0].fromBlock, 21n);
});

test("disabled router reuses legacy seed unchanged with no repair or extra RPC", async () => {
  const { Indexer, requests } = fixture([], { disabled: true, checkpoint: checkpoint([legacyFill()]), state: state({ fromBlock: 0n }) });
  await Indexer.sync(); assert.equal(requests.length, 0);
  assert.equal(Indexer.snapshot().asset.relic.fills[0].seller, router);
});

test("partial suffix repair persists its cursor within the sync budget and resumes on restart", async () => {
  let now = 10_000;
  class Clock extends Date { static now() { return now; } }
  const cp = checkpoint([{ ...legacyFill(), block: 9_500, ts: 1700009500000 }]);
  cp.lastBlock = cp.head = "10000";
  const logs = [fill({ block: 9_500n }), sale({ block: 9_500n })];
  const first = fixture(logs, { checkpoint: cp, state: state({ fromBlock: 0n }), head: 10_000n,
    globals: { Date: Clock }, onRequest: () => { now += 2_001; } });
  await first.Indexer.sync();
  assert.equal(first.requests.length, 4, "only the in-flight four-range repair batch may exceed its budget");
  assert.equal(first.saved[0].platform.through, "4004");
  assert.equal(first.saved[0].lastBlock, "10000", "repair must not rewind the complete book");
  assert.equal(first.cached.bids.get(7).remaining, 3);
  const next = fixture(logs, { checkpoint: first.saved[0], state: state({ fromBlock: 0n }), head: 10_000n });
  await next.Indexer.sync();
  assert.equal(next.requests[0].fromBlock, 4005n);
  assert.equal(next.Indexer.snapshot().asset.relic.fills[0].seller, account);
  assert.equal(next.Indexer.snapshot().asset.relic.volume.totalFills, 1);
  assert.equal(next.cached.bids.get(7).remaining, 3);
});

test("changed router deployment fingerprint repairs metadata without invalidating the core checkpoint", async () => {
  const old = fixture([fill(), sale()], { checkpoint: checkpoint([legacyFill()]), state: state({ fromBlock: 0n }) });
  await old.Indexer.sync();
  const cp = old.saved[0]; cp.platform.fingerprint = `${other}:5`;
  const next = fixture([fill(), sale()], { checkpoint: cp, state: state({ fromBlock: 0n }) });
  await next.Indexer.sync();
  assert.equal(next.requests[0].fromBlock, 5n);
  assert.equal(next.Indexer.snapshot().asset.relic.fills[0].seller, account);
  assert.equal(next.cached.bids.get(7).remaining, 3);
  assert.equal(next.Indexer.snapshot().asset.relic.volume.totalFills, 1);
});

test("the checked-in production seed remains usable with disabled routing or a later deployment", async () => {
  const raw = readFileSync(new URL("../data/bsc-indexer-seed.json.gz", import.meta.url));
  const cp = JSON.parse(gunzipSync(raw).toString("utf8"));
  for (const disabled of [true, false]) {
    const { Indexer, requests } = fixture([], { checkpoint: structuredClone(cp), state: state({ fromBlock: 0n }),
      disabled, start: String(BigInt(cp.lastBlock) + 1n), head: BigInt(cp.lastBlock) });
    await Indexer.sync();
    const snapshot = Indexer.snapshot();
    assert.equal(snapshot.block, Number(cp.lastBlock));
    assert.equal(requests.length, 0);
    assert.equal(snapshot.asset.relic.volume.totalFills + snapshot.asset.loom.volume.totalFills, cp.fills.length);
    assert.equal(snapshot.asset.relic.holderCount, cp.holders.relic.length);
  }
  assert.deepEqual(readFileSync(new URL("../data/bsc-indexer-seed.json.gz", import.meta.url)), raw);
});
