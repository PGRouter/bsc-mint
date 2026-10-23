"use client";
import { useCallback, useState } from "react";
import { formatUnits } from "viem";
import { useBalance, usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { TxErrors } from "@/lib/tx";
import { Fmt } from "@/lib/fmt";

type Pay = "usdt" | "bnb";

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
    async () => {
      await pc!.call({ account: address, to: Contracts.game, value: cost!, data: "0x" });
      const [gl, gp] = await Promise.all([pc!.estimateGas({ account: address, to: Contracts.game, value: cost!, data: "0x" }), pc!.getGasPrice()]);
      setGas(gl * gp);
    },
    () => wallet!.sendTransaction({ account: address!, chain: wallet!.chain, to: Contracts.game, value: cost!, data: "0x" }));
  const estimate = async () => {
    if (!pc || !address || cost === undefined) return;
    try { const [gl, gp] = await Promise.all([pc.estimateGas({ account: address, to: Contracts.game, value: cost, data: "0x" }), pc.getGasPrice()]); setGas(gl * gp); } catch { setGas(undefined); }
  };

  const pct = minted !== undefined && cap ? Number(minted) / Number(cap) : 0;
  const costTxt = cost === undefined ? "-" : pay === "usdt" ? `${Fmt.units(cost, 18, 6)} USDT` : `${Fmt.units(cost, 18, 6)} BNB`;
  return (
    <div className="grid2">
      <section className="panel" data-testid="mint-status" aria-labelledby="mint-status-h">
        <h2 id="mint-status-h">{t.status} <span className={`chip ${status === t.soldOut ? "bad" : ""}`}>{status}</span></h2>
        <div className="card" style={{ padding: 0, border: 0, background: "none" }}>
          <div className="k">{t.minted}</div>
          <div className="v">{minted !== undefined ? Fmt.n(Number(minted), 0) : <span className="sk" />}<small>/ {cap !== undefined ? Fmt.n(Number(cap), 0) : "-"}</small></div>
          <div className="progress" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t.minted}><i style={{ width: Fmt.pct(pct) }} /></div>
        </div>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>{t.startAt}</dt><dd>{start ? new Date(Number(start) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-"}</dd>
          <dt>{t.handle}</dt><dd>{requireHandle === undefined ? "-" : requireHandle ? (lang === "zh" ? "必需" : "required") : (lang === "zh" ? "不需要" : "not required")}</dd>
          <dt>{t.yourRelics}</dt><dd data-testid="my-relics">{address ? relics?.toString() ?? "-" : "-"}</dd>
        </dl>
      </section>
      <section className="panel" aria-labelledby="mint-h">
        <h2 id="mint-h">{t.mint}</h2>
        {!address ? <p className="muted">{t.connect}</p> : (
          <>
            <div data-testid="handle" className={`callout ${handle ? "" : requireHandle ? "bad" : ""}`}>{t.handle}: {handle ? <b className="gold">{handle.endsWith(".ai") ? handle : `${handle}.ai`}</b> : <span className="err">{requireHandle ? t.none : "-"}</span>}</div>
            <div className="row"><span className="muted">{t.quota}</span><b className="num">{quote?.[1] ?? "-"} / {cfg?.perHandle ?? "-"}</b></div>
            <div className="row"><span className="muted">{t.count}</span><span className="tabs" role="group" aria-label={t.count}>{Array.from({ length: cfg?.perHandle ?? 4 }, (_, i) => i + 1).map((k) => <button key={k} aria-pressed={k === n} className={`btn ${k === n ? "on" : ""}`} onClick={() => { setN(k); setGas(undefined); }}>{k}</button>)}</span></div>
            <div className="row"><span className="muted">{t.pay}</span><span className="tabs" role="group" aria-label={t.pay}><button data-testid="pay-usdt" aria-pressed={pay === "usdt"} className={`btn ${pay === "usdt" ? "on" : ""}`} onClick={() => setPay("usdt")}>USDT</button><button data-testid="pay-bnb" aria-pressed={pay === "bnb"} className={`btn ${pay === "bnb" ? "on" : ""}`} onClick={() => { setPay("bnb"); estimate(); }}>BNB</button></span></div>
            <dl className="kv" data-testid="cost">
              <dt>{t.cost}</dt><dd><b>{costTxt}</b></dd>
              {pay === "usdt" ? <><dt>{t.allowance}</dt><dd>{Fmt.units(allowance)}</dd><dt>{t.balance}</dt><dd>{Fmt.units(usdtBal)} USDT</dd></>
                : <><dt>{t.gas}</dt><dd>{gas !== undefined ? `≈ ${Fmt.units(gas, 18, 6)} BNB` : "-"}</dd><dt>{t.balance}</dt><dd>{bnb ? Fmt.units(bnb.value, 18, 4) : "-"} BNB</dd></>}
            </dl>
            {quoteErr ? <p className="err" role="alert" data-testid="quote-error">{lang === "zh" ? "链上预检失败" : "On-chain precheck reverted"}: {TxErrors.reason(quoteErr)}</p> : null}
            <div className="row">
              {pay === "usdt"
                ? (needApprove ? <button className="btn primary" data-testid="approve" disabled={blocked} onClick={approve}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
                  : <button className="btn primary" data-testid="mint" disabled={blocked} onClick={mint}>{t.mint} ×{n}</button>)
                : <button className="btn primary" data-testid="mint-bnb" disabled={blocked} onClick={mintBnb}>{t.mintBnb} ×{n}</button>}
            </div>
            <TxStatus tx={tx} lang={lang} />
          </>
        )}
      </section>
    </div>
  );
}

export default function MintPanel() {
  return <Shell active="/mint" title={{ zh: "铸造", en: "Mint" }} sub={{ zh: "需要已注册的 .ai Agent ID · 你在自己的钱包中签名每一笔交易", en: "Requires a registered .ai Agent ID · you sign every transaction in your own wallet" }}>{(lang) => <Mint lang={lang} />}</Shell>;
}
