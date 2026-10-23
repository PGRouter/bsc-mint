# Seller Platform Fee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 对经平台卖出结算的 NFT，仅向卖方额外收取成交价 0.5%，汇入用户指定钱包；买方零额外费用。

**Architecture:** 原市场继续接收买方挂单、持有买单资金和退款。新增固定配置的单 NFT seller router 中转 NFT、调用原市场 fill，并在同一交易中支付原市场费、平台费和卖方净额。前端仅在部署地址与运行代码核验通过后切换卖出路径，索引关联事件恢复真实卖方。

**Tech Stack:** Existing Next.js 15 / React 19 / viem; Solidity compiler pinned via npm; OpenZeppelin contracts; local Anvil and Node test runner for EVM tests.

**Spec:** `docs/superpowers/specs/2026-10-24-platform-fee-design.md`（用户已确认）

## Global Constraints

- BSC chain ID 56; seller fee 50 bps; buyer platform fee 0.
- Recipient `0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15`.
- 固定原 market/USDT/RELICS/LOOMS 地址，部署后无可变税率/收款地址、升级、任意调用或拉款入口。
- 每次只处理一个 NFT，只授权此 NFT，买入/撤单不改变；不向买方收取、预存或授权平台费。
- 平台费以真实订单成交总额整数向下取整；原市场费使用该订单费率与实际收款差核实。
- 不代用户签名、部署或支付 Gas；未部署/未核验时保留原流程且不宣称平台费生效。
- 验证实际主网合约兼容性；失败则报告证据，不用两笔转账替代原子结算。

## Review Focus

- 市场订单消失/数量改变或旧单费率与全局不同：报价须刷新，执行不误扣或多付。
- 买方或卖方恰好是平台收款人、router 有既有余额：正确按本次差额结算，不提走无关资金。
- NFT 回调、ERC20 返回 false/无返回、重入及后半段失败：所有业务余额/所有权回滚。
- 切换资产、钱包或买单时迟到 RPC：旧报价/授权不能提交到新上下文。
- 激活 router 后旧缓存、同交易多条日志：不重复 K 线/成交，真实卖方可恢复，原买单与持仓状态不重放污染。

---

### Task 1: 固定收费合约与真实 EVM 验证

**Files:** `contracts/SellerFeeRouter.sol`, `tests/contracts/*.test.mjs`, `contracts/test/*.sol`, `scripts/build-platform-fee.mjs`, generated `lib/platform-fee-bytecode.json`, `lib/platform-fee-runtime.ts`.

**Interfaces:** Zero-argument constructor fixes BSC addresses and recipient. Getters `market()`, `usdt()`, `relic()`, `loom()`, `feeRecipient()`, `platformFeeBps()`. `quote(uint256 bidId)` returns `(address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 marketFeeBps,uint256 marketFee,uint256 platformFee,uint256 proceeds)`. `sell(uint256 bidId,uint256 tokenId,uint256 minProceeds,uint256 deadline)`. `PlatformSale(uint256 indexed bidId,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 gross,uint256 marketFee,uint256 platformFee,uint256 proceeds)`.

- [x] Write real EVM tests first: 100 USDT / 100 bps protocol → 0.5 platform and 98.5 seller, buyer receives NFT with no extra USDT debit; both assets; different per-order fee; floor arithmetic; unrelated router balance; platform recipient participant; cancellation/exhaustion/deadline/minimum/ownership/self-trade/reentrancy/transfer failures all revert state.
- [x] Run tests to observe missing-contract red result, then implement fixed contract with bounded asset/market calls, single-NFT receive context, safe token payments, post-fill ownership/quantity and exact balance-delta checks.
- [x] Compile deterministically with pinned compiler/library and emit ABI, bytecode, deployed runtime hash, compiler inputs/source hashes; no secrets or env in generated artifacts.
- [x] Run unit EVM tests and real BSC fork tests on both RELICS/LOOMS using existing live buy orders and actual NFT holder accounts impersonated **only on localhost**. Verify all balances, approvals, ownership and event fields, plus rollback. No mainnet write RPC.
- [x] Commit source/tests/artifacts after fresh independent review.

