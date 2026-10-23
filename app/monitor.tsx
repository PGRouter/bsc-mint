"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TopBar } from "@/components/shell";
import { Fmt } from "@/lib/fmt";
import { KLine } from "@/components/kline";
import { TableState } from "@/components/ui";
import { Icon } from "@/components/icons";

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
  zh: { title: "市场监控", activeBids: "活跃买单", escrow: "买盘锁定", best: "最高买价", big: "大额买单", minted: "已公开铸造", mintPrice: "后续铸造价",
    demand: "需求数量", last: "最新成交", chart: "价格走势", book: "买单簿", fills: "最近成交", holders: "持仓排行", price: "价格", qty: "数量", total: "总额", buyer: "买家", seller: "卖家", time: "时间", addr: "地址", count: "数量",
    stale: "数据延迟：暂时无法连接链上节点，正在自动重试。当前显示最近一次成功的数据。", vol: "成交量", first: "首次", paid: "后续", handle: "需要 Agent 身份", yes: "是", no: "否", contract: "合约信息", fee: "手续费", network: "BNB Smart Chain", readOnly: "只读市场", threshold: "单笔 ≥ 50 USDT", allTime: "累计", transaction: "交易", top: "前 100 名", holdersTotal: "持仓地址" },
  en: { title: "Market monitor", activeBids: "Active bids", escrow: "Bid escrow", best: "Top bid", big: "Large bids", minted: "Public minted", mintPrice: "Subsequent mint price",
    demand: "Demand", last: "Last fill", chart: "Price chart", book: "Bid book", fills: "Recent trades", holders: "Top holders", price: "Price", qty: "Qty", total: "Total", buyer: "Buyer", seller: "Seller", time: "Time", addr: "Address", count: "Count",
    stale: "Data delayed: the chain connection is unavailable. Retrying automatically and showing the last successful data.", vol: "Volume", first: "First", paid: "Subsequent", handle: "Agent handle required", yes: "Yes", no: "No", contract: "Contracts", fee: "Fee", network: "BNB Smart Chain", readOnly: "Read-only market", threshold: "Per bid ≥ 50 USDT", allTime: "Total", transaction: "Transaction", top: "Top 100", holdersTotal: "Holder addresses" },
} as const;

const SK = <span className="sk" />;

