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