### Task 2: 可核验的前端卖出路径

**Files:** `lib/platform-fee.ts`, `app/trade/panel.tsx`, `tests/platform-fee.test.mjs`, `tests/panels.test.mjs`.

**Interfaces:** Shared module exports `PLATFORM_FEE_BPS=50n`, `PLATFORM_FEE_RECIPIENT`, `PLATFORM_FEE_ABI` matching Task 1, `PLATFORM_SALE_ABI`, `platformFeeRouterAddress(): Address|undefined` from `NEXT_PUBLIC_PLATFORM_FEE_ROUTER`; expected runtime hash from generated metadata. Pure bigint quote helper for gross/protocol/platform/net. An async verification helper validates chain, runtime hash, fixed getters and live quote before enabling sell.

- [x] Add failing tests: configured verified router shows separate fees and min net; missing config preserves original route; wrong chain/code/getters or RPC failures never enable router; old quote/address/asset cannot submit; buyer still approves/calls original market only.
- [x] Implement per-order on-chain quote, single NFT approval to the selected actual spender, exact sell deadline/minProceeds, latest owner/approval/context checks at signing. Display extra 0.5% and total/net only for verified active route; do not substitute global fee for order fee.
- [x] Preserve original buy/cancel UI, 2s polling, stale handling and user wallet-only signing. Disabled/missing router keeps actual original fees without claiming platform fees collected.
- [x] Run focused tests, typecheck and lint; commit after review.

### Task 3: 路由成交索引与缓存升级

**Files:** `lib/indexer.ts`, `tests/indexer-performance.test.mjs`, `tests/index-cache.test.mjs`, optional focused `tests/platform-indexer.test.mjs`.

**Interfaces:** Consume Task 2 router address / event ABI; `NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK` identifies real deployment start. Preserve existing public snapshot fields and add optional `platformFee`, `marketFee`, `proceeds` on routed fills. Pair only confirmed router events with matching market transaction/bid/NFT, replacing seller without duplicating fill.

- [x] Add failing tests for normal and reversed log arrival, original direct fills, same-tx multiple fills, forged/mismatched events, restart/cache repair, no duplicate volume/holders/bid changes.
- [x] Include router logs in the existing batch request and enrich fills exactly once. Preserve real seller even when checkpoint predates new metadata.
- [x] Version/fingerprint router cache state with safe migration or bounded suffix repair; disabled router accepts existing seed unchanged. Activation must not require rescanning all market history or corrupt bid/holder counts.
- [x] Run indexing/cache regressions and contract-event fixture checks; commit after review.

### Task 4: 可审查的用户部署与整体验收

**Files:** `app/platform-fee/page.tsx`, deployment client component, `scripts/verify-platform-fee.mjs`, `README.md`, `.env.example`, deployment evidence in ignored `artifacts/platform-fee/`.

**Interfaces:** Deployment review page lazily imports Task 1 artifact, displays chain/recipient/fixed fees/source hash, zero BNB transfer value plus estimated gas, and uses the connected user's wallet `deployContract` only after their explicit click. It does not auto-activate any returned address. Verification script checks actual receipt/start block, runtime hash and all fixed getters before producing activation configuration.

- [x] Test wrong-chain/no-wallet/already-configured deployment states and no auto-deploy or activation. Build review page and verification script; make artifact reproducible.
- [x] Run complete Node unit/frontend/index tests, EVM tests and real fork tests; lint/typecheck and isolated production build; resolve independent whole-change review findings.
- [x] Verify desktop/mobile page, fee labels and wrong-chain gating with CUA. Retain original live trading behavior while router not deployed.
- [ ] Back up reviewed source to GitHub and deploy web support in disabled state; verify production three pages/social links/API remain operational. Show exact deployment review URL and prepared transaction to user for wallet deployment.
- [ ] After user deploys: verify chain receipt/configuration, add router address + start block env, rebuild and deploy, verify end-to-end quotes/indexing. Do not claim live collection before this step; actual user sale remains user-signed.
