import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness, deferred, snapshot, textOf, bid } from "./helpers.mjs";

const mintRead = ({ functionName, args }) => ({
  publicMinted: 1n, publicCap: 100n, mintStartTime: 0n, requireHandle: false,
  config: { perHandle: 4 }, handleOf: "audit.ai", allowance: 0n, balanceOf: 100n,
  quote: [5000000000000000000n, 3],
  quoteBnb: [1000000000000000n * BigInt(args?.[1] ?? 1), 3],
})[functionName];

test("trade market summary uses full demand and escrow instead of the displayed bid slice", async () => {
  const s = snapshot();
  s.asset.relic.demand = 12000;
  s.asset.relic.escrow = 501000;
  const h = panelHarness("app/trade/panel.tsx", { fetch: async () => Response.json(s) });
  await h.flush();
  const summary = h.all().find(n => n.props.className === "trade-market-stats");
  assert.ok(textOf(summary).includes("12,000"));
  assert.ok(textOf(summary).includes("501,000"));
});

test("asset switch clears selected bid, token ID and stale book before another NFT approval", async () => {
  const h = panelHarness("app/trade/panel.tsx");
  await h.flush();
  h.all().find(n => n.type === "tr" && n.props.onClick).props.onClick();
  h.render();
  h.byId("token-id").props.onChange({ target: { value: "42" } });
  h.render();
  assert.ok(h.byId("approve-nft"));
  h.button("LOOMS").props.onClick();
  h.render();
  assert.equal(h.byId("token-id").props.value, "");
  assert.equal(h.byId("approve-nft"), undefined);
  assert.equal(h.byId("fill"), undefined);
  assert.equal(textOf(h.byId("book")).includes("#7"), false);
  await h.flush();
  assert.equal(textOf(h.byId("book")).includes("#9"), true);
});

test("late RELIC snapshot cannot replace the LOOM book after switching assets", async () => {
  const old = deferred();
  let count = 0;
  const h = panelHarness("app/trade/panel.tsx", {
    fetch: async () => ++count === 2 ? old.promise : Response.json(snapshot()),
  });
  await h.flush();
  h.poll();
  h.button("LOOMS").props.onClick();
  h.render();
  await h.flush();
  assert.equal(textOf(h.byId("book")).includes("#9"), true);
  const stale = snapshot(); stale.asset.relic.bids = [bid(77)];
  old.resolve(Response.json(stale));
  await h.flush();
  assert.equal(textOf(h.byId("book")).includes("#9"), true);
  assert.equal(textOf(h.byId("book")).includes("#77"), false);
});

test("asset cannot change while a transaction is in progress", async () => {
  const h = panelHarness("app/trade/panel.tsx");
  await h.flush();
  h.tx.busy = true;
  h.render();
  assert.equal(h.button("LOOMS").props.disabled, true);
  assert.equal(h.button("RELICS").props.disabled, true);
});

test("switching back to RELIC still rejects requests from the previous RELIC visit", async () => {
  const old = deferred();
  let count = 0;
  const h = panelHarness("app/trade/panel.tsx", {
    fetch: async () => ++count === 2 ? old.promise : Response.json(snapshot()),
  });
  await h.flush();
  h.poll();
  h.button("LOOMS").props.onClick(); h.render(); await h.flush();
  h.button("RELICS").props.onClick(); h.render(); await h.flush();
  const stale = snapshot(); stale.asset.relic.bids = [bid(77)];
  old.resolve(Response.json(stale));
  await h.flush();
  assert.equal(textOf(h.byId("book")).includes("#7"), true);
  assert.equal(textOf(h.byId("book")).includes("#77"), false);
});

test("first BNB selection estimates the BNB quote instead of the USDT quote", async () => {
  const h = panelHarness("app/mint/panel.tsx", { read: mintRead });
  await h.flush();
  h.byId("pay-bnb").props.onClick();
  h.render();
  await h.flush();
  assert.equal(h.estimates.length, 1);
  assert.equal(h.estimates[0].value, 1000000000000000n);
});

