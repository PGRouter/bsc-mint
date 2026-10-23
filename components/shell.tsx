"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ChainGuard, WalletButton } from "./wallet";

export type Lang = "zh" | "en";
type Page = "/" | "/mint" | "/trade";
const NAV: [Page, Record<Lang, string>][] = [["/", { zh: "监控", en: "Monitor" }], ["/mint", { zh: "铸造", en: "Mint" }], ["/trade", { zh: "交易", en: "Trade" }]];

/** Shared top bar: neutral brand, page nav, optional status slot, language toggle and wallet. */
export function TopBar({ lang, setLang, active, status }: { lang: Lang; setLang: (l: Lang) => void; active: Page; status?: React.ReactNode }) {
  const q = `?lang=${lang}`;
  return (
    <header className="topbar">
      <div className="tb-row">
      <Link href={`/${q}`} className="brand" aria-label="Relic Desk home"><span className="brand-mark" aria-hidden>R</span><span className="brand-name">Relic Desk</span><span className="brand-sep" aria-hidden /><span className="brand-sub">BSC on-chain</span></Link>
      <div className="status">
        {status}
        <button className="btn ghost sm lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")} aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}>{lang === "zh" ? "EN" : "中文"}</button>
        <WalletButton lang={lang} />
      </div>
      </div>
      <div className="tb-sub">
      <nav className="nav" aria-label={lang === "zh" ? "主导航" : "Main"}>
        {NAV.map(([href, label]) => <Link key={href} href={`${href}${q}`} aria-current={href === active ? "page" : undefined}>{label[lang]}</Link>)}
      </nav>
      </div>
    </header>
  );
}

/** Page frame for the transaction pages: top bar, page heading, wrong-chain guard. */
export function Shell({ title, sub, active, children }: { title: Record<Lang, string>; sub?: Record<Lang, string>; active: Page; children: (lang: Lang) => React.ReactNode }) {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  return (
    <div className="wrap">
      <TopBar lang={lang} setLang={setLang} active={active} />
      <main>
        <div className="page-head"><div><h1>{title[lang]}</h1>{sub ? <p className="muted">{sub[lang]}</p> : null}</div></div>
        <ChainGuard lang={lang} />
        {children(lang)}
      </main>
    </div>
  );
}
