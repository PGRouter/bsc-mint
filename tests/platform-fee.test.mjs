import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { loadModule, account, buyer } from "./helpers.mjs";

const runtime = { PLATFORM_FEE_RUNTIME_HASH: keccak256("0x6000"), PLATFORM_FEE_SOURCE_HASH: "0x00" };
const load = env => loadModule("lib/platform-fee.ts", { "@/lib/platform-fee-runtime": runtime }, { process: { env: env ?? {} } });
const router = "0x3333333333333333333333333333333333333333";
const unit = 10n ** 18n;
function fixture(overrides = {}) {
  const fee = load();
  const { Contracts } = loadModule("lib/contracts.ts");
  const values = { market: Contracts.market, usdt: Contracts.usdt, relic: Contracts.relic, loom: Contracts.loom,
    feeRecipient: fee.PLATFORM_FEE_RECIPIENT, platformFeeBps: 50n,
    bid: [buyer, 0, 100n * unit, 2, 175, 1n],
    quote: [buyer, 0, 100n * unit, 2, 175, 175n * unit / 100n, unit / 2n, 9775n * unit / 100n], ...overrides.values };
  return { fee, pc: { getChainId: async () => 56, getBytecode: async () => "0x6000", readContract: async ({ functionName }) => values[functionName], ...overrides.pc } };
}

test("seller quote uses bigint floor arithmetic and actual order fee", () => {
  const fee = load();
  const q = fee.calculateSaleQuote(100n * unit, 175n);
  assert.equal(q.marketFee, 175n * unit / 100n);
  assert.equal(q.platformFee, unit / 2n);
  assert.equal(q.proceeds, 9775n * unit / 100n);
  assert.equal(fee.calculateSaleQuote(199n, 100n).platformFee, 0n);
  assert.throws(() => fee.calculateSaleQuote(1n, 10000n));
});

test("missing router preserves direct route; malformed or zero config fails closed", () => {
  assert.equal(load().platformFeeRouterAddress(), undefined);
  assert.throws(() => load({ NEXT_PUBLIC_PLATFORM_FEE_ROUTER: router }).platformFeeRouterAddress());
  assert.equal(load({ NEXT_PUBLIC_PLATFORM_FEE_ROUTER: router, NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK: "123" }).platformFeeRouterAddress(), router);
  for (const value of ["bad", "0x0000000000000000000000000000000000000000"]) {
    assert.throws(() => load({ NEXT_PUBLIC_PLATFORM_FEE_ROUTER: value }).platformFeeRouterAddress());
  }
});

test("verified route checks fixed getters and live quote against original order", async () => {
  const { fee, pc } = fixture();
  const q = await fee.readSellerQuote(pc, { router, bidId: 7n, asset: 0, seller: account });
  assert.equal(q.spender, router);
  assert.equal(q.marketFeeBps, 175n);
  assert.equal(q.platformFee, unit / 2n);
  const direct = await fee.readSellerQuote(pc, { bidId: 7n, asset: 0, seller: account });
  assert.equal(direct.platformFee, 0n);
  assert.equal(direct.proceeds, 9825n * unit / 100n);
});

test("wrong chain, code, config, quote or RPC failure never enables platform route", async () => {
  const cases = [
    { pc: { getChainId: async () => 97 } },
    { pc: { getBytecode: async () => "0x6001" } },
    { values: { feeRecipient: buyer } },
    { values: { platformFeeBps: 100n } },
    { values: { quote: [buyer, 0, 100n * unit, 2, 100, unit, unit / 2n, 985n * unit / 10n] } },
    { pc: { readContract: async () => { throw new Error("RPC unavailable"); } } },
  ];
  for (const item of cases) {
    const { fee, pc } = fixture(item);
    await assert.rejects(fee.readSellerQuote(pc, { router, bidId: 7n, asset: 0, seller: account }));
  }
});

test("wrong asset, exhausted, cancelled or self bid cannot be sold", async () => {
  for (const bid of [[buyer, 1, unit, 2, 100, 1n], [buyer, 0, unit, 0, 100, 1n], [account, 0, unit, 1, 100, 1n]]) {
    const { fee, pc } = fixture({ values: { bid } });
    await assert.rejects(fee.readSellerQuote(pc, { bidId: 7n, asset: 0, seller: account }));
  }
});

test("deployment boundary parser requires a positive decimal block", () => {
  assert.equal(load().platformFeeStartBlock(), undefined);
  assert.equal(load({ NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK: "129390000" }).platformFeeStartBlock(), 129390000n);
  for (const value of ["0", "-1", "1.5", "0x99", "NaN", " 12", "012"]) {
    assert.throws(() => load({ NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK: value }).platformFeeStartBlock());
  }
});
