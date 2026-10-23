"use client";
import { useCallback, useState } from "react";
import { formatEther, formatUnits } from "viem";
import { useBalance, usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { Shell, type Lang } from "@/components/shell";
import { TxStatus, useTx } from "@/components/tx";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { TxErrors } from "@/lib/tx";

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

  return (
    <div className="grid2">
      <div className="panel" data-testid="mint-status">
        <h3>{t.status}</h3>
        <table><tbody>
          <tr><td>{t.status}</td><td>{status}</td></tr>
          <tr><td>{t.minted}</td><td>{minted?.toLocaleString() ?? "-"} / {cap?.toLocaleString() ?? "-"}</td></tr>
          <tr><td>{t.startAt}</td><td>{start ? new Date(Number(start) * 1000).toISOString().replace(".000", "") : "-"}</td></tr>
          <tr><td>requireHandle()</td><td>{String(requireHandle ?? "-")}</td></tr>
          <tr><td>{t.yourRelics}</td><td data-testid="my-relics">{address ? relics?.toString() ?? "-" : "-"}</td></tr>
        </tbody></table>
      </div>
      <div className="panel">
        <h3>{t.mint}</h3>
        {!address ? <p className="muted">{t.connect}</p> : (
          <>
            <p data-testid="handle">{t.handle}: {handle ? <b className="up">{handle.endsWith(".ai") ? handle : `${handle}.ai`}</b> : <span className="err">{requireHandle ? t.none : "-"}</span>}</p>
            <p>{t.quota}: {quote?.[1] ?? "-"} / {cfg?.perHandle ?? "-"}</p>
            <p>{t.count}: {Array.from({ length: cfg?.perHandle ?? 4 }, (_, i) => i + 1).map((k) => <button key={k} className={`btn ${k === n ? "on" : ""}`} onClick={() => { setN(k); setGas(undefined); }}>{k}</button>)}
              {" "}{t.pay}: <button data-testid="pay-usdt" className={`btn ${pay === "usdt" ? "on" : ""}`} onClick={() => setPay("usdt")}>USDT</button> <button data-testid="pay-bnb" className={`btn ${pay === "bnb" ? "on" : ""}`} onClick={() => { setPay("bnb"); estimate(); }}>BNB</button></p>
            <p data-testid="cost">{t.cost}: <b>{cost === undefined ? "-" : pay === "usdt" ? `${formatUnits(cost, 18)} USDT` : `${formatEther(cost)} BNB`}</b>
              {pay === "usdt" ? <span className="muted"> · {t.allowance} {allowance !== undefined ? formatUnits(allowance, 18) : "-"} · {t.balance} {usdtBal !== undefined ? formatUnits(usdtBal, 18) : "-"}</span>
                : <span className="muted"> · {t.gas} {gas !== undefined ? `≈ ${formatEther(gas)} BNB` : "-"} · {t.balance} {bnb ? formatEther(bnb.value) : "-"}</span>}</p>
            {quoteErr ? <p className="err" data-testid="quote-error">{lang === "zh" ? "链上预检失败" : "On-chain precheck reverted"}: {TxErrors.reason(quoteErr)}</p> : null}
            {pay === "usdt"
              ? (needApprove ? <button className="btn on" data-testid="approve" disabled={blocked} onClick={approve}>{t.approve}: {cost !== undefined ? formatUnits(cost, 18) : "-"} USDT</button>
                : <button className="btn on" data-testid="mint" disabled={blocked} onClick={mint}>{t.mint} ×{n}</button>)
              : <button className="btn on" data-testid="mint-bnb" disabled={blocked} onClick={mintBnb}>{t.mintBnb} ×{n}</button>}
            <TxStatus tx={tx} lang={lang} />
          </>
        )}
      </div>
    </div>
  );
}

export default function MintPanel() {
  return <Shell title={{ zh: "铸造", en: "Mint" }}>{(lang) => <Mint lang={lang} />}</Shell>;
}
