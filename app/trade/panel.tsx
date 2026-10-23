"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address, type Abi } from "viem";
import { usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { Fmt } from "@/lib/fmt";
import { PLATFORM_FEE_ABI, PLATFORM_FEE_RECIPIENT, platformFeeRouterAddress, platformFeeStartBlock, readSellerQuote, readNftSaleState, sameSellerQuote, type SellerQuote } from "@/lib/platform-fee";
import { TableState } from "@/components/ui";
import { Icon } from "@/components/icons";

type Asset = "relic" | "loom";
type SnapshotContext = { asset: Asset; address?: Address; active: boolean; request?: AbortController };
type Row = { id: number; buyer?: string; price: number; qty: number; total: number; ts: number };
type View = { feeBps?: number; demand?: number; escrow?: number; bids: Row[]; mine: Row[]; fills: { price: number; ts: number; tx: string; buyer: string; seller: string }[] };

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
  const [sync, setSync] = useState<{ backfill?: number; stale?: boolean }>();
  const [price, setPrice] = useState("1");
  const [qty, setQty] = useState("1");
  const [sellBid, setSellBid] = useState<Row>();
  const [tokenId, setTokenId] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [sale, setSale] = useState<{ context: object; quote: SellerQuote; approved: boolean; at: number }>();
  const [saleError, setSaleError] = useState("");
  const saleContext = useRef<{ asset: Asset; address?: Address; bidId?: number; tokenId: string; ok: boolean; walletChain?: number; walletId?: string; active: boolean }>({ asset, address, tokenId, ok, active: true });
  const currentSale = saleContext.current;
  if (currentSale.asset !== asset || currentSale.address !== address || currentSale.bidId !== sellBid?.id || currentSale.tokenId !== tokenId || currentSale.ok !== ok || currentSale.walletChain !== wallet?.chain?.id || currentSale.walletId !== wallet?.uid) {
    currentSale.active = false;
    saleContext.current = { asset, address, bidId: sellBid?.id, tokenId, ok, walletChain: wallet?.chain?.id, walletId: wallet?.uid, active: true };
  }
  const invalidateSale = () => { saleContext.current.active = false; setSale(undefined); setSaleError(""); };
  const activeView = useRef<SnapshotContext>({ asset, address, active: true });
  const nft: Address = asset === "relic" ? Contracts.relic : Contracts.loom;

  const load = useCallback(async () => {
    const context = activeView.current;
    if (!context.active || context.asset !== asset || context.address !== address || context.request || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const controller = new AbortController();
    context.request = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/snapshot${address ? `?me=${address}` : ""}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Snapshot unavailable");
      const s = await response.json();
      if (activeView.current !== context || controller.signal.aborted) return;
      setSync({ backfill: s.backfill, stale: s.stale });
      setView(s.ready !== false && s.asset?.[asset] ? { ...s.asset[asset], feeBps: s.feeBps } : undefined);
    } catch { /* keep the last successful book */ }
    finally {
      clearTimeout(timeout);
      if (context.request === controller) context.request = undefined;
    }
  }, [address, asset]);
  useEffect(() => {
    if (activeView.current.asset !== asset || activeView.current.address !== address) activeView.current = { asset, address, active: true };
    const context = activeView.current;
    context.active = true;
    load();
    const id = setInterval(load, 2000);
    return () => {
      clearInterval(id);
      context.active = false;
      context.request?.abort();
      context.request = undefined;
    };
  }, [load, asset, address]);

  let cost: bigint | undefined;
  try { cost = parseUnits(price || "0", 18) * BigInt(Math.max(0, Math.floor(Number(qty) || 0))); } catch { cost = undefined; }
  const selectedBidId = sellBid?.id;
  const tid = /^\d+$/.test(tokenId) ? BigInt(tokenId) : undefined;
  const acct = address ?? "0x0000000000000000000000000000000000000000";
  const { data, refetch } = useReadContracts({ allowFailure: true, contracts: [
    { address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "allowance", args: [acct, Contracts.market] },
  ], query: { refetchInterval: 4000 } });
  const allowance = data?.[0]?.result as bigint | undefined;
  const readySale = sale?.context === saleContext.current && saleContext.current.active && Date.now() - sale.at <= 15000 ? sale : undefined;
  const nftApproved = readySale?.approved === true;
  const saleQuote = readySale?.quote;
  useEffect(() => {
    const context = saleContext.current;
    let inFlight = false;
    let live = true;
    context.active = true;
    const refresh = async () => {
      if (inFlight || !live || !context.active || !ok || !pc || !address || tid === undefined || selectedBidId === undefined || wallet?.chain?.id !== 56 || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const router = platformFeeRouterAddress();
        if (router && !platformFeeStartBlock()) throw new Error("Platform router deployment block is missing");
        const quote = await readSellerQuote(pc, { router, bidId: BigInt(selectedBidId), asset: asset === "relic" ? 0 : 1, seller: address });
        const state = await readNftSaleState(pc, nft, tid, address, quote.spender);
        if (!live || saleContext.current !== context || !context.active) return;
        setSale({ context, quote, approved: state.approved, at: Date.now() }); setSaleError("");
      } catch {
        if (!live || saleContext.current !== context || !context.active) return;
        setSale(undefined); setSaleError(lang === "zh" ? "卖出核验失败，请检查网络、订单、NFT 所有权及结算合约配置。" : "Sale verification failed. Check network, bid, NFT ownership and router configuration.");
      } finally { inFlight = false; }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { live = false; clearInterval(timer); context.active = false; };
  }, [address, ok, asset, selectedBidId, tokenId, pc, wallet?.chain?.id, wallet?.uid, lang, nft, tid]);
  const onDone = useCallback(() => { refetch(); setTimeout(load, 4500); }, [refetch, load]);
  const tx = useTx(onDone);
  const can = ok && !!wallet && !!address && !tx.busy;
  const a = address!;
  const changeAsset = (next: Asset) => {
    if (next === asset || tx.busy) return;
    // Invalidate old requests before React renders the new asset.
    const previous = activeView.current;
    activeView.current = { asset: next, address, active: true };
    previous.active = false;
    previous.request?.abort();
    invalidateSale();
    setAsset(next);
    setView(undefined);
    setSync(undefined);
    setSellBid(undefined);
    setTokenId("");
  };

  const write = (name: string, address_: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    tx.run(name,
      () => pc!.simulateContract({ account: a, address: address_, abi, functionName, args } as never),
      () => wallet!.writeContract({ account: a, chain: wallet!.chain, address: address_, abi, functionName, args } as never));

  const sell = (approveOnly: boolean) => {
    const context = saleContext.current;
    const displayed = readySale;
    if (!can || !pc || !wallet || !address || tid === undefined || !sellBid || !displayed) return;
    const bidId = BigInt(sellBid.id);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const target = approveOnly ? nft : displayed.quote.spender;
    const abi = approveOnly ? Contracts.nftApproveAbi : displayed.quote.routed ? PLATFORM_FEE_ABI : Contracts.marketWriteAbi;
    const functionName = approveOnly ? "approve" : displayed.quote.routed ? "sell" : "fill";
    const args = approveOnly ? [displayed.quote.spender, tid] : displayed.quote.routed ? [bidId, tid, displayed.quote.proceeds, deadline] : [bidId, [tid]];
    const checkContext = () => {
      if (saleContext.current !== context || !context.active || Date.now() - displayed.at > 15000 || Date.now() / 1000 >= Number(deadline)) throw new Error("Sale context / quote expired; refresh before signing");
    };
    const check = async () => {
      checkContext();
      const router = platformFeeRouterAddress();
      if (router && !platformFeeStartBlock()) throw new Error("Platform router deployment block is missing");
      const quote = await readSellerQuote(pc, { router, bidId, asset: context.asset === "relic" ? 0 : 1, seller: address });
      const state = await readNftSaleState(pc, nft, tid, address, quote.spender);
      checkContext();
      if (!sameSellerQuote(displayed.quote, quote)) throw new Error("Bid quote changed; refresh before signing");
      if (!approveOnly && !state.approved) throw new Error("This NFT is not approved to the sale spender");
      // Read the wallet provider itself: hook updates may arrive after a network/account switch.
      const [accounts, chain] = await Promise.all([
        wallet.request({ method: "eth_accounts" }), wallet.request({ method: "eth_chainId" }),
      ]);
      checkContext();
      if (Number(chain) !== 56 || accounts[0]?.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet account / chain changed");
    };
    tx.run(approveOnly ? t.approveNft : `${t.sell} #${sellBid.id}`,
      async () => { await check(); await pc.simulateContract({ account: address, address: target, abi, functionName, args } as never); checkContext(); },
      async () => { await check(); checkContext(); return wallet.writeContract({ account: address, chain: wallet.chain, address: target, abi, functionName, args } as never); });
  };

  const assetId = asset === "relic" ? 0 : 1;
  const needApprove = cost !== undefined && (allowance ?? 0n) < cost;
  const empty = (cols: number, text: string) => view ? TableState.empty(cols, text) : TableState.loading(cols, 4);
  const none = lang === "zh" ? "暂无" : "Nothing yet";
  const zh = lang === "zh";
  const fee = (view?.feeBps ?? 0) / 10_000;
  const maxQty = Math.max(1, ...(view?.bids.map((b) => b.qty) ?? [1]));
  const pick = (b: Row) => { if (sellBid?.id !== b.id) invalidateSale(); setSellBid(b); setSide("sell"); };
  const approving = tx.label === t.approve || tx.label === t.approveNft;
  // Step indicator: approve -> sign -> pending -> confirmed, driven by the real tx phase.
  const needStep1 = side === "buy" ? needApprove : !nftApproved;
  const steps = [zh ? "授权" : "Approve", zh ? "签名" : "Sign", zh ? "上链中" : "Pending", zh ? "已确认" : "Confirmed"];
  const cur = tx.phase === "signing" || tx.phase === "simulating" ? (approving ? 0 : 1) : tx.phase === "submitted" ? 2 : tx.phase === "success" && !approving ? 3 : needStep1 ? 0 : 1;
  const bad = tx.phase === "failed" || tx.phase === "rejected";
  const totalDemand = view?.demand;
  const totalEscrow = view?.escrow;
  const feeLabel = view?.feeBps === undefined ? "-" : `${Fmt.n(fee * 100, 2)}%`;
  return (
    <>
      <div className="trade-toolbar">
        <div className="trade-asset-control"><span className={`asset-mark ${asset}`} aria-hidden="true">{asset === "relic" ? "R" : "L"}</span><div><span className="section-label">{zh ? "交易资产" : "Trading asset"}</span><div className="tabs asset-tabs" role="group" aria-label="Asset"><button aria-pressed={asset === "relic"} className={`btn ${asset === "relic" ? "on" : ""}`} disabled={tx.busy} onClick={() => changeAsset("relic")}>RELICS</button><button aria-pressed={asset === "loom"} className={`btn ${asset === "loom" ? "on" : ""}`} disabled={tx.busy} onClick={() => changeAsset("loom")}>LOOMS</button><span className="quote-unit">/ USDT</span></div></div></div>
        <dl className="trade-market-stats">
          <div><dt>{zh ? "最优买价" : "Best bid"}</dt><dd className="up num">{view?.bids[0] ? Fmt.n(view.bids[0].price, 4) : "-"}<small> USDT</small></dd></div>
          <div><dt>{zh ? "买单需求" : "Bid demand"}</dt><dd className="num">{totalDemand === undefined ? "-" : Fmt.n(totalDemand, 0)}<small> NFT</small></dd></div>
          <div><dt>{zh ? "锁定资金" : "In escrow"}</dt><dd className="num">{totalEscrow === undefined ? "-" : Fmt.n(totalEscrow, 2)}<small> USDT</small></dd></div>
          <div><dt>{zh ? "市场当前费率" : "Current market fee"}</dt><dd className="num">{feeLabel}</dd></div>
        </dl>
      </div>
      {sync?.stale ? <div className="banner error" role="status" data-testid="trade-stale">{zh ? "数据延迟，显示最近成功数据" : "Data delayed. Showing the last successful data."}</div>
        : typeof sync?.backfill === "number" && sync.backfill < 1 ? <div className="banner" role="status" data-testid="trade-backfill"><span>{zh ? "历史数据同步中" : "Syncing history"} <b className="num">{Fmt.pct(sync.backfill)}</b> · {zh ? "当前买单簿为已索引数据" : "The order book shows indexed data."}</span><span className="progress" role="progressbar" aria-label={zh ? "历史同步进度" : "History sync progress"} aria-valuenow={Math.floor(sync.backfill * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: Fmt.pct(sync.backfill) }} /></span></div> : null}
      {!address ? <div className="banner wallet-banner"><Icon name="wallet" size={17} /><span><b>{t.connect}</b><span className="muted">{zh ? " · 通过右上角连接钱包，开始挂单或出售藏品。" : " · Use the wallet control above to place bids or sell your collection."}</span></span></div> : null}
      <TxStatus tx={tx} lang={lang} />
      <div className="exch trade-layout">
        <section className="panel book-panel" aria-labelledby="book-h">
          <div className="panel-head"><div><span className="section-label">ORDER BOOK</span><h2 id="book-h" className="panel-title">{t.book}</h2></div><span className="book-count num">{view ? view.bids.length : "-"}<span className="muted"> {zh ? "笔买单" : "bids"}</span></span></div>
          <div className="book-guide"><span><Icon name="layers" size={14} /> {zh ? "买单深度" : "Bid depth"}</span><span>{zh ? "点击买单即可卖出" : "Select a bid to sell into it"}</span></div>
          <div className="scroll tall"><table className="book"><thead><tr><th className="r book-col">{t.price}</th><th className="r book-col">{t.qty}</th><th className="r book-col">{zh ? "总额" : "Total"}</th><th className="r book-col">id</th></tr></thead><tbody data-testid="book">
            {view?.bids.length ? view.bids.map((b) => {
              const mine = b.buyer === address?.toLowerCase();
              return <tr key={b.id} className={`${sellBid?.id === b.id ? "sel" : ""} ${mine ? "mine" : "pick"}`} style={{ ["--d" as string]: `${(b.qty / maxQty) * 100}%` }}
                tabIndex={mine ? -1 : 0} aria-selected={sellBid?.id === b.id} onClick={() => !mine && pick(b)} onKeyDown={(e) => { if (!mine && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(b); } }}>
                <td className="r up">{Fmt.n(b.price, 4)}</td><td className="r">{b.qty}</td><td className="r">{Fmt.n(b.total)}</td><td className="r dim">{mine ? (zh ? "我的" : "mine") : `#${b.id}`}</td></tr>;
            }) : empty(4, none)}
          </tbody></table></div>
          <div className="book-best"><div><span className="section-label">{zh ? "最优买价" : "Best bid"}</span><b className="num up">{view?.bids[0] ? Fmt.n(view.bids[0].price, 4) : "-"}<small> USDT</small></b></div><Icon name="arrow-up-right" size={22} /></div>
          <p className="note book-note">{zh ? "买单资金由市场合约锁定，成交后按单价结算。" : "Bid funds are held by the market contract and settled at the bid price."}</p>
        </section>
        <section className="panel order order-panel" aria-labelledby="order-h">
          <div className="panel-head order-head"><h2 id="order-h" className="panel-title">{zh ? "委托下单" : "Place an order"}</h2><span className="muted order-asset">{asset === "relic" ? "RELICS" : "LOOMS"} / USDT</span></div>
          <div className="side" role="tablist">
            <button role="tab" aria-selected={side === "buy"} className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>{zh ? "买入 · 挂买单" : "Buy · place bid"}</button>
            <button role="tab" aria-selected={side === "sell"} className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>{zh ? "卖出 · 成交买单" : "Sell · fill a bid"}</button>
          </div>
          {side === "buy" ? (
            <div data-testid="place" className="order-fields">
              <label className="field wide">{t.price}<span className="inp"><input data-testid="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /><em>USDT</em></span></label>
              <label className="field wide">{t.qty}<span className="inp"><input data-testid="qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /><em>NFT</em></span></label>
              <dl className="kv sum order-summary">
                <dt>{t.cost}</dt><dd className="summary-total"><b>{Fmt.units(cost)} USDT</b></dd>
                <dt>{zh ? "需授权（精确）" : "Approval (exact)"}</dt><dd>{cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</dd>
                <dt>{t.allowance}</dt><dd>{Fmt.units(allowance)} USDT</dd>
                <dt>{zh ? "手续费" : "Fee"}</dt><dd>{zh ? "买方 0（由卖方承担）" : "0 for buyer (seller pays)"}</dd>
              </dl>
              {needApprove
                ? <button className="btn primary buy block" data-testid="approve-usdt" disabled={!can || !cost} onClick={() => write(t.approve, Contracts.usdt, Contracts.erc20Abi, "approve", [Contracts.market, cost!])}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
                : <button className="btn primary buy block" data-testid="place-bid" disabled={!can || !cost} onClick={() => write(t.submit, Contracts.market, Contracts.marketWriteAbi, "placeBid", [assetId, parseUnits(price, 18), Number(qty)])}>{t.submit} · {Fmt.units(cost)} USDT</button>}
            </div>
          ) : (
            <div className="order-fields">
              <div className="field wide">{t.selected}<span className="inp"><b className={`num pickv ${sellBid ? "gold" : "dim"}`}>{sellBid ? `#${sellBid.id} @ ${Fmt.n(sellBid.price, 4)} USDT` : (zh ? "← 从买单簿选择" : "← pick from the book")}</b></span></div>
              <label className="field wide">{t.tokenId}<span className="inp"><input data-testid="token-id" inputMode="numeric" value={tokenId} onChange={(e) => { if (e.target.value !== tokenId) invalidateSale(); setTokenId(e.target.value); }} placeholder={zh ? "输入藏品 Token ID" : "Enter your token ID"} /><em>#</em></span></label>
              <dl className="kv sum order-summary">
                <dt>{zh ? "成交价" : "Price"}</dt><dd>{saleQuote ? formatUnits(saleQuote.gross, 18) : "-"} USDT</dd>
                <dt>{zh ? "原市场费" : "Market fee"} {saleQuote ? `(${formatUnits(saleQuote.marketFeeBps, 2)}%)` : ""}</dt><dd className="down">{saleQuote ? `−${formatUnits(saleQuote.marketFee, 18)}` : "-"} USDT</dd>
                {saleQuote?.routed ? <><dt>{zh ? "平台费（卖方 0.5%）" : "Platform fee (seller 0.5%)"}</dt><dd className="down" data-testid="platform-fee">−{formatUnits(saleQuote.platformFee, 18)} USDT</dd><dt>{zh ? "合计费率" : "Total fee rate"}</dt><dd>{formatUnits(saleQuote.marketFeeBps + 50n, 2)}%</dd><dt>{zh ? "平台费收款人" : "Platform recipient"}</dt><dd className="mono" title={PLATFORM_FEE_RECIPIENT}>{Fmt.addr(PLATFORM_FEE_RECIPIENT)}</dd></> : null}
                <dt>{zh ? "最低净到账" : "Minimum proceeds"}</dt><dd className="summary-total" data-testid="sale-proceeds"><b className="up">{saleQuote ? formatUnits(saleQuote.proceeds, 18) : "-"} USDT</b></dd>
                <dt>{zh ? "需授权（仅此 NFT）" : "Approval (this NFT only)"}</dt><dd>{tid !== undefined ? `#${tokenId}` : "-"} {nftApproved ? "✓" : ""}</dd>
                <dt>{zh ? "授权 / 成交合约" : "Approval / sale spender"}</dt><dd className="mono" data-testid="sale-spender" title={saleQuote?.spender}>{saleQuote ? Fmt.addr(saleQuote.spender) : "-"}</dd>
              </dl>
              {saleError ? <p className="err" role="alert" data-testid="sale-error">{saleError}</p> : null}
              {tid !== undefined && sellBid ? (nftApproved
                ? <button className="btn primary sell block" data-testid="fill" disabled={!can || !readySale} onClick={() => sell(false)}>{t.sell} #{tokenId} → #{sellBid.id}</button>
                : <button className="btn primary sell block" data-testid="approve-nft" disabled={!can || !readySale} onClick={() => sell(true)}>{t.approveNft} #{tokenId}</button>)
                : <button className="btn primary sell block" disabled>{zh ? "选择买单并输入 Token ID" : "Pick a bid and enter a token ID"}</button>}
            </div>
          )}
          <ol className="steps" aria-label={zh ? "交易步骤" : "Transaction steps"} data-testid="steps">
            {steps.map((x, i) => <li key={x} className={`${i < cur ? "done" : ""} ${i === cur ? (bad ? "bad" : "cur") : ""}`} aria-current={i === cur ? "step" : undefined}>{x}</li>)}
          </ol>
          {bad ? <p className="step-err" role="alert" data-testid="step-error">{tx.phase === "rejected" ? (zh ? "已在钱包中拒绝，未发送任何交易。" : "Rejected in wallet. Nothing was sent.") : tx.error}</p> : null}
          <p className="note order-note"><Icon name="check" size={14} />{zh ? "交易将在签名前检查，授权仅限本次所需。" : "Transactions are checked before signing. Approvals are limited to this order."}</p>
        </section>
      </div>
      <div className="grid2 trade-history">
        <section className="panel history-panel" aria-labelledby="mine-h"><div className="panel-head"><h2 id="mine-h" className="panel-title">{t.mine}</h2><span className="muted num">{address && view ? view.mine.length : "-"}</span></div>
          <div className="scroll"><table><thead><tr><th>id</th><th className="r">{t.price}</th><th className="r">{t.qty}</th><th className="r">{zh ? "锁定" : "Escrow"}</th><th /></tr></thead><tbody data-testid="my-bids">
            {view?.mine.length ? view.mine.map((b) => <tr key={b.id}><td>{b.id}</td><td className="r">{Fmt.n(b.price, 4)}</td><td className="r">{b.qty}</td><td className="r">{Fmt.n(b.total)}</td><td className="r"><button className="btn sm" disabled={!can} onClick={() => write(`${t.cancel} #${b.id}`, Contracts.market, Contracts.marketWriteAbi, "cancelBid", [BigInt(b.id)])}>{t.cancel}</button></td></tr>) : empty(5, address ? none : t.connect)}
          </tbody></table></div></section>
        <section className="panel history-panel" aria-labelledby="fills-h"><div className="panel-head"><h2 id="fills-h" className="panel-title">{t.fills}</h2><Icon name="activity" size={17} /></div><div className="scroll"><table><thead><tr><th>{zh ? "时间" : "Time"}</th><th className="r">{t.price}</th><th>{zh ? "卖→买" : "Seller→Buyer"}</th><th>tx</th></tr></thead><tbody data-testid="fills">
          {view?.fills.length ? view.fills.slice(0, 12).map((f) => <tr key={f.tx + f.seller + f.ts}><td className="dim">{Fmt.time(f.ts)}</td><td className="r up">{Fmt.n(f.price, 4)}</td><td className="mono dim">{Fmt.addr(f.seller)} → {Fmt.addr(f.buyer)}</td><td><a className="transaction-link" href={`https://bscscan.com/tx/${f.tx}`} target="_blank" rel="noreferrer">{f.tx.slice(0, 10)}<Icon name="external" size={11} /></a></td></tr>) : empty(4, none)}
        </tbody></table></div></section>
      </div>
    </>
  );
}

export default function TradePanel() {
  return <Shell active="/trade" title={{ zh: "交易", en: "Trade" }} sub={{ zh: "链上 NFT 买单市场 · 用 USDT 挂单或出售藏品", en: "On-chain NFT bid market · Place USDT bids or sell your collection" }}>{(lang) => <Trade lang={lang} />}</Shell>;
}
