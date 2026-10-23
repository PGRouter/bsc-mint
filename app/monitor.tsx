"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TopBar } from "@/components/shell";
import { Fmt } from "@/lib/fmt";
import { KLine } from "@/components/kline";

type Lang = "zh" | "en";
type Asset = "relic" | "loom";
type Bid = { id: number; buyer: string; price: number; qty: number; total: number; ts: number };
type Fill = { price: number; ts: number; tx: string; buyer: string; seller: string };
type AssetView = { count: number; best: number; escrow: number; demand: number; bigCount: number; bigEscrow: number; bids: Bid[]; lastPrice: number | null;
  volume: { totalUsdt: number; totalFills: number; last1m: { count: number; usdt: number }; last5m: { count: number; usdt: number }; last15m: { count: number; usdt: number } };
  fills: Fill[]; holders: { address: string; count: number }[]; holderCount: number };
type Snapshot = { now: number; block: number; ready: boolean; backfill: number; stale: boolean; staleAge: number | null; error: string | null; feeBps: number;
  rpc: { label: string; ms: number; fails: number; cooldown: boolean }[];
  mint: { minted: number; cap: number; startTime: number; requireHandle: boolean; perHandle: number; firstUsdt: number; paidUsdt: number; firstBnb: number; paidBnb: number; relicSupply: number } | null;
  contracts: Record<string, string>; asset: Record<Asset, AssetView> };

const DICT = {
  zh: { title: "BSC 铸造监控", sub: "只读 · 链上数据 · BSC", block: "区块", activeBids: "活跃买单", escrow: "买盘锁定 USDT", best: "盘口顶价", big: "大额收购 ≥50 USDT", minted: "已公开铸造", mintPrice: "铸造价 BNB",
    demand: "需求数量", last: "最新成交", chart: "K 线", book: "买单簿", fills: "成交 (BidFilled)", holders: "持仓 TOP", price: "价格", qty: "数量", total: "总额", buyer: "买家", seller: "卖家", time: "时间", addr: "地址", count: "数量",
    stale: "数据延迟：RPC 暂时不可用，正在自动切换节点，显示的是最近一次成功的数据。", loading: "正在从链上同步数据…", vol: "成交量", first: "首次", paid: "后续", handle: "需要 Agent 身份 (handle)", yes: "是", no: "否", contract: "合约", fee: "手续费" },
  en: { title: "Mint monitor", sub: "Read-only · on-chain · BSC", block: "Block", activeBids: "Active bids", escrow: "Bid escrow USDT", best: "Top bid", big: "Big bids ≥50 USDT", minted: "Public minted", mintPrice: "Mint price BNB",
    demand: "Demand qty", last: "Last fill", chart: "Candles", book: "Bid book", fills: "Fills (BidFilled)", holders: "Top holders", price: "Price", qty: "Qty", total: "Total", buyer: "Buyer", seller: "Seller", time: "Time", addr: "Address", count: "Count",
    stale: "Data delayed: RPC temporarily unavailable, failing over. Showing the last good data.", loading: "Syncing from chain…", vol: "Volume", first: "first", paid: "after", handle: "Agent handle required", yes: "yes", no: "no", contract: "Contract", fee: "Fee" },
} as const;

const SK = <span className="sk" />;
const EMPTY = (cols: number) => <tr><td className="empty" colSpan={cols}>—</td></tr>;

