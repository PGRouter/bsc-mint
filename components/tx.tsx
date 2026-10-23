"use client";
import { useCallback, useState } from "react";
import type { Hash } from "viem";
import { usePublicClient } from "wagmi";
import { TxErrors, type TxPhase } from "@/lib/tx";

/**
 * One transaction at a time: simulate (eth_call) -> wallet signature -> submitted -> receipt.
 * The button is locked while busy, so a tx cannot be submitted twice.
 */
export function useTx(onDone?: () => void) {
  const pc = usePublicClient();
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<string>();
  const [label, setLabel] = useState("");
  const busy = phase === "simulating" || phase === "signing" || phase === "submitted";

  const run = useCallback(async (name: string, simulate: () => Promise<unknown>, send: () => Promise<Hash>) => {
    if (busy || !pc) return;
    setLabel(name); setHash(undefined); setError(undefined);
    setPhase("simulating");
    try { await simulate(); } catch (e) { setError(TxErrors.reason(e)); setPhase("failed"); return; }
    setPhase("signing");
    let h: Hash;
    try { h = await send(); } catch (e) {
      if (TxErrors.isRejected(e)) { setPhase("rejected"); return; }
      setError(TxErrors.reason(e)); setPhase("failed"); return;
    }
    setHash(h); setPhase("submitted");
    try {
      const r = await pc.waitForTransactionReceipt({ hash: h });
      if (r.status === "success") setPhase("success"); else { setError("reverted on-chain"); setPhase("failed"); }
    } catch (e) { setError(TxErrors.reason(e)); setPhase("failed"); }
    onDone?.();
  }, [busy, pc, onDone]);

  return { phase, hash, error, label, busy, run, reset: () => setPhase("idle") };
}

const TEXT = {
  zh: { simulating: "模拟中…", signing: "待签：请在钱包中确认", submitted: "已提交，等待上链", success: "成功", failed: "失败", rejected: "已拒签（未上链）" },
  en: { simulating: "Simulating…", signing: "Waiting for signature in wallet", submitted: "Submitted, waiting for confirmation", success: "Success", failed: "Failed", rejected: "Rejected (nothing sent)" },
} as const;

export function TxStatus({ tx, lang }: { tx: ReturnType<typeof useTx>; lang: "zh" | "en" }) {
  if (tx.phase === "idle") return null;
  const cls = tx.phase === "success" ? "up" : tx.phase === "failed" || tx.phase === "rejected" ? "err" : "muted";
  return (
    <div className="txstatus" data-testid="tx-status" data-phase={tx.phase}>
      <b>{tx.label}</b>: <span className={cls}>{TEXT[lang][tx.phase]}</span>
      {tx.error ? <span className="err"> — {tx.error}</span> : null}
      {tx.hash ? <> · <a href={`https://bscscan.com/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="mono">{tx.hash.slice(0, 14)}…</a></> : null}
    </div>
  );
}
