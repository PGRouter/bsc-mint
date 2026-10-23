"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useBalance, usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { TxErrors } from "@/lib/tx";
import { Fmt } from "@/lib/fmt";
import { Icon } from "@/components/icons";

type Pay = "usdt" | "bnb";

function RelicArtwork() {
  return (
    <svg className="relic-artwork" viewBox="0 0 400 260" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="relic-face" x1="148" y1="52" x2="250" y2="214" gradientUnits="userSpaceOnUse"><stop stopColor="#FFE991" /><stop offset=".48" stopColor="#F0B90B" /><stop offset="1" stopColor="#9F7107" /></linearGradient>
        <linearGradient id="relic-side" x1="249" y1="64" x2="220" y2="211" gradientUnits="userSpaceOnUse"><stop stopColor="#B2830C" /><stop offset="1" stopColor="#59430F" /></linearGradient>
        <radialGradient id="relic-aura"><stop stopColor="#F0B90B" stopOpacity=".14" /><stop offset="1" stopColor="#F0B90B" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="200" cy="134" rx="163" ry="118" fill="url(#relic-aura)" />
      <ellipse cx="200" cy="218" rx="88" ry="14" fill="#F0B90B" fillOpacity=".04" stroke="#F0B90B" strokeOpacity=".16" />
      <ellipse cx="200" cy="218" rx="117" ry="25" stroke="#848E9C" strokeOpacity=".13" />
      <path d="M35 218H365M90 247L166 194M310 247L234 194M200 194V252" stroke="#848E9C" strokeOpacity=".12" />
      <circle cx="200" cy="124" r="99" stroke="#F0B90B" strokeOpacity=".14" strokeDasharray="2 8" />
      <path d="M200 26V41M200 208V223M102 124H117M283 124H298" stroke="#F0B90B" strokeOpacity=".45" />
      <path d="M200 48L260 87V158L200 207L140 168V97L200 48Z" fill="url(#relic-side)" stroke="#F0B90B" strokeOpacity=".6" />
      <path d="M200 48L242 78L182 128L140 97L200 48Z" fill="#FFE89A" />
      <path d="M140 97L182 128V198L140 168V97Z" fill="#AF8009" />
      <path d="M182 128L242 78V149L182 198V128Z" fill="url(#relic-face)" />
      <path d="M242 78L260 87V158L242 149V78Z" fill="#8B650B" />
      <path d="M182 198L242 149L260 158L200 207L182 198Z" fill="#654C11" />
      <path d="M164 102L201 71L220 83L183 114L164 102Z" fill="#0B0E11" fillOpacity=".9" />
      <path d="M195 136L229 108V122L209 139V151L229 134V148L195 176V136Z" fill="#3E300D" />
      <path d="M140 97L182 128L242 78M182 128V198M200 48L242 78" stroke="#FFF1BC" strokeOpacity=".55" />
      <circle cx="101" cy="94" r="3" fill="#F0B90B" /><circle cx="291" cy="164" r="2" fill="#F0B90B" fillOpacity=".55" />
      <path d="M68 158H104M86 140V176M303 75H323M313 65V85" stroke="#F0B90B" strokeOpacity=".22" />
    </svg>
  );
}

const T = {
  zh: { title: "铸造", status: "铸造状态", open: "进行中", notStarted: "未开始", soldOut: "已售罄", minted: "已公开铸造", handle: ".ai Agent ID", none: "未注册：铸造需要已注册的 .ai Agent ID（每个 ID 共享 USDT/BNB 额度）", quota: "剩余额度", count: "数量", pay: "支付方式",
    cost: "费用", gas: "Gas 预估", allowance: "当前授权", approve: "授权 USDT（仅本次所需）", mint: "铸造", mintBnb: "用 BNB 铸造", connect: "请先连接钱包", yourRelics: "你的 Relic 数量", startAt: "开始时间", balance: "余额" },
  en: { title: "Mint", status: "Mint status", open: "open", notStarted: "not started", soldOut: "sold out", minted: "Public minted", handle: ".ai Agent ID", none: "Not registered: minting requires a registered .ai Agent ID (USDT and BNB mints share its quota)", quota: "Remaining quota", count: "Count", pay: "Pay with",
    cost: "Cost", gas: "Gas estimate", allowance: "Current allowance", approve: "Approve USDT (exact amount only)", mint: "Mint", mintBnb: "Mint with BNB", connect: "Connect a wallet first", yourRelics: "Your relics", startAt: "Starts", balance: "Balance" },
} as const;

