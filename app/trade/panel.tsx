"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { Fmt } from "@/lib/fmt";

type Asset = "relic" | "loom";
type Row = { id: number; buyer?: string; price: number; qty: number; total: number; ts: number };
type View = { feeBps?: number; bids: Row[]; mine: Row[]; fills: { price: number; ts: number; tx: string; buyer: string; seller: string }[] };

const T = {
  zh: { book: "买单簿", mine: "我的买单", place: "挂买单", price: "单价 USDT", qty: "数量", cost: "需锁定", allowance: "当前授权", approve: "授权 USDT（仅本次所需）", submit: "挂单", cancel: "撤单", sell: "卖出", tokenId: "Token ID", approveNft: "仅授权此 NFT", fills: "最近成交", connect: "请先连接钱包", feeNote: "成交手续费由卖方承担", selected: "已选买单" },
  en: { book: "Bid book", mine: "My bids", place: "Place bid", price: "Price USDT", qty: "Qty", cost: "Escrow", allowance: "Current allowance", approve: "Approve USDT (exact amount only)", submit: "Place bid", cancel: "Cancel", sell: "Sell", tokenId: "Token ID", approveNft: "Approve this NFT only", fills: "Recent fills", connect: "Connect a wallet first", feeNote: "Fill fee is paid by the seller", selected: "Selected bid" },
} as const;

