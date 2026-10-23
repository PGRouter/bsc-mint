import { decodeEventLog, formatUnits, type Address, type Log, type PublicClient } from "viem";
import { Contracts } from "./contracts";
import { HistoryRpcPool, RpcPool } from "./rpc";
import { IndexCache } from "@/lib/index-cache";
import { platformFeeRouterAddress, PLATFORM_SALE_ABI } from "@/lib/platform-fee";

export type Asset = "relic" | "loom";
type Bid = { id: number; buyer: string; asset: Asset; price: number; qty: number; remaining: number; ts: number };
type Fill = {
  asset: Asset; price: number; ts: number; tx: string; buyer: string; seller: string; block: number;
  bidId?: string; tokenId?: string; logIndex?: number; marketSeller?: string;
  platformFee?: number; marketFee?: number; proceeds?: number;
};
type PlatformCoverage = { fingerprint: string; through: bigint };
type PlatformConfig = { address: Address; start: bigint; fingerprint: string };
type Mint = { minted: number; cap: number; startTime: number; requireHandle: boolean; perHandle: number; firstUsdt: number; paidUsdt: number; firstBnb: number; paidBnb: number; relicSupply: number };
type State = {
  fromBlock: bigint; lastBlock: bigint; bids: Map<number, Bid>; fills: Fill[];
  holders: Record<Asset, Map<string, number>>; mint: Mint | null; feeBps: number;
  syncedAt: number; lastError: string | null; syncing: Promise<void> | null; lastAttempt: number; head: bigint;
  restored?: boolean; preparing?: Promise<void> | null; lastSavedAt?: number;
  platform?: PlatformCoverage;
};
type Checkpoint = {
  version: number; chainId: number; contracts: string;
  fromBlock: string; lastBlock: string; head: string; syncedAt: number; feeBps: number;
  bids: [number, Bid][]; fills: Fill[]; holders: Record<Asset, [string, number][]>; mint: Mint | null;
  platform?: { fingerprint: string; through: string };
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
    const platform = Indexer.platformConfig();
    if (platform) {
      if (s.platform?.fingerprint !== platform.fingerprint) s.platform = { fingerprint: platform.fingerprint, through: platform.start - 1n };
      // Existing checkpoints already contain every bid/transfer. Replay only sale metadata,
      // bounded by the normal sync budget, and persist progress without rewinding the book.
      while (s.platform.through < s.lastBlock && Date.now() - t0 < Indexer.BUDGET_MS) {
        const ranges: [bigint, bigint][] = [];
        for (let a = s.platform.through + 1n; a <= s.lastBlock && ranges.length < 4; a += Indexer.CHUNK) {
          ranges.push([a, a + Indexer.CHUNK - 1n > s.lastBlock ? s.lastBlock : a + Indexer.CHUNK - 1n]);
        }
        const batch = await Indexer.all(ranges.map(([a, b]) => HistoryRpcPool.call((c) => Indexer.logs(c, a, b))));
        Indexer.applyBatch(batch.flat(), true);
        s.platform.through = ranges.at(-1)![1];
      }
      if (s.platform.through < s.lastBlock) return;
    }
    const ranges: [bigint, bigint][] = [];
    for (let a = s.lastBlock + 1n; a <= head; a += Indexer.CHUNK) ranges.push([a, a + Indexer.CHUNK - 1n > head ? head : a + Indexer.CHUNK - 1n]);
    for (let i = 0; i < ranges.length && Date.now() - t0 < Indexer.BUDGET_MS; i += 4) {
      const batch = await Indexer.all(ranges.slice(i, i + 4).map(([a, b]) =>
        HistoryRpcPool.call((c) => Indexer.logs(c, a, b))));
      Indexer.applyBatch(batch.flat());
      s.lastBlock = ranges[Math.min(i + 3, ranges.length - 1)][1];
      if (platform && s.platform) s.platform.through = s.lastBlock > platform.start - 1n ? s.lastBlock : platform.start - 1n;
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

  private static platformConfig(): PlatformConfig | undefined {
    const address = platformFeeRouterAddress();
    const raw = typeof process === "undefined" ? undefined : process.env.NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK;
    if (!address || !raw || !/^[1-9]\d*$/.test(raw)) return;
    const start = BigInt(raw);
    return { address, start, fingerprint: `${address.toLowerCase()}:${start}` };
  }

  /** Restore only checkpoints for this chain and contract set; invalid caches fall back to RPC. */
  private static async restore() {
    const s = Indexer.s;
    try {
      const c = await IndexCache.read() as Checkpoint | null;
      const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
      const asset = (v: unknown) => v === "relic" || v === "loom";
      if (!c || ![1, 2].includes(c.version) || c.chainId !== 56 || c.contracts !== Indexer.fingerprint()) return;
      if (![c.fromBlock, c.lastBlock, c.head].every((v) => typeof v === "string" && /^\d+$/.test(v))) return;
      const fromBlock = BigInt(c.fromBlock), lastBlock = BigInt(c.lastBlock), head = BigInt(c.head);
      if (fromBlock <= 0n || lastBlock < fromBlock - 1n || head < lastBlock || !finite(c.syncedAt) || !finite(c.feeBps)) return;
      if (!Array.isArray(c.bids) || !c.bids.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && p[1] &&
        p[0] === p[1].id && address(p[1].buyer) && asset(p[1].asset) &&
        [p[1].id, p[1].price, p[1].qty, p[1].remaining, p[1].ts].every(finite))) return;
      if (!Array.isArray(c.fills) || !c.fills.every((f) => f && asset(f.asset) && address(f.buyer) && address(f.seller) &&
        typeof f.tx === "string" && [f.price, f.ts, f.block].every(finite) &&
        [f.bidId, f.tokenId].every((v) => v === undefined || (typeof v === "string" && /^\d+$/.test(v))) &&
        [f.platformFee, f.marketFee, f.proceeds, f.logIndex].every((v) => v === undefined || (finite(v) && v >= 0)) &&
        (f.marketSeller === undefined || address(f.marketSeller)))) return;
      if (!c.holders || !(["relic", "loom"] as const).every((a) => Array.isArray(c.holders[a]) &&
        c.holders[a].every((p) => Array.isArray(p) && p.length === 2 && address(p[0]) && finite(p[1]) && p[1] > 0))) return;
      if (c.mint !== null && (!c.mint || typeof c.mint.requireHandle !== "boolean" ||
        ![c.mint.minted, c.mint.cap, c.mint.startTime, c.mint.perHandle, c.mint.firstUsdt, c.mint.paidUsdt,
          c.mint.firstBnb, c.mint.paidBnb, c.mint.relicSupply].every(finite))) return;
      Object.assign(s, { fromBlock, lastBlock, head, syncedAt: c.syncedAt, feeBps: c.feeBps, mint: c.mint,
        bids: new Map(c.bids), fills: c.fills, holders: { relic: new Map(c.holders.relic), loom: new Map(c.holders.loom) } });
      const platform = Indexer.platformConfig();
      if (platform) {
        const through = c.version === 2 && c.platform?.fingerprint === platform.fingerprint && /^\d+$/.test(c.platform.through)
          ? BigInt(c.platform.through) : platform.start - 1n;
        s.platform = { fingerprint: platform.fingerprint,
          through: through >= platform.start - 1n && through <= (lastBlock > platform.start - 1n ? lastBlock : platform.start - 1n) ? through : platform.start - 1n };
      }
    } catch { /* An optional cache must never prevent a fresh sync. */ }
  }

  private static async save() {
    const s = Indexer.s;
    if (s.fromBlock === 0n || s.lastBlock < s.fromBlock || (s.lastSavedAt && Date.now() - s.lastSavedAt < 15_000)) return;
    s.lastSavedAt = Date.now();
    const checkpoint: Checkpoint = {
      version: 2, chainId: 56, contracts: Indexer.fingerprint(),
      fromBlock: String(s.fromBlock), lastBlock: String(s.lastBlock), head: String(s.head), syncedAt: s.syncedAt, feeBps: s.feeBps,
      bids: [...s.bids], fills: s.fills, holders: { relic: [...s.holders.relic], loom: [...s.holders.loom] }, mint: s.mint,
      ...(s.platform ? { platform: { fingerprint: s.platform.fingerprint, through: String(s.platform.through) } } : {}),
    };
    await IndexCache.write(checkpoint);
  }

  /** getLogs that halves the block range when the RPC rejects a response as too large. */
  private static async logs(c: PublicClient, a: bigint, b: bigint): Promise<Log[]> {
    try {
      const platform = Indexer.platformConfig();
      const includePlatform = platform && b >= platform.start;
      const logs = await c.getLogs({
        address: [Contracts.market, Contracts.relic, Contracts.loom, ...(includePlatform ? [platform.address] : [])], fromBlock: a, toBlock: b,
        events: [...Contracts.marketAbi.filter((x) => x.type === "event"), ...Contracts.erc721Abi.filter((x) => x.type === "event"), ...(includePlatform ? PLATFORM_SALE_ABI : [])],
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

  /** Join within a complete log batch, so provider log ordering cannot hide a sale. */
  private static applyBatch(logs: Log[], repair = false) {
    const s = Indexer.s;
    const platform = Indexer.platformConfig();
    const ordered = [...logs].sort((a, b) => {
      const block = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
      return block < 0n ? -1 : block > 0n ? 1 : (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });
    if (!platform) { if (!repair) for (const l of ordered) Indexer.apply(l); return; }
    const router = platform.address.toLowerCase();
    type Sale = { seller: string; marketFee: bigint; platformFee: bigint; proceeds: bigint };
    const sales = new Map<string, Sale[]>();
    const key = (l: Log, id: bigint, tokenId: bigint, asset: number, buyer: string, gross: bigint, fee: bigint) =>
      [l.transactionHash?.toLowerCase(), l.blockNumber, id, tokenId, asset, buyer.toLowerCase(), gross, fee].join(":");
    for (const l of ordered) {
      if (l.address.toLowerCase() !== router || !l.transactionHash || (l.blockNumber ?? 0n) < platform.start) continue;
      try {
        const ev = decodeEventLog({ abi: PLATFORM_SALE_ABI, data: l.data, topics: l.topics });
        if (ev.eventName !== "PlatformSale") continue;
        const a = ev.args;
        if ((a.asset !== 0 && a.asset !== 1) || a.seller.toLowerCase() === ZERO || a.seller.toLowerCase() === router ||
          a.seller.toLowerCase() === a.buyer.toLowerCase() || a.platformFee !== a.gross * 50n / 10_000n ||
          a.marketFee + a.platformFee + a.proceeds !== a.gross) continue;
        const k = key(l, a.bidId, a.tokenId, a.asset, a.buyer, a.gross, a.marketFee);
        const matches = sales.get(k) ?? [];
        matches.push({ seller: a.seller.toLowerCase(), marketFee: a.marketFee, platformFee: a.platformFee, proceeds: a.proceeds });
        sales.set(k, matches);
      } catch { /* Malformed or unrelated logs cannot enrich a market fill. */ }
    }
    // Legacy fills lack bid/NFT identity. Match occurrences in market log order inside
    // each transaction, then store the exact identity for future cache migrations.
    const legacy = new Map<string, Fill[]>();
    if (repair) for (const f of s.fills) {
      if ((f.marketSeller ?? f.seller) !== router) continue;
      const k = `${f.tx.toLowerCase()}:${f.block}`;
      const matches = legacy.get(k) ?? []; matches.push(f); legacy.set(k, matches);
    }
    const used = new Set<Fill>();
    for (const l of ordered) {
      const before = s.fills.length;
      if (!repair) Indexer.apply(l);
      if (l.address.toLowerCase() !== Contracts.market.toLowerCase() || !l.transactionHash || (l.blockNumber ?? 0n) < platform.start) continue;
      try {
        const ev = decodeEventLog({ abi: Contracts.marketAbi, data: l.data, topics: l.topics });
        if (ev.eventName !== "BidFilled" || ev.args.seller.toLowerCase() !== router) continue;
        const a = ev.args;
        const candidates = legacy.get(`${l.transactionHash.toLowerCase()}:${l.blockNumber}`);
        const f = repair ? candidates?.find((f) => !used.has(f) && f.asset === (a.asset === 1 ? "loom" : "relic") &&
          f.buyer === a.buyer.toLowerCase() && f.price === Number(formatUnits(a.price, 18)) &&
          (f.bidId === undefined || f.bidId === String(a.id)) && (f.tokenId === undefined || f.tokenId === String(a.tokenId)) &&
          (f.logIndex === undefined || l.logIndex == null || f.logIndex === l.logIndex)) : s.fills.length > before ? s.fills.at(-1) : undefined;
        if (!f) continue;
        used.add(f);
        f.bidId = String(a.id); f.tokenId = String(a.tokenId);
        if (l.logIndex != null) f.logIndex = l.logIndex;
        const sale = sales.get(key(l, a.id, a.tokenId, a.asset, a.buyer, a.price, a.fee))?.shift();
        if (!sale) continue;
        Object.assign(f, { seller: sale.seller, marketSeller: router,
          marketFee: Number(formatUnits(sale.marketFee, 18)), platformFee: Number(formatUnits(sale.platformFee, 18)), proceeds: Number(formatUnits(sale.proceeds, 18)) });
      } catch { /* Leave the original fill untouched if it cannot be paired exactly. */ }
    }
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
        s.fills.push({ asset: a.asset === 1 ? "loom" : "relic", price: usdt(a.price), ts, tx: log.transactionHash ?? "", buyer: a.buyer.toLowerCase(), seller: a.seller.toLowerCase(), block: Number(log.blockNumber),
          bidId: String(a.id), tokenId: String(a.tokenId), ...(log.logIndex == null ? {} : { logIndex: log.logIndex }) });
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
        fills: fills.slice(-30).reverse().map(({ price, ts, tx, buyer, seller, platformFee, marketFee, proceeds }) =>
          ({ price, ts, tx, buyer, seller, ...(platformFee === undefined ? {} : { platformFee, marketFee, proceeds }) })),
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
