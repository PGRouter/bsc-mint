"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ChainGuard, WalletButton } from "./wallet";

export type Lang = "zh" | "en";

/** Page frame for the transaction pages: nav, language toggle, wallet, wrong-chain guard. */
export function Shell({ title, children }: { title: Record<Lang, string>; children: (lang: Lang) => React.ReactNode }) {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  const q = `?lang=${lang}`;
  return (
    <div className="wrap">
      <header>
        <div><div className="title">{title[lang]}</div>
          <nav><Link href={`/${q}`}>{lang === "zh" ? "监控" : "Monitor"}</Link><Link href={`/mint${q}`}>{lang === "zh" ? "铸造" : "Mint"}</Link><Link href={`/trade${q}`}>{lang === "zh" ? "交易" : "Trade"}</Link></nav></div>
        <div className="status">
          <button className="btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "EN" : "中文"}</button>
          <WalletButton lang={lang} />
        </div>
      </header>
      <ChainGuard lang={lang} />
      {children(lang)}
    </div>
  );
}