test("changing BNB mint quantity refreshes gas and ignores the earlier estimate", async () => {
  const old = deferred();
  const values = [];
  const h = panelHarness("app/mint/panel.tsx", { read: mintRead });
  h.pc.estimateGas = args => {
    values.push(args.value);
    return values.length === 1 ? old.promise : Promise.resolve(50000n);
  };
  await h.flush();
  h.byId("pay-bnb").props.onClick(); h.render();
  h.button("2").props.onClick(); h.render();
  await h.flush();
  assert.equal(values.at(-1), 2000000000000000n);
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.00005 BNB"));
  old.resolve(21000n);
  await h.flush();
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.00005 BNB"));
});

test("clicking the selected quantity keeps the current BNB gas estimate", async () => {
  const h = panelHarness("app/mint/panel.tsx", { read: mintRead });
  await h.flush();
  h.byId("pay-bnb").props.onClick(); h.render(); await h.flush();
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.000021 BNB"));
  h.button("1").props.onClick(); h.render(); await h.flush();
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.000021 BNB"));
});

test("an earlier transaction simulation cannot overwrite gas for the current quantity", async () => {
  const old = deferred();
  let oneCount = 0;
  const h = panelHarness("app/mint/panel.tsx", { read: mintRead });
  h.pc.call = async () => undefined;
  h.pc.estimateGas = ({ value }) => value === 2000000000000000n
    ? Promise.resolve(50000n) : ++oneCount === 1 ? Promise.resolve(21000n) : old.promise;
  await h.flush();
  h.byId("pay-bnb").props.onClick(); h.render(); await h.flush();
  h.byId("mint-bnb").props.onClick();
  const simulation = h.writes[0][1]();
  await h.flush();
  h.button("2").props.onClick(); h.render(); await h.flush();
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.00005 BNB"));
  old.resolve(21000n);
  await simulation; await h.flush();
  assert.ok(textOf(h.byId("cost")).includes("≈ 0.00005 BNB"));
});

// Dedicated mutable provider harness for asynchronous sale context/signing tests.
// Network and wallet calls are observed only; no transaction can broadcast.
async function saleHarness({ configured = true, approved = false, chain = 56, startBlock = "123" } = {}) {
  const { loadModule, nodes, account, buyer } = await import("./helpers.mjs");
  const { keccak256 } = await import("viem");
  const router = "0x3333333333333333333333333333333333333333";
  const { Contracts } = loadModule("lib/contracts.ts");
  const unit = 10n ** 18n;
  const slots = [], pending = [], intervals = new Map(), writes = [], simulated = [], sent = [];
  let cursor = 0, tree, dirty = true;
  const same = (a, b) => a?.length === b?.length && a?.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { const next = typeof v === "function" ? v(slots[i]) : v; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) pending.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const state = { account, chain, approved, owner: account, fee: 175, remaining: 2, allowance: 0n };
  const wallet = { chain: { id: chain }, request: async ({ method }) => method === "eth_accounts" ? [state.account] : `0x${state.chain.toString(16)}`, writeContract: async args => { sent.push(args); return "0x01"; } };
  const pc = {
    getChainId: async () => 56, getBytecode: async () => "0x6000",
    readContract: async ({ functionName }) => ({
      market: Contracts.market, usdt: Contracts.usdt, relic: Contracts.relic, loom: Contracts.loom,
      feeRecipient: "0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15", platformFeeBps: 50n,
      bid: [buyer, 0, 100n * unit, state.remaining, state.fee, 1n],
      quote: [buyer, 0, 100n * unit, state.remaining, state.fee, BigInt(state.fee) * unit / 100n, unit / 2n, 100n * unit - BigInt(state.fee) * unit / 100n - unit / 2n],
      ownerOf: state.owner, getApproved: state.approved ? (configured ? router : Contracts.market) : Contracts.usdt,
      isApprovedForAll: false, allowance: 0n,
    })[functionName],
    simulateContract: async args => { simulated.push(args); },
  };
  const tx = { phase: "idle", busy: false, label: "", run: (...args) => writes.push(args) };
  const mod = loadModule("app/trade/panel.tsx", {
    react, "@/lib/platform-fee-runtime": { PLATFORM_FEE_RUNTIME_HASH: keccak256("0x6000") },
    wagmi: { usePublicClient: () => pc, useWalletClient: () => ({ data: wallet }), useReadContracts: () => ({ data: [{ result: state.allowance }], refetch() {} }) },
    "@/components/shell": { Shell: "Shell" }, "@/components/tx": { TxStatus: "TxStatus", useTx: () => tx },
    "@/components/wallet": { useWalletGate: () => ({ address: state.account, ok: state.chain === 56 }) },
    "@/components/ui": { TableState: { empty() {}, loading() {} } },
  }, {
    process: { env: configured ? { NEXT_PUBLIC_PLATFORM_FEE_ROUTER: router, NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK: startBlock } : {} },
    fetch: async () => { const s = snapshot(); s.asset.relic.mine = [bid(8)]; return Response.json(s); }, setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
  });
  function render() { cursor = 0; dirty = false; const inner = mod.default().props.children("zh"); tree = inner.type(inner.props); pending.splice(0).forEach(fn => fn()); }
  async function flush() { if (!tree) render(); for (let i = 0; i < 100; i++) { await Promise.resolve(); if (dirty) render(); } }
  const all = () => nodes(tree);
  const byId = id => all().find(n => n.props["data-testid"] === id);
  await flush();
  all().find(n => n.type === "tr" && n.props.onClick).props.onClick(); render();
  byId("token-id").props.onChange({ target: { value: "42" } }); render(); await flush();
  return { state, pc, wallet, writes, sent, simulated, all, byId, render, flush, router, Contracts, poll: () => [...intervals.values()].forEach(fn => fn()) };
}

