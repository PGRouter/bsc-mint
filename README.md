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

Data endpoints return the latest index immediately and refresh it in the background. `ready`, `backfill`, and `stale` describe data availability, historical coverage, and connection freshness. The frontend keeps one polling request in flight per view and pauses polling while hidden.

`BSC_RPC_URL` supplies general reads through `/api/rpc`. `HISTORY_RPC_URL` supplies all index synchronization, including historical `eth_getCode` and `eth_getLogs`; use archive/log-capable providers here. Each variable accepts a comma-separated list, with the primary first and failover nodes after it. Public endpoints that disable `eth_getLogs` can still be used in `BSC_RPC_URL` for the reads they support.

If `HISTORY_RPC_URL` is absent or empty, indexing falls back to `BSC_RPC_URL` for compatibility. The two pools always keep separate clients, failure counts, and cooldowns, even when their URLs match. Snapshot fields `rpc` and `historyRpc` expose only labeled health metrics (`rpc#N` and `history#N`), never endpoint URLs or credentials.

Public index checkpoints are saved to `.cache/bsc-indexer-v1.json.gz` so restarts can resume without scanning all history again. Set `BSC_INDEX_CACHE_FILE` to choose a persistent writable path. A missing or invalid checkpoint falls back to a fresh sync.

`npm test` runs the wallet UI and RPC validation regressions with isolated network/wallet fixtures; it does not sign or broadcast transactions.
