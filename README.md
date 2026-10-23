# bsc-mint

BSC mint + trading web app.

## Step 1: read-only monitor

```bash
cp .env.example .env.local   # set BSC_RPC_URL (server-side only; comma-separated for failover)
npm install
npm run lint && npm run typecheck && npm run build
npm start                    # http://localhost:3000/?lang=en
```

- `GET /api/snapshot`: block, mint state, per-asset bid book, fills, volume, and top holders
- `GET /api/klines?sec=30|60|300|900|3600&asset=relic|loom&limit=N`: OHLC from BidFilled