function Trade({ lang }: { lang: Lang }) {
  const t = T[lang];
  const { address, ok } = useWalletGate();
  const pc = usePublicClient();
  const { data: wallet } = useWalletClient();
  const [asset, setAsset] = useState<Asset>("relic");
  const [view, setView] = useState<View>();
  const [price, setPrice] = useState("1");
  const [qty, setQty] = useState("1");
  const [sellBid, setSellBid] = useState<Row>();
  const [tokenId, setTokenId] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const nft: Address = asset === "relic" ? Contracts.relic : Contracts.loom;

  const load = useCallback(async () => {
    const s = await fetch(`/api/snapshot${address ? `?me=${address}` : ""}`, { cache: "no-store" }).then((r) => r.json());
    setView(s.asset?.[asset] ? { ...s.asset[asset], feeBps: s.feeBps } : undefined);
  }, [address, asset]);
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  let cost: bigint | undefined;
  try { cost = parseUnits(price || "0", 18) * BigInt(Math.max(0, Math.floor(Number(qty) || 0))); } catch { cost = undefined; }
  const tid = /^\d+$/.test(tokenId) ? BigInt(tokenId) : undefined;
  const acct = address ?? "0x0000000000000000000000000000000000000000";
  const { data, refetch } = useReadContracts({ allowFailure: true, contracts: [
    { address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "allowance", args: [acct, Contracts.market] },
    { address: nft, abi: Contracts.nftApproveAbi, functionName: "getApproved", args: [tid ?? 0n] },
    { address: nft, abi: Contracts.nftApproveAbi, functionName: "isApprovedForAll", args: [acct, Contracts.market] },
  ], query: { refetchInterval: 4000 } });
  const allowance = data?.[0]?.result as bigint | undefined;
  const nftApproved = (data?.[1]?.result as string | undefined)?.toLowerCase() === Contracts.market.toLowerCase() || data?.[2]?.result === true;
  const onDone = useCallback(() => { refetch(); setTimeout(load, 4500); }, [refetch, load]);
  const tx = useTx(onDone);
  const can = ok && !!wallet && !!address && !tx.busy;
  const a = address!;

  const write = (name: string, address_: Address, abi: typeof Contracts.marketWriteAbi | typeof Contracts.erc20Abi | typeof Contracts.nftApproveAbi, functionName: string, args: readonly unknown[]) =>
    tx.run(name,
      () => pc!.simulateContract({ account: a, address: address_, abi, functionName, args } as never),
      () => wallet!.writeContract({ account: a, chain: wallet!.chain, address: address_, abi, functionName, args } as never));

  const assetId = asset === "relic" ? 0 : 1;
  const needApprove = cost !== undefined && (allowance ?? 0n) < cost;
  const empty = (cols: number, text: string) => <tr><td className="empty" colSpan={cols}>{view ? text : <span className="sk" />}</td></tr>;
  const none = lang === "zh" ? "暂无" : "Nothing yet";
  const zh = lang === "zh";
  const fee = (view?.feeBps ?? 0) / 10_000;
  const maxQty = Math.max(1, ...(view?.bids.map((b) => b.qty) ?? [1]));
  const pick = (b: Row) => { setSellBid(b); setSide("sell"); };
  const approving = tx.label === t.approve || tx.label === t.approveNft;
  // Step indicator: approve -> sign -> pending -> confirmed, driven by the real tx phase.
  const needStep1 = side === "buy" ? needApprove : !nftApproved;
  const steps = [zh ? "授权" : "Approve", zh ? "签名" : "Sign", zh ? "上链中" : "Pending", zh ? "已确认" : "Confirmed"];
  const cur = tx.phase === "signing" || tx.phase === "simulating" ? (approving ? 0 : 1) : tx.phase === "submitted" ? 2 : tx.phase === "success" && !approving ? 3 : needStep1 ? 0 : 1;
  const bad = tx.phase === "failed" || tx.phase === "rejected";
  return (
    <>
      <div className="row" style={{ marginTop: 0 }}>
        <div className="tabs" role="group" aria-label="Asset"><button aria-pressed={asset === "relic"} className={`btn ${asset === "relic" ? "on" : ""}`} onClick={() => setAsset("relic")}>RELICS</button><button aria-pressed={asset === "loom"} className={`btn ${asset === "loom" ? "on" : ""}`} onClick={() => setAsset("loom")}>LOOMS</button></div>
        <span className="muted">{zh ? "最优买价" : "Best bid"} <b className="up num">{view?.bids[0] ? Fmt.n(view.bids[0].price, 4) : "-"}</b> · {zh ? "手续费" : "Fee"} <b className="num">{Fmt.n(fee * 100, 2)}%</b> ({t.feeNote})</span>
      </div>
      {!address ? <div className="banner">{t.connect}</div> : null}
      <TxStatus tx={tx} lang={lang} />
      <div className="exch">
        <section className="panel" aria-labelledby="book-h">
          <h2 id="book-h">{t.book} <span className="muted">{zh ? "点击买单即可卖出" : "click a bid to sell into it"}</span></h2>
          <div className="scroll tall"><table className="book"><thead><tr><th className="r">{t.price}</th><th className="r">{t.qty}</th><th className="r">{zh ? "总额" : "Total"}</th><th className="r">id</th></tr></thead><tbody data-testid="book">
            {view?.bids.length ? view.bids.map((b) => {
              const mine = b.buyer === address?.toLowerCase();
              return <tr key={b.id} className={`${sellBid?.id === b.id ? "sel" : ""} ${mine ? "mine" : "pick"}`} style={{ ["--d" as string]: `${(b.qty / maxQty) * 100}%` }}
                tabIndex={mine ? -1 : 0} aria-selected={sellBid?.id === b.id} onClick={() => !mine && pick(b)} onKeyDown={(e) => { if (!mine && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(b); } }}>
                <td className="r up">{Fmt.n(b.price, 4)}</td><td className="r">{b.qty}</td><td className="r">{Fmt.n(b.total)}</td><td className="r dim">{mine ? (zh ? "我的" : "mine") : `#${b.id}`}</td></tr>;
            }) : empty(4, none)}
          </tbody></table></div>
        </section>
        <section className="panel order" aria-labelledby="order-h">
          <h2 id="order-h" className="sr-only">{zh ? "下单" : "Order"}</h2>
          <div className="side" role="tablist">
            <button role="tab" aria-selected={side === "buy"} className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>{zh ? "买入 · 挂买单" : "Buy · place bid"}</button>
            <button role="tab" aria-selected={side === "sell"} className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>{zh ? "卖出 · 成交买单" : "Sell · fill a bid"}</button>
          </div>
          {side === "buy" ? (
            <div data-testid="place">
              <label className="field wide">{t.price}<span className="inp"><input data-testid="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /><em>USDT</em></span></label>
              <label className="field wide">{t.qty}<span className="inp"><input data-testid="qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /><em>NFT</em></span></label>
              <dl className="kv sum">
                <dt>{t.cost}</dt><dd><b>{Fmt.units(cost)} USDT</b></dd>
                <dt>{zh ? "需授权（精确）" : "Approval (exact)"}</dt><dd>{cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</dd>
                <dt>{t.allowance}</dt><dd>{Fmt.units(allowance)} USDT</dd>
                <dt>{zh ? "手续费" : "Fee"}</dt><dd>{zh ? "买方 0（由卖方承担）" : "0 for buyer (seller pays)"}</dd>
              </dl>
              {needApprove
                ? <button className="btn primary buy block" data-testid="approve-usdt" disabled={!can || !cost} onClick={() => write(t.approve, Contracts.usdt, Contracts.erc20Abi, "approve", [Contracts.market, cost!])}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
                : <button className="btn primary buy block" data-testid="place-bid" disabled={!can || !cost} onClick={() => write(t.submit, Contracts.market, Contracts.marketWriteAbi, "placeBid", [assetId, parseUnits(price, 18), Number(qty)])}>{t.submit} · {Fmt.units(cost)} USDT</button>}
            </div>
          ) : (
            <div>
              <div className="field wide">{t.selected}<span className="inp"><b className="gold num" style={{ padding: "8px 10px", flex: 1 }}>{sellBid ? `#${sellBid.id} @ ${Fmt.n(sellBid.price, 4)} USDT` : (zh ? "← 从买单簿选择" : "← pick from the book")}</b></span></div>
              <label className="field wide">{t.tokenId}<span className="inp"><input data-testid="token-id" inputMode="numeric" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="e.g. 63609" /><em>#</em></span></label>
              <dl className="kv sum">
                <dt>{zh ? "成交价" : "Price"}</dt><dd>{sellBid ? Fmt.n(sellBid.price, 4) : "-"} USDT</dd>
                <dt>{zh ? "手续费" : "Fee"} ({Fmt.n(fee * 100, 2)}%)</dt><dd className="down">{sellBid ? `−${Fmt.n(sellBid.price * fee, 4)}` : "-"} USDT</dd>
                <dt>{zh ? "预计到手" : "You receive"}</dt><dd><b className="up">{sellBid ? Fmt.n(sellBid.price * (1 - fee), 4) : "-"} USDT</b></dd>
                <dt>{zh ? "需授权（仅此 NFT）" : "Approval (this NFT only)"}</dt><dd>{tid !== undefined ? `#${tokenId}` : "-"} {nftApproved ? "✓" : ""}</dd>
              </dl>
              {tid !== undefined && sellBid ? (nftApproved
                ? <button className="btn primary sell block" data-testid="fill" disabled={!can} onClick={() => write(`${t.sell} #${sellBid.id}`, Contracts.market, Contracts.marketWriteAbi, "fill", [BigInt(sellBid.id), [tid]])}>{t.sell} #{tokenId} → #{sellBid.id}</button>
                : <button className="btn primary sell block" data-testid="approve-nft" disabled={!can} onClick={() => write(t.approveNft, nft, Contracts.nftApproveAbi, "approve", [Contracts.market, tid])}>{t.approveNft} #{tokenId}</button>)
                : <button className="btn primary sell block" disabled>{zh ? "选择买单并输入 Token ID" : "Pick a bid and enter a token ID"}</button>}
            </div>
          )}
          <ol className="steps" aria-label={zh ? "交易步骤" : "Transaction steps"} data-testid="steps">
            {steps.map((x, i) => <li key={x} className={`${i < cur ? "done" : ""} ${i === cur ? (bad ? "bad" : "cur") : ""}`} aria-current={i === cur ? "step" : undefined}>{x}</li>)}
          </ol>
          {bad ? <p className="err" role="alert" data-testid="step-error">{tx.phase === "rejected" ? (zh ? "已在钱包中拒绝，未发送任何交易。" : "Rejected in wallet. Nothing was sent.") : tx.error}</p> : null}
          <p className="muted">{zh ? "每笔交易先 eth_call 模拟；失败会显示原因且不会请求签名。" : "Every transaction is simulated with eth_call first; a revert shows its reason and never asks for a signature."}</p>
        </section>
      </div>
      <div className="grid2">
        <section className="panel" aria-labelledby="mine-h"><h2 id="mine-h">{t.mine}</h2>
          <table><thead><tr><th>id</th><th className="r">{t.price}</th><th className="r">{t.qty}</th><th className="r">{zh ? "锁定" : "Escrow"}</th><th /></tr></thead><tbody data-testid="my-bids">
            {view?.mine.length ? view.mine.map((b) => <tr key={b.id}><td>{b.id}</td><td className="r">{Fmt.n(b.price, 4)}</td><td className="r">{b.qty}</td><td className="r">{Fmt.n(b.total)}</td><td className="r"><button className="btn sm" disabled={!can} onClick={() => write(`${t.cancel} #${b.id}`, Contracts.market, Contracts.marketWriteAbi, "cancelBid", [BigInt(b.id)])}>{t.cancel}</button></td></tr>) : empty(5, address ? none : t.connect)}
          </tbody></table></section>
        <section className="panel" aria-labelledby="fills-h"><h2 id="fills-h">{t.fills}</h2><div className="scroll"><table><thead><tr><th>{zh ? "时间" : "Time"}</th><th className="r">{t.price}</th><th>{zh ? "卖→买" : "Seller→Buyer"}</th><th>tx</th></tr></thead><tbody data-testid="fills">
          {view?.fills.length ? view.fills.slice(0, 12).map((f) => <tr key={f.tx + f.seller + f.ts}><td>{Fmt.time(f.ts)}</td><td className="r up">{Fmt.n(f.price, 4)}</td><td className="mono">{f.seller.slice(0, 8)}→{f.buyer.slice(0, 8)}</td><td><a href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 10)}</a></td></tr>) : empty(4, none)}
        </tbody></table></div></section>
      </div>
    </>
  );
}

export default function TradePanel() {
  return <Shell active="/trade" title={{ zh: "交易", en: "Trade" }} sub={{ zh: "挂买单 / 卖给买单 · 每笔先模拟再签名 · 仅精确授权", en: "Place bids or sell into them · simulated before signing · exact approvals only" }}>{(lang) => <Trade lang={lang} />}</Shell>;
}