export default function Monitor() {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  const [asset, setAsset] = useState<Asset>(params.get("asset") === "loom" ? "loom" : "relic");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [netErr, setNetErr] = useState(false);
  const request = useRef<{ active: boolean; controller?: AbortController }>({ active: true });
  const t = DICT[lang];

  const load = useCallback(async () => {
    if (!request.current.active || request.current.controller || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const controller = new AbortController();
    request.current.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Snapshot unavailable");
      const s = (await response.json()) as Snapshot;
      if (!request.current.active || request.current.controller !== controller || controller.signal.aborted) return;
      setSnap(s); setNetErr(false);
    } catch {
      if (request.current.active && request.current.controller === controller) setNetErr(true);
    } finally {
      clearTimeout(timeout);
      if (request.current.controller === controller) request.current.controller = undefined;
    }
  }, []);

  useEffect(() => {
    const context = request.current;
    context.active = true;
    load();
    const id = setInterval(load, 5000);
    return () => {
      clearInterval(id);
      context.active = false;
      context.controller?.abort();
      context.controller = undefined;
    };
  }, [load]);
  useEffect(() => {
    const u = new URL(window.location.href); u.searchParams.set("lang", lang); u.searchParams.set("asset", asset);
    window.history.replaceState(null, "", u);
  }, [lang, asset]);

  const a = snap?.asset[asset];
  const m = snap?.mint;
  return (
    <div className="wrap monitor-page">
      <TopBar lang={lang} setLang={setLang} active="/" showNetwork={false} />
      <main id="main-content">
      <div className="page-head monitor-head">
        <div className="monitor-heading">
          <div className="eyebrow"><Icon name="activity" size={14} /><span>{t.network}</span><span className="eyebrow-divider" /><span>{t.readOnly}</span></div>
          <h1>{t.title}<span className="title-period">.</span></h1>
        </div>
        <div className="tabs asset-tabs" role="group" aria-label={lang === "zh" ? "资产" : "Asset"}>
          <button aria-pressed={asset === "relic"} className={`btn ${asset === "relic" ? "on" : ""}`} onClick={() => setAsset("relic")}><span className="asset-symbol">R</span>RELICS</button>
          <button aria-pressed={asset === "loom"} className={`btn ${asset === "loom" ? "on" : ""}`} onClick={() => setAsset("loom")}><span className="asset-symbol">L</span>LOOMS</button>
        </div>
      </div>
      {(snap?.stale && snap.ready) || netErr ? <div className="banner error" role="alert" data-testid="stale-banner">{t.stale}{snap?.staleAge ? ` (${Math.round(snap.staleAge / 1000)}s)` : ""}</div> : null}
      <section className="cards market-stats" aria-label={lang === "zh" ? "市场概况" : "Market overview"}>
        <div className="card stat-item"><div className="k stat-label">{t.activeBids}</div><div className="v stat-value">{a ? Fmt.n(a.count, 0) : SK}</div><div className="s stat-foot">{t.demand} <span>{a ? Fmt.n(a.demand, 0) : "—"}</span></div></div>
        <div className="card stat-item"><div className="k stat-label">{t.escrow} <span>USDT</span></div><div className="v stat-value">{a ? Fmt.n(a.escrow) : SK}</div><div className="s stat-foot">{t.fee} <span>{snap ? snap.feeBps / 100 : "—"}%</span></div></div>
        <div className="card stat-item"><div className="k stat-label">{t.best} <span>USDT</span></div><div className="v stat-value up">{a ? Fmt.n(a.best, 4) : SK}</div><div className="s stat-foot">{t.last} <span>{a?.lastPrice != null ? Fmt.n(a.lastPrice, 4) : "—"}</span></div></div>
        <div className="card stat-item"><div className="k stat-label">{t.big}</div><div className="v stat-value">{a ? Fmt.n(a.bigCount, 0) : SK}<small>{a ? Fmt.n(a.bigEscrow) : "—"} USDT</small></div><div className="s stat-foot">{t.threshold}</div></div>
        <div className="card stat-item"><div className="k stat-label">{t.minted}</div><div className="v stat-value">{m ? Fmt.n(m.minted, 0) : SK}<small>/ {m ? Fmt.n(m.cap, 0) : "—"}</small></div><div className="s stat-foot">{t.handle}: {m ? (m.requireHandle ? t.yes : t.no) : "—"}</div>{m ? <div className="progress stat-progress" aria-hidden><i style={{ width: Fmt.pct(m.minted / m.cap) }} /></div> : null}</div>
        <div className="card stat-item"><div className="k stat-label">{t.mintPrice} <span>BNB</span></div><div className="v stat-value">{m ? Fmt.n(m.paidBnb, 4) : SK}</div><div className="s stat-foot">{t.first} <span>{m?.firstBnb ?? "—"} BNB</span></div></div>
      </section>
      <div className="market-workspace">
        <div className="market-chart">
          <KLine key={asset} asset={asset} lang={lang} title={t.chart} />
          <div className="vol market-volume" aria-label={t.vol}>
            <span className="section-label">{t.vol} <small>USDT</small></span>
            <span>1m <b>{a ? Fmt.n(a.volume.last1m.usdt) : "—"}</b></span>
            <span>5m <b>{a ? Fmt.n(a.volume.last5m.usdt) : "—"}</b></span>
            <span>15m <b>{a ? Fmt.n(a.volume.last15m.usdt) : "—"}</b></span>
            <span className="volume-total">{t.allTime} <b>{a ? Fmt.n(a.volume.totalUsdt, 0) : "—"}</b><small> / {a?.volume.totalFills ?? "—"} {lang === "zh" ? "笔" : "fills"}</small></span>
          </div>
        </div>
        <section className="panel monitor-book" aria-labelledby="book-title">
          <div className="panel-head"><h2 className="panel-title" id="book-title"><Icon name="layers" size={16} />{t.book}</h2><span className="panel-meta">{a ? Fmt.n(a.count, 0) : "—"}</span></div>
          <div className="scroll"><table><thead><tr><th className="r">{t.price}<small>USDT</small></th><th className="r">{t.qty}</th><th className="r">{t.total}<small>USDT</small></th><th>{t.buyer}</th><th className="r">{t.time}</th></tr></thead>
            <tbody>{TableState.of(a?.bids, 5, lang === "zh" ? "暂无买单" : "No open bids")}{a?.bids.map((b) => <tr key={b.id}><td className="r up">{Fmt.n(b.price, 4)}</td><td className="r">{Fmt.n(b.qty, 0)}</td><td className="r">{Fmt.n(b.total)}</td><td><a href={`https://bscscan.com/address/${b.buyer}`} target="_blank" rel="noreferrer">{Fmt.addr(b.buyer)}</a></td><td className="r dim">{Fmt.time(b.ts)}</td></tr>)}</tbody></table></div>
          <div className="book-foot"><span>{t.fee}</span><b>{snap ? snap.feeBps / 100 : "—"}%</b><span className="book-foot-note">{t.readOnly}</span></div>
        </section>
      </div>
      <div className="grid2 market-bottom">
        <section className="panel fills-panel" aria-labelledby="fills-title">
          <div className="panel-head"><h2 className="panel-title" id="fills-title"><Icon name="activity" size={16} />{t.fills}</h2><span className="panel-meta">{a?.volume.totalFills ?? "—"} {lang === "zh" ? "笔成交" : "fills"}</span></div>
          <div className="scroll"><table><thead><tr><th>{t.time}</th><th className="r">{t.price}<small>USDT</small></th><th>{t.buyer}</th><th>{t.seller}</th><th>{t.transaction}</th></tr></thead>
            <tbody>{TableState.of(a?.fills, 5, lang === "zh" ? "暂无成交" : "No fills yet")}{a?.fills.map((f) => <tr key={f.tx + f.ts + f.seller}><td className="dim">{Fmt.time(f.ts)}</td><td className="r">{Fmt.n(f.price, 4)}</td><td>{Fmt.addr(f.buyer)}</td><td>{Fmt.addr(f.seller)}</td><td><a className="transaction-link" href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 10)}<Icon name="external" size={12} /></a></td></tr>)}</tbody></table></div>
        </section>
        <section className="panel holders-panel" aria-labelledby="holders-title">
          <div className="panel-head"><h2 className="panel-title" id="holders-title"><Icon name="wallet" size={16} />{t.holders}</h2><span className="panel-meta">{t.top}<span className="hide-sm"> · {a?.holderCount ?? "—"} {t.holdersTotal}</span></span></div>
          <div className="scroll"><table><thead><tr><th className="r rank-col">#</th><th>{t.addr}</th><th className="r">{t.count}</th></tr></thead>
            <tbody>{TableState.of(a?.holders, 3, lang === "zh" ? "暂无持仓" : "No holders yet")}{a?.holders.map((h, i) => <tr key={h.address}><td className="r dim">{String(i + 1).padStart(2, "0")}</td><td><a className="holder-address" title={h.address} href={`https://bscscan.com/address/${h.address}`} target="_blank" rel="noreferrer">{Fmt.addr(h.address)}<Icon name="external" size={12} /></a></td><td className="r">{Fmt.n(h.count, 0)}</td></tr>)}</tbody></table></div>
        </section>
      </div>
      <footer className="muted contract-footer"><span className="contract-label"><Icon name="globe" size={14} />{t.contract}</span><div className="contract-list">{snap ? Object.entries(snap.contracts).map(([k, v]) => <span className="contract-item" key={k}>{k}<a className="mono" href={`https://bscscan.com/address/${v}`} target="_blank" rel="noreferrer">{Fmt.addr(v)}<Icon name="external" size={12} /></a></span>) : "—"}</div></footer>
      </main>
    </div>
  );
}