export default function Monitor() {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  const [asset, setAsset] = useState<Asset>(params.get("asset") === "loom" ? "loom" : "relic");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [netErr, setNetErr] = useState(false);
  const t = DICT[lang];

  const load = useCallback(async () => {
    try {
      const s = (await (await fetch("/api/snapshot", { cache: "no-store" })).json()) as Snapshot;
      setSnap(s); setNetErr(false);
    } catch { setNetErr(true); }
  }, []);

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
      <TopBar lang={lang} setLang={setLang} active="/" status={<>
        <span className={`dot ${snap?.stale || netErr ? "err" : ""}`} role="img" aria-label={snap?.stale || netErr ? "delayed" : "live"} />
        <span>{t.block} <b>{snap?.block ? snap.block.toLocaleString() : "-"}</b></span>
        <span className="hide-sm">{rpc ? `${rpc.label} ${rpc.ms}ms` : "rpc -"}</span>
      </>} />
      <main>
      <div className="page-head">
        <div><h1>{t.title}</h1><p className="muted">{t.sub}</p></div>
        <div className="tabs" role="group" aria-label="Asset">
          <button aria-pressed={asset === "relic"} className={`btn ${asset === "relic" ? "on" : ""}`} onClick={() => setAsset("relic")}>RELICS</button>
          <button aria-pressed={asset === "loom"} className={`btn ${asset === "loom" ? "on" : ""}`} onClick={() => setAsset("loom")}>LOOMS</button>
        </div>
      </div>
      {(snap?.stale && snap.ready) || netErr ? <div className="banner error" role="alert" data-testid="stale-banner">{t.stale}{snap?.staleAge ? ` (${Math.round(snap.staleAge / 1000)}s)` : ""}</div> : null}
      {snap?.ready && snap.backfill < 1 ? <div className="banner" role="status" data-testid="backfill"><span className="spin" aria-hidden /> {t.loading} <b className="num">{Fmt.pct(snap.backfill)}</b>
        <span className="progress" role="progressbar" aria-valuenow={Math.floor(snap.backfill * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: Fmt.pct(snap.backfill) }} /></span></div> : null}
      {!snap?.ready ? <div className="banner" role="status"><span className="spin" aria-hidden /> {t.loading}{snap?.error ? ` — ${snap.error}` : ""}</div> : null}
      <div className="stack" />
      <div className="cards">
        <div className="card"><div className="k">{t.activeBids}</div><div className="v">{a ? Fmt.n(a.count, 0) : SK}</div><div className="s">{t.demand} {a ? Fmt.n(a.demand, 0) : "-"}</div></div>
        <div className="card"><div className="k">{t.escrow}</div><div className="v">{a ? Fmt.n(a.escrow) : SK}</div><div className="s">{t.fee} {snap ? snap.feeBps / 100 : "-"}%</div></div>
        <div className="card"><div className="k">{t.best}</div><div className="v up">{a ? Fmt.n(a.best, 4) : SK}<small>USDT</small></div><div className="s">{t.last} {a?.lastPrice != null ? Fmt.n(a.lastPrice, 4) : "-"}</div></div>
        <div className="card"><div className="k">{t.big}</div><div className="v">{a ? Fmt.n(a.bigCount, 0) : SK}</div><div className="s">{a ? Fmt.n(a.bigEscrow) : "-"} USDT</div></div>
        <div className="card"><div className="k">{t.minted}</div><div className="v">{m ? Fmt.n(m.minted, 0) : SK}<small>/ {m ? Fmt.n(m.cap, 0) : "-"}</small></div><div className="s">{t.handle}: {m ? (m.requireHandle ? t.yes : t.no) : "-"}</div>{m ? <div className="progress" aria-hidden><i style={{ width: Fmt.pct(m.minted / m.cap) }} /></div> : null}</div>
        <div className="card"><div className="k">{t.mintPrice}</div><div className="v">{m ? Fmt.n(m.paidBnb, 4) : SK}<small>BNB</small></div><div className="s">{t.first} {m?.firstBnb ?? "-"} · {t.paid} {m?.paidBnb ?? "-"} BNB</div></div>
      </div>
      <KLine key={asset} asset={asset} lang={lang} title={t.chart} />
      {a ? <p className="muted" style={{ margin: "-4px 2px 0", fontSize: 12 }}>{t.vol} 1m {Fmt.n(a.volume.last1m.usdt)} · 5m {Fmt.n(a.volume.last5m.usdt)} · 15m {Fmt.n(a.volume.last15m.usdt)} · total {Fmt.n(a.volume.totalUsdt, 0)} USDT / {a.volume.totalFills}</p> : null}
      <div className="grid2">
        <div className="panel"><h3>{t.book}</h3><div className="scroll"><table><thead><tr><th>{t.price}</th><th>{t.qty}</th><th>{t.total}</th><th>{t.buyer}</th><th>{t.time}</th></tr></thead>
          <tbody>{a && !a.bids.length ? EMPTY(5) : null}{a?.bids.map((b) => <tr key={b.id}><td className="up">{Fmt.n(b.price, 4)}</td><td>{Fmt.n(b.qty, 0)}</td><td>{Fmt.n(b.total)}</td><td><a href={`https://bscscan.com/address/${b.buyer}`} target="_blank" rel="noreferrer">{Fmt.addr(b.buyer)}</a></td><td>{Fmt.time(b.ts)}</td></tr>)}</tbody></table></div></div>
        <div className="panel"><h3>{t.fills}</h3><div className="scroll"><table><thead><tr><th>{t.time}</th><th>{t.price}</th><th>{t.buyer}</th><th>{t.seller}</th><th>tx</th></tr></thead>
          <tbody>{a && !a.fills.length ? EMPTY(5) : null}{a?.fills.map((f) => <tr key={f.tx + f.ts + f.seller}><td>{Fmt.time(f.ts)}</td><td>{Fmt.n(f.price, 4)}</td><td>{Fmt.addr(f.buyer)}</td><td>{Fmt.addr(f.seller)}</td><td><a href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 10)}</a></td></tr>)}</tbody></table></div></div>
      </div>
      <div className="panel stack"><h3>{t.holders} 100 <span className="muted">({a?.holderCount ?? "-"})</span></h3><div className="scroll"><table><thead><tr><th>#</th><th>{t.addr}</th><th>{t.count}</th></tr></thead>
        <tbody>{a && !a.holders.length ? EMPTY(3) : null}{a?.holders.map((h, i) => <tr key={h.address}><td>{i + 1}</td><td><a href={`https://bscscan.com/address/${h.address}`} target="_blank" rel="noreferrer">{h.address}</a></td><td>{h.count}</td></tr>)}</tbody></table></div></div>
      <footer className="muted">{t.contract}: {snap ? Object.entries(snap.contracts).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}>{k} <a className="mono" href={`https://bscscan.com/address/${v}`} target="_blank" rel="noreferrer">{Fmt.addr(v)}</a></span>) : "-"}</footer>
      </main>
    </div>
  );
}
