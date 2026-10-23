# bsc-mint

BSC mint + trading web app.

## Step 1: read-only monitor

```bash
cp .env.example .env.local   # set BSC_RPC_URL and HISTORY_RPC_URL (server-side only)
npm install
npm test && npm run lint && npm run typecheck && npm run build
npm start                    # http://localhost:3000/?lang=en
```

- `GET /api/snapshot`: block, mint state, per-asset bid book, fills, volume, and top holders
- `GET /api/klines?sec=30|60|300|900|3600&asset=relic|loom&limit=N`: OHLC from BidFilled

Data endpoints first restore the local checkpoint once per instance, then return the latest index while refreshing it in the background. `ready`, `backfill`, and `stale` describe data availability, historical coverage, and connection freshness. The frontend polls every two seconds with one request in flight per view and pauses polling while hidden. K-line refreshes preserve existing candles when an instance temporarily returns an unready or empty result.

`BSC_RPC_URL` supplies general reads through `/api/rpc`. `HISTORY_RPC_URL` supplies all index synchronization, including historical `eth_getCode` and `eth_getLogs`; use archive/log-capable providers here. Each variable accepts a comma-separated list, with the primary first and failover nodes after it. Public endpoints that disable `eth_getLogs` can still be used in `BSC_RPC_URL` for the reads they support.

General reads start with the primary and add one backup if it has not succeeded after 350 ms. They allow at most two simultaneous attempts, use the first successful result, cancel unfinished attempts, and stop after a 7.5-second total budget. Failed attempts immediately move to another provider; archive scans retain serial failover to avoid duplicating heavy log queries.

If `HISTORY_RPC_URL` is absent or empty, indexing falls back to `BSC_RPC_URL` for compatibility. The two pools always keep separate clients, failure counts, and cooldowns, even when their URLs match. Snapshot fields `rpc` and `historyRpc` expose only labeled health metrics (`rpc#N` and `history#N`), never endpoint URLs or credentials.

Public index checkpoints are saved to `.cache/bsc-indexer-v1.json.gz` so restarts can resume without scanning all history again. Set `BSC_INDEX_CACHE_FILE` to choose a persistent writable path. A missing or invalid checkpoint falls back to a fresh sync.

`npm test` runs the wallet UI and RPC validation regressions with isolated network/wallet fixtures; it does not sign or broadcast transactions.

## 卖方平台手续费

新增 `contracts/SellerFeeRouter.sol`，仅对经该合约卖出的单个 NFT 收取成交额的 **0.5% USDT**，固定收款地址为 `0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15`。原市场手续费另计，使用该买单保存的费率。买方继续向原市场挂单、授权和撤单，不支付额外平台费。原市场直接成交不会自动收取本平台费。

合约固定 BSC 主网、市场和资产地址；无管理员改费、改收款人、升级、提币或任意调用入口。卖方只授权此次出售的 NFT。原市场成交、平台费和净额付款在同一笔交易完成；失败时业务状态回滚，网络 Gas 仍由签名钱包承担。

```bash
npm run build:platform-fee  # pinned solc 0.8.30 / OpenZeppelin 5.4.0, deterministic artifacts
npm test                   # frontend, RPC, indexing/cache and deployment verification
npm run test:contracts     # disposable local Anvil, no external writes
npm run test:fork          # BSC fixed-block fork; upstream read-only, writes only localhost
npm run lint && npm run typecheck && npm run build
```

分叉测试需要 `.env.local` 中可读取历史状态的 `HISTORY_RPC_URL`；节点凭据不会传入子进程参数或日志。测试使用固定区块，校验两类 NFT 的所有权、每单费率、各方 USDT 增量、买方无额外扣款及失败回滚。

部署与激活：

1. 打开 `/platform-fee?lang=zh` 核对固定配置并估算 Gas。只有用户勾选确认、点击部署并在钱包签名后才发起部署；转账金额为 0 BNB，另付 Gas。
2. 至少 3 次确认后，使用 `npm run verify:platform-fee -- <部署交易哈希>`。脚本只读核验 BSC、部署成功、原始创建字节码、运行代码、固定地址和 50 bps 费率，核验通过才输出地址与部署区块。
3. 将核验值配置为 `NEXT_PUBLIC_PLATFORM_FEE_ROUTER` 和 `NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK`，重新构建和发布网站。部署网页返回的地址不会自动激活收费。
4. 核对页面实时订单报价、原市场费、平台费和最小净到账。旧缓存保留买单和持仓，仅从部署区块补齐路由成交身份与费用，不重复计算成交量。

未配置合约时继续原市场流程，不收取此平台费。地址或部署区块配置错误、链/代码/固定配置不符、报价或 RPC 失败时，卖出会被阻止。每次模拟及发送前重新核验钱包、资产、订单、所有权和授权；所有部署、授权与交易均由用户钱包签名。
