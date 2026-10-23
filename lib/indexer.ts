import { decodeEventLog, formatUnits, type Address, type Log, type PublicClient } from "viem";
import { Contracts } from "./contracts";
import { HistoryRpcPool, RpcPool } from "./rpc";
import { IndexCache } from "@/lib/index-cache";

export type Asset = "relic" | "loom";
type Bid = { id: number; buyer: string; asset: Asset; price: number; qty: number; remaining: number; ts: number };
type Fill = { asset: Asset; price: number; ts: number; tx: string; buyer: string; seller: string; block: number };
type Mint = { minted: number; cap: number; startTime: number; requireHandle: boolean; perHandle: number; firstUsdt: number; paidUsdt: number; firstBnb: number; paidBnb: number; relicSupply: number };
type State = {
  fromBlock: bigint; lastBlock: bigint; bids: Map<number, Bid>; fills: Fill[];
  holders: Record<Asset, Map<string, number>>; mint: Mint | null; feeBps: number;
  syncedAt: number; lastError: string | null; syncing: Promise<void> | null; lastAttempt: number; head: bigint;
  restored?: boolean; preparing?: Promise<void> | null; lastSavedAt?: number;
};
type Checkpoint = {
  version: number; chainId: number; contracts: string;
  fromBlock: string; lastBlock: string; head: string; syncedAt: number; feeBps: number;
  bids: [number, Bid][]; fills: Fill[]; holders: Record<Asset, [string, number][]>; mint: Mint | null;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const g = globalThis as unknown as { __monitor?: State };

/** Cached chain indexer for the market + NFT contracts. Chain sync uses the historical RPC pool. */
export class Indexer {
  static readonly CHUNK = 1_000n;
  static readonly MIN_INTERVAL_MS = 2_000;
  /** Stop starting new backfill batches after this budget; pending RPCs retain their transport timeout. */
  static readonly BUDGET_MS = 8_000;
  static readonly BIG_BID_USDT = 50;
  /** Bids priced below this are spam/dust (e.g. 1 wei x uint32.max) and are excluded from book metrics. */
  static readonly DUST_PRICE_USDT = 0.01;
  static readonly PERIODS = [30, 60, 300, 900, 3600] as const;

  private static get s(): State {
    return (g.__monitor ??= {
      fromBlock: 0n, lastBlock: 0n, bids: new Map(), fills: [],
      holders: { relic: new Map(), loom: new Map() }, mint: null, feeBps: 0,
      syncedAt: 0, lastError: null, syncing: null, lastAttempt: 0, head: 0n, preparing: null,
    });
  }

  /** Restore local data once before serving it; never wait for an RPC refresh here. */
  static async prepare(): Promise<void> {
    const s = Indexer.s;
    if (s.preparing) return s.preparing;
    if (s.restored) return;
    if (s.fromBlock !== 0n) { s.restored = true; return; }
    s.preparing = Indexer.restore().finally(() => {
      s.restored = true;
      s.preparing = null;
    });
    return s.preparing;
  }

  static get ready(): boolean {
    return Indexer.s.mint !== null;
  }

  /** Syncs at most once per MIN_INTERVAL_MS; concurrent callers share one sync. */
  static async sync(): Promise<void> {
    const s = Indexer.s;
    if (s.syncing) return s.syncing;
    if (Date.now() - s.lastAttempt < Indexer.MIN_INTERVAL_MS) return;
    s.lastAttempt = Date.now();
    s.syncing = Indexer.run().then(
      async () => { s.lastError = null; s.syncedAt = Date.now(); await Indexer.save(); },
      (e: unknown) => { s.lastError = e instanceof Error ? e.message.split("\n")[0].replace(/https?:\/\/\S+/g, "<rpc>") : String(e); },
    ).finally(() => { s.syncing = null; });
    return s.syncing;
  }

  private static async run() {
    const s = Indexer.s;
    const t0 = Date.now();
    await Indexer.prepare();
    const [headResult, stateResult] = await Promise.allSettled([HistoryRpcPool.call((c) => c.getBlockNumber()), Indexer.readState()]);
    if (headResult.status === "rejected") throw headResult.reason;
    if (stateResult.status === "rejected") throw stateResult.reason;
    const head = headResult.value;
    s.head = head;
    if (s.fromBlock === 0n) { s.fromBlock = await Indexer.deployBlock(head); s.lastBlock = s.fromBlock - 1n; }
    const ranges: [bigint, bigint][] = [];
    for (let a = s.lastBlock + 1n; a <= head; a += Indexer.CHUNK) ranges.push([a, a + Indexer.CHUNK - 1n > head ? head : a + Indexer.CHUNK - 1n]);
    for (let i = 0; i < ranges.length && Date.now() - t0 < Indexer.BUDGET_MS; i += 4) {
      const batch = await Indexer.all(ranges.slice(i, i + 4).map(([a, b]) =>
        HistoryRpcPool.call((c) => Indexer.logs(c, a, b))));
      for (const logs of batch) for (const l of logs) Indexer.apply(l);
      s.lastBlock = ranges[Math.min(i + 3, ranges.length - 1)][1];
    }
  }

  /** Keep the sync lock until every sibling RPC settles, including when one fails early. */
  private static async all<T>(jobs: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(jobs);
    return results.map((r) => { if (r.status === "rejected") throw r.reason; return r.value; });
  }

  private static fingerprint() {
    return [Contracts.game, Contracts.market, Contracts.relic, Contracts.loom].map((a) => a.toLowerCase()).join(":");
  }

  /** Restore only checkpoints for this chain and contract set; invalid caches fall back to RPC. */
  private static async restore() {
    const s = Indexer.s;
    try {
      const c = await IndexCache.read() as Checkpoint | null;
      const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
      const asset = (v: unknown) => v === "relic" || v === "loom";
      if (!c || c.version !== 1 || c.chainId !== 56 || c.contracts !== Indexer.fingerprint()) return;
      if (![c.fromBlock, c.lastBlock, c.head].every((v) => typeof v === "string" && /^\d+$/.test(v))) return;
      const fromBlock = BigInt(c.fromBlock), lastBlock = BigInt(c.lastBlock), head = BigInt(c.head);
      if (fromBlock <= 0n || lastBlock < fromBlock - 1n || head < lastBlock || !finite(c.syncedAt) || !finite(c.feeBps)) return;
      if (!Array.isArray(c.bids) || !c.bids.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && p[1] &&
        p[0] === p[1].id && address(p[1].buyer) && asset(p[1].asset) &&
        [p[1].id, p[1].price, p[1].qty, p[1].remaining, p[1].ts].every(finite))) return;
      if (!Array.isArray(c.fills) || !c.fills.every((f) => f && asset(f.asset) && address(f.buyer) && address(f.seller) &&
        typeof f.tx === "string" && [f.price, f.ts, f.block].every(finite))) return;
      if (!c.holders || !(["relic", "loom"] as const).every((a) => Array.isArray(c.holders[a]) &&
        c.holders[a].every((p) => Array.isArray(p) && p.length === 2 && address(p[0]) && finite(p[1]) && p[1] > 0))) return;
      if (c.mint !== null && (!c.mint || typeof c.mint.requireHandle !== "boolean" ||
        ![c.mint.minted, c.mint.cap, c.mint.startTime, c.mint.perHandle, c.mint.firstUsdt, c.mint.paidUsdt,
          c.mint.firstBnb, c.mint.paidBnb, c.mint.relicSupply].every(finite))) return;
      Object.assign(s, { fromBlock, lastBlock, head, syncedAt: c.syncedAt, feeBps: c.feeBps, mint: c.mint,
        bids: new Map(c.bids), fills: c.fills, holders: { relic: new Map(c.holders.relic), loom: new Map(c.holders.loom) } });
    } catch { /* An optional cache must never prevent a fresh sync. */ }
  }

  private static async save() {
    const s = Indexer.s;
    if (s.fromBlock === 0n || s.lastBlock < s.fromBlock || (s.lastSavedAt && Date.now() - s.lastSavedAt < 15_000)) return;
    s.lastSavedAt = Date.now();
    const checkpoint: Checkpoint = {
      version: 1, chainId: 56, contracts: Indexer.fingerprint(),
      fromBlock: String(s.fromBlock), lastBlock: String(s.lastBlock), head: String(s.head), syncedAt: s.syncedAt, feeBps: s.feeBps,
      bids: [...s.bids], fills: s.fills, holders: { relic: [...s.holders.relic], loom: [...s.holders.loom] }, mint: s.mint,
    };
    await IndexCache.write(checkpoint);
  }

  /** getLogs that halves the block range when the RPC rejects a response as too large. */
  private static async logs(c: PublicClient, a: bigint, b: bigint): Promise<Log[]> {
    try {
      const logs = await c.getLogs({
        address: [Contracts.market, Contracts.relic, Contracts.loom], fromBlock: a, toBlock: b,
        events: [...Contracts.marketAbi.filter((x) => x.type === "event"), ...Contracts.erc721Abi.filter((x) => x.type === "event")],
      });
      return await Indexer.fillTimestamps(c, logs, a, b);
    } catch (e) {
      // Rate limits and transport failures must not fan out into hundreds of smaller calls.
      const message = e instanceof Error ? e.message : String(e);
      const transient = /429|too many requests|rate limit|request limit|quota|unauthorized|forbidden|timeout|timed out|fetch failed|ECONN|ENOTFOUND/i.test(message);
      const rangeLimit = /block range|range.*(?:large|wide|limit)|too many (?:results|logs)|response.*(?:size|large)|query returned more/i.test(message);
      if (b === a || transient || !rangeLimit) throw e;
      const mid = (a + b) / 2n;
      return [...(await Indexer.logs(c, a, mid)), ...(await Indexer.logs(c, mid + 1n, b))];
    }
  }

  /** Some RPC responses omit blockTimestamp; interpolate it from the range's boundary blocks. */
  private static async fillTimestamps(c: PublicClient, logs: Log[], a: bigint, b: bigint): Promise<Log[]> {
    type L = Log & { blockTimestamp?: bigint | string | null };
    if (logs.every((l) => (l as L).blockTimestamp != null)) return logs;
    const [ta, tb] = await Indexer.all([a, b].map((n) => c.getBlock({ blockNumber: n }).then((x) => Number(x.timestamp))));
    const span = Number(b - a) || 1;
    for (const l of logs as L[]) if (l.blockTimestamp == null) l.blockTimestamp = BigInt(Math.round(ta + ((tb - ta) * Number((l.blockNumber ?? a) - a)) / span));
    return logs;
  }

  /** Binary search for the market contract's creation block (needs an archive-capable RPC). */
  private static async deployBlock(head: bigint): Promise<bigint> {
    let lo = 0n, hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const code = await HistoryRpcPool.call((c) => c.getCode({ address: Contracts.market, blockNumber: mid }));
      if (code && code !== "0x") hi = mid; else lo = mid + 1n;
    }
    return lo;
  }

  private static apply(log: Log) {
    const s = Indexer.s;
    const addr = (log.address as Address).toLowerCase();
    const ts = Number((log as Log & { blockTimestamp?: bigint | string }).blockTimestamp ?? 0) * 1000;
    if (addr === Contracts.market.toLowerCase()) {
      let ev;
      try { ev = decodeEventLog({ abi: Contracts.marketAbi, data: log.data, topics: log.topics }); } catch { return; }
      const usdt = (v: bigint) => Number(formatUnits(v, 18));
      if (ev.eventName === "BidPlaced") {
        const a = ev.args;
        s.bids.set(Number(a.id), { id: Number(a.id), buyer: a.buyer.toLowerCase(), asset: a.asset === 1 ? "loom" : "relic", price: usdt(a.price), qty: a.quantity, remaining: a.quantity, ts });
      } else if (ev.eventName === "BidCancelled") {
        const b = s.bids.get(Number(ev.args.id)); if (b) b.remaining = 0;
      } else if (ev.eventName === "BidFilled") {
        const a = ev.args; const b = s.bids.get(Number(a.id)); if (b) b.remaining = Math.max(0, b.remaining - 1);
        s.fills.push({ asset: a.asset === 1 ? "loom" : "relic", price: usdt(a.price), ts, tx: log.transactionHash ?? "", buyer: a.buyer.toLowerCase(), seller: a.seller.toLowerCase(), block: Number(log.blockNumber) });
      }
      return;
    }
    const asset: Asset | null = addr === Contracts.relic.toLowerCase() ? "relic" : addr === Contracts.loom.toLowerCase() ? "loom" : null;
    if (!asset) return;
    let ev;
    try { ev = decodeEventLog({ abi: Contracts.erc721Abi, data: log.data, topics: log.topics }); } catch { return; }
    if (ev.eventName !== "Transfer") return;
    const h = s.holders[asset]; const from = ev.args.from.toLowerCase(); const to = ev.args.to.toLowerCase();
    if (from !== ZERO) { const n = (h.get(from) ?? 0) - 1; if (n > 0) h.set(from, n); else h.delete(from); }
    if (to !== ZERO) h.set(to, (h.get(to) ?? 0) + 1);
  }

  private static async readState() {
    const s = Indexer.s;
    const r = await HistoryRpcPool.call((c) => c.multicall({ allowFailure: false, contracts: [
      { address: Contracts.game, abi: Contracts.gameAbi, functionName: "publicMinted" },
      { address: Contracts.game, abi: Contracts.gameAbi, functionName: "publicCap" },
      { address: Contracts.game, abi: Contracts.gameAbi, functionName: "config" },
      { address: Contracts.game, abi: Contracts.gameAbi, functionName: "mintStartTime" },
      { address: Contracts.game, abi: Contracts.gameAbi, functionName: "requireHandle" },
      { address: Contracts.market, abi: Contracts.marketAbi, functionName: "feeBps" },
      { address: Contracts.relic, abi: Contracts.erc721Abi, functionName: "totalSupply" },
    ] }));
    const [minted, cap, cfg, start, requireHandle, feeBps, relicSupply] = r;
    const f = (v: bigint) => Number(formatUnits(v, 18));
    s.feeBps = feeBps;
    s.mint = { minted: Number(minted), cap: Number(cap), startTime: Number(start) * 1000, requireHandle, perHandle: cfg.perHandle,
      firstUsdt: f(cfg.firstPrice), paidUsdt: f(cfg.paidPrice), firstBnb: f(cfg.firstPriceBnb), paidBnb: f(cfg.paidPriceBnb), relicSupply: Number(relicSupply) };
    s.syncedAt = Date.now();
  }

  static snapshot(me?: string) {
    const s = Indexer.s;
    const now = Date.now();
    const assetView = (asset: Asset) => {
      const live = [...s.bids.values()].filter((b) => b.asset === asset && b.remaining > 0);
      const open = live.filter((b) => b.price >= Indexer.DUST_PRICE_USDT);
      const total = (b: Bid) => b.price * b.remaining;
      const big = open.filter((b) => total(b) >= Indexer.BIG_BID_USDT);
      const fills = s.fills.filter((x) => x.asset === asset);
      const win = (ms: number) => { const w = fills.filter((x) => x.ts >= now - ms); return { count: w.length, usdt: w.reduce((a, x) => a + x.price, 0) }; };
      return {
        count: open.length, dustCount: live.length - open.length,
        best: open.reduce((m, b) => Math.max(m, b.price), 0),
        escrow: open.reduce((a, b) => a + total(b), 0),
        demand: open.reduce((a, b) => a + b.remaining, 0),
        bigCount: big.length, bigEscrow: big.reduce((a, b) => a + total(b), 0),
        mine: me ? live.filter((b) => b.buyer === me).map((b) => ({ id: b.id, price: b.price, qty: b.remaining, total: total(b), ts: b.ts })) : [],
        bids: open.sort((a, b) => b.price - a.price || a.ts - b.ts).slice(0, 50).map((b) => ({ id: b.id, buyer: b.buyer, price: b.price, qty: b.remaining, total: total(b), ts: b.ts })),
        lastPrice: fills.at(-1)?.price ?? null,
        volume: { totalUsdt: fills.reduce((a, x) => a + x.price, 0), totalFills: fills.length, last1m: win(60e3), last5m: win(300e3), last15m: win(900e3) },
        fills: fills.slice(-30).reverse().map(({ price, ts, tx, buyer, seller }) => ({ price, ts, tx, buyer, seller })),
        holders: [...s.holders[asset].entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([address, count]) => ({ address, count })),
        holderCount: s.holders[asset].size,
      };
    };
    const staleAge = s.syncedAt ? now - s.syncedAt : null;
    return {
      now, block: Number(s.lastBlock), fromBlock: Number(s.fromBlock), ready: Indexer.ready,
      backfill: s.head > s.fromBlock ? Math.min(1, Number(s.lastBlock - s.fromBlock + 1n) / Number(s.head - s.fromBlock + 1n)) : 0,
      stale: !!s.lastError || staleAge === null || staleAge > 30_000, staleAge, error: s.lastError,
      rpc: RpcPool.status(), historyRpc: HistoryRpcPool.status(), feeBps: s.feeBps, mint: s.mint,
      contracts: { game: Contracts.game, relic: Contracts.relic, loom: Contracts.loom, market: Contracts.market },
      asset: { relic: assetView("relic"), loom: assetView("loom") },
    };
  }

  static klines(sec: number, asset: Asset, limit: number) {
    const buckets = new Map<number, { t: number; o: number; h: number; l: number; c: number; v: number; n: number }>();
    for (const f of Indexer.s.fills) {
      if (f.asset !== asset || f.price < Indexer.DUST_PRICE_USDT) continue;
      const t = Math.floor(f.ts / (sec * 1000)) * sec * 1000;
      const k = buckets.get(t);
      if (!k) buckets.set(t, { t, o: f.price, h: f.price, l: f.price, c: f.price, v: f.price, n: 1 });
      else { k.h = Math.max(k.h, f.price); k.l = Math.min(k.l, f.price); k.c = f.price; k.v += f.price; k.n += 1; }
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t).slice(-limit);
  }
}
