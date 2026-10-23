"use client";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { WalletConfig } from "@/lib/wagmi";
import { Icon } from "./icons";

/** Wallet gate: ok only when connected on BSC (chainId 56). Every write in the app checks this first. */
export function useWalletGate() {
  const { address, chainId, isConnected } = useAccount();
  const wrongChain = isConnected && chainId !== WalletConfig.chain.id;
  return { address, chainId, isConnected, wrongChain, ok: isConnected && !wrongChain && !!address };
}

export function WalletButton({ lang }: { lang: "zh" | "en" }) {
  const zh = lang === "zh";
  const { address, chainId, isConnected, wrongChain } = useWalletGate();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  if (!isConnected) {
    const c = connectors[0];
    return (
      <span className="wallet">
        <button className="btn primary" data-testid="connect" disabled={!c || isPending} onClick={() => c && connect({ connector: c, chainId: WalletConfig.chain.id })}>
          {isPending ? <span className="spin" aria-hidden /> : <Icon name="wallet" size={17} />}{isPending ? (zh ? "等待钱包确认…" : "Confirm in wallet…") : zh ? "连接钱包" : "Connect wallet"}
        </button>
        {error ? <span className="err" role="alert">{error.message.split("\n")[0]}</span> : null}
      </span>
    );
  }
  return (
    <span className="wallet" data-testid="wallet">
      <span className={`chip ${wrongChain ? "bad" : ""}`}><span className={`dot ${wrongChain ? "err" : ""}`} aria-hidden />{wrongChain ? (zh ? `错误网络 (${chainId})` : `Wrong network (${chainId})`) : "BSC · 56"}</span>
      <span className="chip mono" title={address}>{address?.slice(0, 6)}…{address?.slice(-4)}</span>
      {wrongChain ? <button className="btn on" onClick={() => switchChain({ chainId: WalletConfig.chain.id })}>{zh ? "切换到 BSC" : "Switch to BSC"}</button> : null}
      <button className="btn ghost sm" onClick={() => disconnect()}>{zh ? "断开" : "Disconnect"}</button>
    </span>
  );
}

/** Banner shown wherever a transaction could be started while the wallet is on the wrong chain. */
export function ChainGuard({ lang }: { lang: "zh" | "en" }) {
  const { wrongChain } = useWalletGate();
  if (!wrongChain) return null;
  return <div className="banner error" role="alert" data-testid="wrong-chain">{lang === "zh" ? "钱包不在 BSC 网络，交易已阻止。请切换到 BSC (chainId 56)。" : "Wallet is not on BSC. Transactions are blocked. Switch to BSC (chainId 56)."}</div>;
}
