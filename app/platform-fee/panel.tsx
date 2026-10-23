"use client";
import { useRef, useState } from "react";
import { formatEther, type Address, type Hash } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { Shell } from "@/components/shell";
import { useWalletGate } from "@/components/wallet";
import { Contracts } from "@/lib/contracts";
import { PLATFORM_FEE_RECIPIENT, platformFeeRouterAddress } from "@/lib/platform-fee";
import { PLATFORM_FEE_SOURCE_HASH } from "@/lib/platform-fee-runtime";
import { preparePlatformDeployment, type RouterArtifact } from "@/lib/platform-deployment";

function Deployment() {
  const gate = useWalletGate();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const current = useRef({ address: gate.address, ok: gate.ok });
  current.current = { address: gate.address, ok: gate.ok };
  const [phase, setPhase] = useState<"idle" | "preparing" | "signing" | "pending" | "complete">("idle");
  const [prepared, setPrepared] = useState<{ artifact: RouterArtifact; account: Address; cost: bigint }>();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<Hash>();
  const [receipt, setReceipt] = useState<{ address: Address; block: bigint }>();
  let configured: Address | undefined;
  let configError = false;
  try { configured = platformFeeRouterAddress(); } catch { configError = true; }
  const busy = phase === "preparing" || phase === "signing" || phase === "pending";
  const valid = gate.ok && !!wallet && !!client && !configured && !configError && !receipt;
  const assertContext = async (account: Address) => {
    if (!current.current.ok || current.current.address?.toLowerCase() !== account.toLowerCase() || !wallet || !client || await wallet.getChainId() !== 56 || await client.getChainId() !== 56) throw new Error("钱包或网络已改变，请重新核对");
    const [connected] = await wallet.getAddresses();
    if (connected?.toLowerCase() !== account.toLowerCase()) throw new Error("钱包账号已改变，请重新核对");
  };
  const prepare = async () => {
    if (!valid || busy || !gate.address || !client) return;
    const account = gate.address;
    setError(undefined); setPrepared(undefined); setChecked(false); setPhase("preparing");
    try {
      await assertContext(account);
      const artifact = (await import("@/lib/platform-fee-bytecode.json")).default as RouterArtifact;
      const estimate = await preparePlatformDeployment(client, account, artifact);
      await assertContext(account);
      setPrepared({ artifact, account, cost: estimate.estimatedCost });
    } catch (e) { setError(e instanceof Error ? e.message.split("\n")[0] : "无法估算部署费用"); }
    finally { setPhase("idle"); }
  };
  const deploy = async () => {
    if (!valid || busy || !prepared || !checked || !client || !wallet) return;
    setError(undefined); setHash(undefined); setPhase("preparing");
    try {
      await assertContext(prepared.account);
      // Fresh simulation/estimate before presenting the transaction in the user's wallet.
      await preparePlatformDeployment(client, prepared.account, prepared.artifact);
      await assertContext(prepared.account);
      setPhase("signing");
      const txHash = await wallet.deployContract({ account: prepared.account, chain: wallet.chain, abi: prepared.artifact.abi, bytecode: prepared.artifact.bytecode, value: 0n });
      setHash(txHash); setPhase("pending");
      const result = await client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 2000, confirmations: 3 });
      if (result.status !== "success" || !result.contractAddress) throw new Error("部署未成功，请在 BscScan 核对交易");
      setReceipt({ address: result.contractAddress, block: result.blockNumber }); setPhase("complete");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "部署未完成"); setPhase("idle");
    }
  };
  const accountMatches = prepared?.account.toLowerCase() === gate.address?.toLowerCase();
  return <section className="panel" style={{ maxWidth: 900, margin: "0 auto", padding: 28 }}>
    <span className="eyebrow">SELLER FEE ROUTER</span>
    <h2>平台手续费合约部署</h2>
    <p className="muted">卖方额外支付成交额的 0.5%，买方不支付平台费。原市场手续费另计。合约部署后，还需核验并配置网站，平台费才会启用。</p>
    <dl style={{ display: "grid", gap: 16, margin: "28px 0" }}>
      <div><dt className="muted">网络</dt><dd>BSC 主网 · Chain ID 56</dd></div>
      <div><dt className="muted">平台费收款地址（固定）</dt><dd style={{ overflowWrap: "anywhere" }}><a className="mono" href={`https://bscscan.com/address/${PLATFORM_FEE_RECIPIENT}`} target="_blank" rel="noopener noreferrer">{PLATFORM_FEE_RECIPIENT}</a></dd></div>
      <div><dt className="muted">原市场合约（固定）</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{Contracts.market}</dd></div>
      <div><dt className="muted">结算示例</dt><dd>成交 100 USDT，原市场费 1 USDT，平台费 0.5 USDT，卖方实收 98.5 USDT。买方不额外支付。</dd></div>
      <div><dt className="muted">部署转账金额</dt><dd>0 BNB，仅支付网络 Gas；不需要 USDT 或 NFT 授权。</dd></div>
      <div><dt className="muted">已审核源码摘要</dt><dd className="mono" style={{ overflowWrap: "anywhere", fontSize: 12 }}>{PLATFORM_FEE_SOURCE_HASH}</dd></div>
    </dl>
    <p className="muted">税率、收款地址及资产地址均不可更改；无升级、管理员提币或任意调用入口。仅通过该合约完成的卖出收取平台费。</p>
    {configured ? <div className="banner" role="status">网站已配置合约：<span className="mono" style={{ overflowWrap: "anywhere" }}>{configured}</span>。无需重复部署。</div> : configError ? <div className="banner error" role="alert">网站合约配置无效，部署操作已阻止。</div> : null}
    {!gate.ok ? <div className="banner">请通过右上角连接钱包，并切换到 BSC 主网。</div> : null}
    {!receipt ? <>
      <button className="btn" onClick={prepare} disabled={!valid || busy} data-testid="prepare-deploy">{phase === "preparing" ? "正在核对…" : "核对并估算部署 Gas"}</button>
      {prepared && accountMatches ? <div style={{ marginTop: 20 }}>
        <p>预计 Gas 费用：约 <b className="gold">{formatEther(prepared.cost)} BNB</b>，实际费用以钱包显示为准。</p>
        <label style={{ display: "flex", gap: 10, margin: "18px 0", alignItems: "start" }}><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} />我已核对网络、0.5% 卖方费率和收款地址，同意由当前钱包部署固定配置合约。</label>
        <button className="btn primary" onClick={deploy} disabled={!valid || busy || !checked} data-testid="deploy-router">{phase === "signing" ? "请在钱包确认部署" : phase === "pending" ? "等待链上确认…" : "在钱包中部署合约"}</button>
      </div> : null}
    </> : <div className="banner" role="status" style={{ display: "block" }}><b className="up">合约部署已确认，平台费尚未启用</b><p style={{ overflowWrap: "anywhere" }}>合约地址：<span className="mono">{receipt.address}</span><br />部署区块：{receipt.block.toString()}</p><p>请将合约地址和下方交易链接发回当前聊天。完成链上核验、网站配置和发布后才启用收费。</p></div>}
    {hash ? <p style={{ overflowWrap: "anywhere" }}><a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noopener noreferrer">在 BscScan 查看部署交易：{hash}</a></p> : null}
    {error ? <p className="err" role="alert">{error}</p> : null}
  </section>;
}

export default function DeploymentPanel() {
  return <Shell title={{ zh: "部署平台手续费", en: "Deploy platform fee" }} active="/trade">{() => <Deployment />}</Shell>;
}