test("verified seller route shows per-order fees, exact minimum and single NFT spender; buyer stays at original market", async () => {
  const h = await saleHarness();
  assert.ok(textOf(h.byId("platform-fee")).includes("0.5"));
  assert.ok(textOf(h.byId("sale-proceeds")).includes("97.75"));
  assert.equal(h.byId("sale-spender").props.title, h.router);
  assert.equal(h.byId("approve-nft").props.disabled, false);
  h.byId("approve-nft").props.onClick(); await h.writes[0][1](); await h.writes[0][2]();
  assert.equal(h.sent[0].functionName, "approve");
  assert.deepEqual([...h.sent[0].args], [h.router, 42n]);
  h.all().find(n => n.type === "button" && textOf(n) === "买入 · 挂买单").props.onClick(); h.render();
  h.byId("approve-usdt").props.onClick();
  await h.writes[1][2]();
  assert.equal(h.sent[1].address, h.Contracts.usdt);
  assert.equal(h.sent[1].args[0], h.Contracts.market);
  h.state.allowance = 10n ** 30n; h.render();
  h.byId("place-bid").props.onClick(); await h.writes[2][2]();
  assert.equal(h.sent[2].functionName, "placeBid");
  assert.equal(h.sent[2].address, h.Contracts.market);
  h.all().find(n => n.type === "button" && textOf(n) === "撤单").props.onClick(); await h.writes[3][2]();
  assert.equal(h.sent[3].functionName, "cancelBid");
  assert.equal(h.sent[3].address, h.Contracts.market);
});

test("unconfigured seller route keeps original fill and actual per-order market fee", async () => {
  const h = await saleHarness({ configured: false, approved: true });
  assert.equal(h.byId("platform-fee"), undefined);
  assert.ok(textOf(h.byId("sale-proceeds")).includes("98.25"));
  h.byId("fill").props.onClick(); await h.writes[0][1](); await h.writes[0][2]();
  assert.equal(h.sent[0].address, h.Contracts.market);
  assert.equal(h.sent[0].functionName, "fill");
  assert.equal(h.sent[0].args[1][0], 42n);
});

test("router sell binds minimum proceeds and deadline and rechecks approval before wallet send", async () => {
  const h = await saleHarness({ approved: true });
  h.byId("fill").props.onClick(); await h.writes[0][1]();
  await h.writes[0][2]();
  assert.equal(h.sent[0].address, h.router);
  assert.equal(h.sent[0].functionName, "sell");
  assert.equal(h.sent[0].args[2], 9775n * 10n ** 16n);
  assert.ok(h.sent[0].args[3] > BigInt(Math.floor(Date.now() / 1000)));
  h.state.approved = false;
  await assert.rejects(h.writes[0][2]());
  assert.equal(h.sent.length, 1);
});