function Mint({ lang }: { lang: Lang }) {
  const t = T[lang];
  const { address, ok } = useWalletGate();
  const pc = usePublicClient();
  const { data: wallet } = useWalletClient();
  const [n, setN] = useState(1);
  const [pay, setPay] = useState<Pay>("usdt");
  const [gas, setGas] = useState<bigint>();
  const acct = address ?? "0x0000000000000000000000000000000000000000";
  const g = { address: Contracts.game } as const;
  const { data, refetch } = useReadContracts({ allowFailure: true, contracts: [
    { ...g, abi: Contracts.gameAbi, functionName: "publicMinted" },
    { ...g, abi: Contracts.gameAbi, functionName: "publicCap" },
    { ...g, abi: Contracts.gameAbi, functionName: "mintStartTime" },
    { ...g, abi: Contracts.gameAbi, functionName: "requireHandle" },
    { ...g, abi: Contracts.gameAbi, functionName: "config" },
    { address: Contracts.handleRegistry, abi: Contracts.registryAbi, functionName: "handleOf", args: [acct] },
    { ...g, abi: Contracts.mintAbi, functionName: "quote", args: [acct, n] },
    { ...g, abi: Contracts.mintAbi, functionName: "quoteBnb", args: [acct, n] },
    { address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "allowance", args: [acct, Contracts.game] },
    { address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "balanceOf", args: [acct] },
    { address: Contracts.relic, abi: Contracts.erc721Abi, functionName: "balanceOf", args: [acct] },
  ] });
  const { data: bnb } = useBalance({ address });
  const v = <T,>(i: number) => data?.[i]?.result as T | undefined;
  const [minted, cap, start, requireHandle, cfg, handle, quote, quoteBnb, allowance, usdtBal, relics] =
    [v<bigint>(0), v<bigint>(1), v<bigint>(2), v<boolean>(3), v<{ perHandle: number }>(4), v<string>(5), v<readonly [bigint, number]>(6), v<readonly [bigint, number]>(7), v<bigint>(8), v<bigint>(9), v<bigint>(10)];
  const onDone = useCallback(() => { refetch(); }, [refetch]);
  const tx = useTx(onDone);
  const now = Math.floor(Date.now() / 1000);
  const status = minted !== undefined && cap !== undefined && minted >= cap ? t.soldOut : start && Number(start) > now ? t.notStarted : t.open;
  const cost = pay === "usdt" ? quote?.[0] : quoteBnb?.[0];
  const quoteErr = data?.[pay === "usdt" ? 6 : 7]?.error;
  const needApprove = pay === "usdt" && cost !== undefined && (allowance ?? 0n) < cost;
  const blocked = !ok || !wallet || !address || tx.busy || cost === undefined;

  const approve = () => tx.run(t.approve,
    () => pc!.simulateContract({ account: address, address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "approve", args: [Contracts.game, cost!] }),
    () => wallet!.writeContract({ account: address!, chain: wallet!.chain, address: Contracts.usdt, abi: Contracts.erc20Abi, functionName: "approve", args: [Contracts.game, cost!] }));
  const mint = () => tx.run(t.mint,
    () => pc!.simulateContract({ account: address, address: Contracts.game, abi: Contracts.mintAbi, functionName: "mint", args: [n] }),
    () => wallet!.writeContract({ account: address!, chain: wallet!.chain, address: Contracts.game, abi: Contracts.mintAbi, functionName: "mint", args: [n] }));
  const mintBnb = () => tx.run(t.mintBnb,
    () => pc!.call({ account: address, to: Contracts.game, value: cost!, data: "0x" }),
    () => wallet!.sendTransaction({ account: address!, chain: wallet!.chain, to: Contracts.game, value: cost!, data: "0x" }));
  useEffect(() => {
    let cancelled = false;
    setGas(undefined);
    if (pay !== "bnb" || !pc || !address || cost === undefined) return;
    Promise.all([
      pc.estimateGas({ account: address, to: Contracts.game, value: cost, data: "0x" }),
      pc.getGasPrice(),
    ]).then(([gl, gp]) => { if (!cancelled) setGas(gl * gp); })
      .catch(() => { if (!cancelled) setGas(undefined); });
    return () => { cancelled = true; };
  }, [pc, address, pay, cost, n]);

  const pct = minted !== undefined && cap ? Number(minted) / Number(cap) : 0;
  const costTxt = cost === undefined ? "-" : pay === "usdt" ? `${Fmt.units(cost, 18, 6)} USDT` : `${Fmt.units(cost, 18, 6)} BNB`;
  const zh = lang === "zh";
  return (
    <div className="mint-layout">
      <section className="panel mint-overview" data-testid="mint-status" aria-labelledby="mint-status-h">
        <div className="panel-head">
          <span className="section-label"><Icon name="layers" size={14} /> {zh ? "公开铸造" : "Public mint"}</span>
          <span className={`chip mint-status-chip ${status === t.soldOut ? "bad" : ""}`}>{minted === undefined || cap === undefined || start === undefined ? "-" : status}</span>
        </div>
        <div className="mint-collection">
          <span className="mint-eyebrow">BNB CHAIN COLLECTION</span>
          <h2 id="mint-status-h">RELICS<span className="gold">.</span></h2>
          <p>{zh ? "从一枚 RELIC，开始你的链上收藏。" : "Your on-chain collection starts with a RELIC."}</p>
        </div>
        <div className="mint-art"><RelicArtwork /><span className="mint-art-caption">RELIC · ERC-721</span></div>
        <div className="mint-progress">
          <div className="mint-progress-label"><span>{t.minted}</span><b className="num gold">{minted !== undefined && cap ? Fmt.pct(pct) : "-"}</b></div>
          <div className="mint-progress-value num">{minted !== undefined ? Fmt.n(Number(minted), 0) : <span className="sk" />}<small>/ {cap !== undefined ? Fmt.n(Number(cap), 0) : "-"}</small></div>
          <div className="progress" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t.minted}><i style={{ width: Fmt.pct(pct) }} /></div>
        </div>
        <dl className="kv mint-facts">
          <dt>{t.startAt}</dt><dd>{start ? new Date(Number(start) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-"}</dd>
          <dt>{t.handle}</dt><dd>{requireHandle === undefined ? "-" : requireHandle ? (zh ? "必需" : "Required") : (zh ? "不需要" : "Not required")}</dd>
          <dt>{t.yourRelics}</dt><dd data-testid="my-relics">{address ? relics?.toString() ?? "-" : "-"}</dd>
        </dl>
      </section>
      <section className="panel mint-form" aria-labelledby="mint-h">
        <div className="panel-head"><div><span className="section-label">MINT RELICS</span><h2 id="mint-h" className="panel-title">{zh ? "铸造 RELIC" : "Mint a RELIC"}</h2></div><span className="network-tag"><i /> BNB Chain</span></div>
        <p className="panel-description">{zh ? "选择数量和支付资产，费用以当前链上报价为准。" : "Choose your quantity and payment asset. The current on-chain quote applies."}</p>
        {!address ? (
          <div className="mint-empty"><span className="empty-icon"><Icon name="wallet" size={22} /></span><div><b>{t.connect}</b><p>{zh ? "通过右上角连接钱包，查看你的额度并确认铸造。" : "Connect using the wallet control above to view your quota and confirm your mint."}</p></div></div>
        ) : (
          <div data-testid="handle" className={`callout handle-callout ${handle ? "" : requireHandle ? "bad" : ""}`}><span>{t.handle}</span>{handle ? <b className="gold">{handle.endsWith(".ai") ? handle : `${handle}.ai`}</b> : <span className="err">{requireHandle ? t.none : "-"}</span>}</div>
        )}
        <div className="row mint-quota"><span className="muted">{t.quota}</span><b className="num">{address ? quote?.[1] ?? "-" : "-"} <span className="dim">/ {cfg?.perHandle ?? "-"}</span></b></div>
        <div className="mint-field"><span className="field-label">{t.count}</span><span className="tabs mint-quantity" role="group" aria-label={t.count}>{Array.from({ length: cfg?.perHandle ?? 4 }, (_, i) => i + 1).map((k) => <button key={k} aria-pressed={k === n} className={`btn ${k === n ? "on" : ""}`} onClick={() => setN(k)}>{k}</button>)}</span></div>
        <div className="mint-field"><span className="field-label">{t.pay}</span><span className="tabs mint-payment" role="group" aria-label={t.pay}><button data-testid="pay-usdt" aria-pressed={pay === "usdt"} className={`btn ${pay === "usdt" ? "on" : ""}`} onClick={() => setPay("usdt")}>USDT</button><button data-testid="pay-bnb" aria-pressed={pay === "bnb"} className={`btn ${pay === "bnb" ? "on" : ""}`} onClick={() => setPay("bnb")}>BNB</button></span></div>
        <dl className="kv order-summary mint-cost" data-testid="cost">
          <dt>{t.cost}</dt><dd className="summary-total"><b>{address ? costTxt : "-"}</b></dd>
          {pay === "usdt" ? <><dt>{t.allowance}</dt><dd>{address ? Fmt.units(allowance) : "-"}</dd><dt>{t.balance}</dt><dd>{address ? Fmt.units(usdtBal) : "-"} USDT</dd></>
            : <><dt>{t.gas}</dt><dd>{gas !== undefined ? `≈ ${Fmt.units(gas, 18, 6)} BNB` : "-"}</dd><dt>{t.balance}</dt><dd>{bnb ? Fmt.units(bnb.value, 18, 4) : "-"} BNB</dd></>}
        </dl>
        {address && quoteErr ? <p className="step-err" role="alert" data-testid="quote-error">{zh ? "暂时无法铸造" : "Mint unavailable"}: {TxErrors.reason(quoteErr)}</p> : null}
        <div className="mint-action">
          {pay === "usdt"
            ? (address && needApprove ? <button className="btn primary block" data-testid="approve" disabled={blocked} onClick={approve}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
              : <button className="btn primary block" data-testid="mint" disabled={blocked} onClick={mint}>{t.mint} ×{n}</button>)
            : <button className="btn primary block" data-testid="mint-bnb" disabled={blocked} onClick={mintBnb}>{t.mintBnb} ×{n}</button>}
        </div>
        <p className="note mint-note"><Icon name="check" size={14} />{zh ? "仅授权本次所需金额，每笔交易由你的钱包确认。" : "Approve only the amount needed. Confirm each transaction in your own wallet."}</p>
        <TxStatus tx={tx} lang={lang} />
      </section>
    </div>
  );
}

export default function MintPanel() {
  return <Shell active="/mint" title={{ zh: "铸造", en: "Mint" }} sub={{ zh: "公开铸造 RELIC · 支持 USDT 与 BNB · 每笔交易由你的钱包确认", en: "Public RELIC mint · Pay with USDT or BNB · Confirm each transaction in your wallet" }}>{(lang) => <Mint lang={lang} />}</Shell>;
}
