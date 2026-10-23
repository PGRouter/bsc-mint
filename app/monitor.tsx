"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type Lang = "zh" | "en";
type Asset = "relic" | "loom";
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; n: number };
type Bid = { id: number; buyer: string; price: number; qty: number; total: number; ts: number };
type Fill = { price: number; ts: number; tx: string; buyer: string; seller: string };
type AssetView = { count: number; best: number; escrow: number; demand: number; bigCount: number; bigEscrow: number; bids: Bid[]; lastPrice: number | null;
  volume: { totalUsdt: number; totalFills: number; last1m: { count: number; usdt: number }; last5m: { count: number; usdt: number }; last15m: { count: number; usdt: number } };
  fills: Fill[]; holders: { address: string; count: number }[]; holderCount: number };
type Snapshot = { now: number; block: number; ready: boolean; stale: boolean; staleAge: number | null; error: string | null; feeBps: number;
  rpc: { label: string; ms: number; fails: number; cooldown: boolean }[];
  mint: { minted: number; cap: number; startTime: number; requireHandle: boolean; perHandle: number; firstUsdt: number; paidUsdt: number; firstBnb: number; paidBnb: number; relicSupply: number } | null;
  contracts: Record<string, string>; asset: Record<Asset, AssetView> };

const DICT = {
  zh: { title: "BSC 铸造监控", sub: "只读 · 链上数据 · BSC", block: "区块", activeBids: "活跃买单", escrow: "买盘锁定 USDT", best: "盘口顶价", big: "大额收购 ≥50 USDT", minted: "已公开铸造", mintPrice: "铸造价 BNB",
    demand: "需求数量", last: "最新成交", chart: "K 线", book: "买单簿", fills: "成交 (BidFilled)", holders: "持仓 TOP", price: "价格", qty: "数量", total: "总额", buyer: "买家", seller: "卖家", time: "时间", addr: "地址", count: "数量",
    stale: "数据延迟：RPC 暂时不可用，正在自动切换节点，显示的是最近一次成功的数据。", loading: "正在从链上同步数据…", vol: "成交量", first: "首次", paid: "后续", handle: "需要 Agent 身份 (handle)", yes: "是", no: "否", contract: "合约", fee: "手续费" },
  en: { title: "BSC Mint Monitor", sub: "Read-only · on-chain · BSC", block: "Block", activeBids: "Active bids", escrow: "Bid escrow USDT", best: "Top bid", big: "Big bids ≥50 USDT", minted: "Public minted", mintPrice: "Mint price BNB",
    demand: "Demand qty", last: "Last fill", chart: "Candles", book: "Bid book", fills: "Fills (BidFilled)", holders: "Top holders", price: "Price", qty: "Qty", total: "Total", buyer: "Buyer", seller: "Seller", time: "Time", addr: "Address", count: "Count",
    stale: "Data delayed: RPC temporarily unavailable, failing over. Showing the last good data.", loading: "Syncing from chain…", vol: "Volume", first: "first", paid: "after", handle: "Agent handle required", yes: "yes", no: "no", contract: "Contract", fee: "Fee" },
} as const;

const PERIODS = [30, 60, 300, 900, 3600];