test("changed quote, ownership or provider account/chain after simulation blocks wallet send", async () => {
  for (const mutate of [h => { h.state.fee = 100; }, h => { h.state.remaining = 1; }, h => { h.state.owner = h.router; }, h => { h.state.account = h.router; }, h => { h.state.chain = 97; }]) {
    const h = await saleHarness({ approved: true });
    h.byId("fill").props.onClick(); await h.writes[0][1](); mutate(h);
    await assert.rejects(h.writes[0][2]());
    assert.equal(h.sent.length, 0);
  }
});

test("late sale RPC and previous token callback cannot enable or submit a new NFT context", async () => {
  const h = await saleHarness({ approved: true });
  h.byId("fill").props.onClick();
  const oldWrite = h.writes[0];
  const old = deferred(); const read = h.pc.readContract;
  h.pc.readContract = args => args.functionName === "ownerOf" ? old.promise : read(args);
  h.poll(); await Promise.resolve();
  h.byId("token-id").props.onChange({ target: { value: "43" } }); h.render();
  await assert.rejects(oldWrite[2]());
  assert.equal(h.byId("fill"), undefined);
  old.resolve(h.state.account); await h.flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.byId("token-id").props.value, "43");
});

test("wrong chain and RPC failures disable seller actions without advertising collected fees", async () => {
  const wrong = await saleHarness({ chain: 97 });
  assert.equal(wrong.byId("approve-nft").props.disabled, true);
  assert.equal(wrong.byId("platform-fee"), undefined);
  const h = await saleHarness({ approved: true });
  h.pc.getBytecode = async () => { throw new Error("RPC down"); }; h.poll(); await h.flush();
  assert.equal(h.byId("fill"), undefined);
  assert.equal(h.byId("approve-nft").props.disabled, true);
  assert.equal(h.byId("platform-fee"), undefined);
});

test("reselecting the same bid or unchanged token keeps the valid sale context", async () => {
  const h = await saleHarness({ approved: true });
  h.all().find(n => n.type === "tr" && n.props.onClick).props.onClick(); h.render(); await h.flush();
  assert.equal(h.byId("fill")?.props.disabled, false);
  h.byId("token-id").props.onChange({ target: { value: "42" } }); h.render(); await h.flush();
  assert.equal(h.byId("fill")?.props.disabled, false);
});

test("provider account switched during a slow quote read is checked again immediately before send", async () => {
  const h = await saleHarness({ approved: true });
  h.byId("fill").props.onClick(); await h.writes[0][1]();
  const old = deferred(); const read = h.pc.readContract;
  h.pc.readContract = async args => args.functionName === "ownerOf" ? old.promise : read(args);
  const send = h.writes[0][2]();
  for (let i = 0; i < 50; i++) await Promise.resolve();
  h.state.account = h.router;
  old.resolve("0x1111111111111111111111111111111111111111");
  await assert.rejects(send);
  assert.equal(h.sent.length, 0);
});

test("asset or rendered wallet changes invalidate an already simulated sale", async () => {
  for (const change of [
    h => h.all().find(n => n.type === "button" && textOf(n) === "LOOMS").props.onClick(),
    h => { h.state.account = h.router; },
  ]) {
    const h = await saleHarness({ approved: true });
    h.byId("fill").props.onClick(); await h.writes[0][1]();
    change(h); h.render();
    await assert.rejects(h.writes[0][2]());
    assert.equal(h.sent.length, 0);
  }
});

test("configured address without indexable start block never activates fee sale", async () => {
  for (const startBlock of [undefined, "0", "bad"]) {
    // null intentionally omits configuration (undefined would select the default).
    const h = await saleHarness({ startBlock: startBlock ?? null });
    assert.equal(h.byId("platform-fee"), undefined);
    assert.equal(h.byId("approve-nft").props.disabled, true);
    assert.ok(h.byId("sale-error"));
  }
});
