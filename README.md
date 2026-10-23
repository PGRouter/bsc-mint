# Relic Desk

BSC 主网的 RELICS / LOOMS 监控、铸造与交易应用。

[打开网站](https://oylai.fun/?lang=zh)

## 本地运行

```bash
cp .env.example .env.local
npm ci --legacy-peer-deps
npm run dev
```

在 `.env.local` 中配置服务端 RPC：

- `BSC_RPC_URL`：普通链上读取，可填写多个节点，以逗号分隔。
- `HISTORY_RPC_URL`：历史索引节点，需支持历史状态和 `eth_getLogs`。

访问 [localhost:3000](http://localhost:3000/?lang=zh)。生产运行使用 `npm run build` 和 `npm start`。

## 检查

```bash
npm test
npm run lint
npm run typecheck
```