class Fmt {
  static n(v: number, d = 2) { return v.toLocaleString("en-US", { maximumFractionDigits: d }); }
  static addr(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
  static time(ts: number) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour12: false }) : "-"; }
  static period(s: number) { return s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`; }
}

function Chart({ candles }: { candles: Candle[] }) {
  if (!candles.length) return <div className="muted" style={{ height: 220 }}>—</div>;
  const W = 1100, H = 220, P = 8;
  const hi = Math.max(...candles.map((c) => c.h)), lo = Math.min(...candles.map((c) => c.l));
  const y = (v: number) => P + (hi === lo ? 0.5 : (hi - v) / (hi - lo)) * (H - 2 * P);
  const step = W / Math.max(candles.length, 40);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      {candles.map((c, i) => {
        const x = i * step + step / 2, col = c.c >= c.o ? "var(--green)" : "var(--red)";
        return <g key={c.t}><line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} />
          <rect x={x - step * 0.35} width={step * 0.7} y={Math.min(y(c.o), y(c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={col} /></g>;
      })}
      <text x={W - 4} y={14} textAnchor="end" fill="var(--muted)" fontSize="12">{Fmt.n(hi)}</text>
      <text x={W - 4} y={H - 4} textAnchor="end" fill="var(--muted)" fontSize="12">{Fmt.n(lo)}</text>
    </svg>
  );
}

export default function Monitor() {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  const [asset, setAsset] = useState<Asset>(params.get("asset") === "loom" ? "loom" : "relic");
  const [sec, setSec] = useState(60);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [netErr, setNetErr] = useState(false);
  const t = DICT[lang];

  const load = useCallback(async () => {
    try {
      const [s, k] = await Promise.all([
        fetch("/api/snapshot", { cache: "no-store" }).then((r) => r.json() as Promise<Snapshot>),
        fetch(`/api/klines?sec=${sec}&asset=${asset}&limit=120`, { cache: "no-store" }).then((r) => r.json() as Promise<{ candles: Candle[] }>),
      ]);
      setSnap(s); setCandles(k.candles ?? []); setNetErr(false);
    } catch { setNetErr(true); }
  }, [sec, asset]);

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);
  useEffect(() => {
    const u = new URL(window.location.href); u.searchParams.set("lang", lang); u.searchParams.set("asset", asset);
    window.history.replaceState(null, "", u);
  }, [lang, asset]);

  const a = snap?.asset[asset];
  const m = snap?.mint;
  const rpc = snap?.rpc.find((r) => !r.cooldown);
  return (
    <div className="wrap">
      <header>
        <div><div className="title">{t.title}</div><div className="muted">{t.sub}</div></div>
        <button className={`btn ${asset === "relic" ? "on" : ""}`} onClick={() => setAsset("relic")}>RELICS</button>
        <button className={`btn ${asset === "loom" ? "on" : ""}`} onClick={() => setAsset("loom")}>LOOMS</button>
        <div className="status">
          <span className={`dot ${snap?.stale || netErr ? "err" : ""}`} />
          <span>{t.block} <b>{snap?.block ? snap.block.toLocaleString() : "-"}</b></span>
          <span>{rpc ? `${rpc.label} ${rpc.ms}ms` : "rpc -"}</span>
          <button className="btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "EN" : "中文"}</button>
        </div>
      </header>
      {(snap?.stale && snap.ready) || netErr ? <div className="banner" data-testid="stale-banner">{t.stale}{snap?.staleAge ? ` (${Math.round(snap.staleAge / 1000)}s)` : ""}</div> : null}
      {!snap?.ready ? <div className="banner">{t.loading}{snap?.error ? ` — ${snap.error}` : ""}</div> : null}
      <div className="cards">
        <div className="card"><div className="k">{t.activeBids}</div><div className="v">{a ? a.count : "-"}</div><div className="s">{t.demand} {a ? Fmt.n(a.demand, 0) : "-"}</div></div>
        <div className="card"><div className="k">{t.escrow}</div><div className="v">{a ? Fmt.n(a.escrow) : "-"}</div><div className="s">{t.fee} {snap ? snap.feeBps / 100 : "-"}%</div></div>
        <div className="card"><div className="k">{t.best}</div><div className="v up">{a ? Fmt.n(a.best) : "-"}</div><div className="s">{t.last} {a?.lastPrice ?? "-"}</div></div>
        <div className="card"><div className="k">{t.big}</div><div className="v">{a ? a.bigCount : "-"}</div><div className="s">{a ? Fmt.n(a.bigEscrow) : "-"} USDT</div></div>
        <div className="card"><div className="k">{t.minted}</div><div className="v">{m ? `${Fmt.n(m.minted, 0)} / ${Fmt.n(m.cap, 0)}` : "-"}</div><div className="s">{t.handle}: {m ? (m.requireHandle ? t.yes : t.no) : "-"}</div></div>
        <div className="card"><div className="k">{t.mintPrice}</div><div className="v">{m ? m.firstBnb : "-"}</div><div className="s">{t.first} {m?.firstBnb ?? "-"} · {t.paid} {m?.paidBnb ?? "-"} BNB</div></div>
      </div>
      <div className="panel" style={{ marginTop: 10 }}>
        <h3>{t.chart} {PERIODS.map((p) => <button key={p} className={`btn ${p === sec ? "on" : ""}`} onClick={() => setSec(p)}>{Fmt.period(p)}</button>)}
          <span className="muted" style={{ marginLeft: "auto" }}>{t.vol} 1m {a ? Fmt.n(a.volume.last1m.usdt) : "-"} · 5m {a ? Fmt.n(a.volume.last5m.usdt) : "-"} · 15m {a ? Fmt.n(a.volume.last15m.usdt) : "-"} · total {a ? Fmt.n(a.volume.totalUsdt, 0) : "-"} USDT / {a?.volume.totalFills ?? "-"}</span></h3>
        <Chart candles={candles} />
      </div>
      <div className="grid2">
        <div className="panel"><h3>{t.book}</h3><div className="scroll"><table><thead><tr><th>{t.price}</th><th>{t.qty}</th><th>{t.total}</th><th>{t.buyer}</th><th>{t.time}</th></tr></thead>
          <tbody>{a?.bids.map((b) => <tr key={b.id}><td className="up">{b.price}</td><td>{b.qty}</td><td>{Fmt.n(b.total)}</td><td><a href={`https://bscscan.com/address/${b.buyer}`} target="_blank" rel="noreferrer">{Fmt.addr(b.buyer)}</a></td><td>{Fmt.time(b.ts)}</td></tr>)}</tbody></table></div></div>
        <div className="panel"><h3>{t.fills}</h3><div className="scroll"><table><thead><tr><th>{t.time}</th><th>{t.price}</th><th>{t.buyer}</th><th>{t.seller}</th><th>tx</th></tr></thead>
          <tbody>{a?.fills.map((f) => <tr key={f.tx + f.ts + f.seller}><td>{Fmt.time(f.ts)}</td><td>{f.price}</td><td>{Fmt.addr(f.buyer)}</td><td>{Fmt.addr(f.seller)}</td><td><a href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 10)}</a></td></tr>)}</tbody></table></div></div>
      </div>
      <div className="panel" style={{ marginTop: 10 }}><h3>{t.holders} 100 <span className="muted">({a?.holderCount ?? "-"})</span></h3><div className="scroll"><table><thead><tr><th>#</th><th>{t.addr}</th><th>{t.count}</th></tr></thead>
        <tbody>{a?.holders.map((h, i) => <tr key={h.address}><td>{i + 1}</td><td><a href={`https://bscscan.com/address/${h.address}`} target="_blank" rel="noreferrer">{h.address}</a></td><td>{h.count}</td></tr>)}</tbody></table></div></div>
      <p className="muted">{t.contract}: {snap ? Object.entries(snap.contracts).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}>{k} <a className="mono" href={`https://bscscan.com/address/${v}`} target="_blank" rel="noreferrer">{Fmt.addr(v)}</a></span>) : "-"}</p>
    </div>
  );
}
