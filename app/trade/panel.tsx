"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";

type Asset = "relic" | "loom";
type Row = { id: number; buyer?: string; price: number; qty: number; total: number; ts: number };
type View = { bids: Row[]; mine: Row[]; fills: { price: number; ts: number; tx: string; buyer: string; seller: string }[] };

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
  const nft: Address = asset === "relic" ? Contracts.relic : Contracts.loom;

  const load = useCallback(async () => {
    const s = await fetch(`/api/snapshot${address ? `?me=${address}` : ""}`, { cache: "no-store" }).then((r) => r.json());
    setView(s.asset?.[asset]);
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
  return (
    <>
      <p><button className={`btn ${asset === "relic" ? "on" : ""}`} onClick={() => setAsset("relic")}>RELICS</button> <button className={`btn ${asset === "loom" ? "on" : ""}`} onClick={() => setAsset("loom")}>LOOMS</button></p>
      {!address ? <p className="muted">{t.connect}</p> : null}
      <TxStatus tx={tx} lang={lang} />
      <div className="grid2">
        <div className="panel" data-testid="place">
          <h3>{t.place}</h3>
          <p>{t.price} <input data-testid="price" value={price} onChange={(e) => setPrice(e.target.value)} size={8} /> {t.qty} <input data-testid="qty" value={qty} onChange={(e) => setQty(e.target.value)} size={5} /></p>
          <p>{t.cost}: <b>{cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</b> <span className="muted">· {t.allowance} {allowance !== undefined ? formatUnits(allowance, 18) : "-"} · {t.feeNote}</span></p>
          {needApprove
            ? <button className="btn on" data-testid="approve-usdt" disabled={!can || !cost} onClick={() => write(t.approve, Contracts.usdt, Contracts.erc20Abi, "approve", [Contracts.market, cost!])}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
            : <button className="btn on" data-testid="place-bid" disabled={!can || !cost} onClick={() => write(t.submit, Contracts.market, Contracts.marketWriteAbi, "placeBid", [assetId, parseUnits(price, 18), Number(qty)])}>{t.submit}</button>}
          <h3 style={{ marginTop: 14 }}>{t.mine}</h3>
          <table><thead><tr><th>id</th><th>{t.price}</th><th>{t.qty}</th><th /></tr></thead><tbody data-testid="my-bids">
            {view?.mine.map((b) => <tr key={b.id}><td>{b.id}</td><td>{b.price}</td><td>{b.qty}</td><td><button className="btn" disabled={!can} onClick={() => write(`${t.cancel} #${b.id}`, Contracts.market, Contracts.marketWriteAbi, "cancelBid", [BigInt(b.id)])}>{t.cancel}</button></td></tr>)}
          </tbody></table>
        </div>
        <div className="panel">
          <h3>{t.sell}</h3>
          <p>{t.selected}: {sellBid ? <b>#{sellBid.id} @ {sellBid.price}</b> : "-"} · {t.tokenId} <input data-testid="token-id" value={tokenId} onChange={(e) => setTokenId(e.target.value)} size={8} /></p>
          {tid !== undefined && sellBid ? (nftApproved
            ? <button className="btn on" data-testid="fill" disabled={!can} onClick={() => write(`${t.sell} #${sellBid.id}`, Contracts.market, Contracts.marketWriteAbi, "fill", [BigInt(sellBid.id), [tid]])}>{t.sell} #{tokenId} → #{sellBid.id}</button>
            : <button className="btn on" data-testid="approve-nft" disabled={!can} onClick={() => write(t.approveNft, nft, Contracts.nftApproveAbi, "approve", [Contracts.market, tid])}>{t.approveNft} #{tokenId}</button>) : null}
          <h3 style={{ marginTop: 14 }}>{t.book}</h3>
          <div className="scroll"><table><thead><tr><th>id</th><th>{t.price}</th><th>{t.qty}</th><th /></tr></thead><tbody data-testid="book">
            {view?.bids.map((b) => <tr key={b.id}><td>{b.id}</td><td className="up">{b.price}</td><td>{b.qty}</td><td><button className={`btn ${sellBid?.id === b.id ? "on" : ""}`} disabled={b.buyer === address?.toLowerCase()} onClick={() => setSellBid(b)}>{t.sell}</button></td></tr>)}
          </tbody></table></div>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 10 }}><h3>{t.fills}</h3><table><tbody data-testid="fills">
        {view?.fills.slice(0, 8).map((f) => <tr key={f.tx + f.seller + f.ts}><td>{new Date(f.ts).toLocaleTimeString("en-GB")}</td><td>{f.price}</td><td className="mono">{f.seller.slice(0, 8)}→{f.buyer.slice(0, 8)}</td><td><a href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 12)}</a></td></tr>)}
      </tbody></table></div>
    </>
  );
}

export default function TradePanel() {
  return <Shell title={{ zh: "交易", en: "Trade" }}>{(lang) => <Trade lang={lang} />}</Shell>;
}
