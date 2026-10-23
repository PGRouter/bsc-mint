"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ChainGuard, WalletButton } from "./wallet";
import { Icon } from "./icons";

export type Lang = "zh" | "en";
type Page = "/" | "/mint" | "/trade";
const NAV: [Page, Record<Lang, string>][] = [["/", { zh: "监控", en: "Monitor" }], ["/mint", { zh: "铸造", en: "Mint" }], ["/trade", { zh: "交易", en: "Trade" }]];
const SOCIAL_LINKS = { x: "https://x.com/oylpangu", github: "https://github.com/PGRouter/bsc-mint" } as const;

/** Shared top bar: neutral brand, page nav, optional status slot, language toggle and wallet. */
export function TopBar({ lang, setLang, active, status, showNetwork = true }: { lang: Lang; setLang: (l: Lang) => void; active: Page; status?: React.ReactNode; showNetwork?: boolean }) {
  const q = `?lang=${lang}`;
  return (
    <>
    <a href="#main-content" className="skip-link">{lang === "zh" ? "跳至主要内容" : "Skip to content"}</a>
    <header className="topbar">
      <Link href={`/${q}`} className="brand" aria-label="Relic Desk home"><span className="brand-mark"><Icon name="brand" size={29} /></span><span className="brand-wordmark">RELIC<span>DESK</span></span><span className="brand-tag">WEB3</span></Link>
      <nav className="nav" aria-label={lang === "zh" ? "主导航" : "Main"}>
        {NAV.map(([href, label], i) => <Link key={href} href={`${href}${q}`} aria-current={href === active ? "page" : undefined}><Icon name={i === 0 ? "chart" : i === 1 ? "layers" : "swap"} size={17} />{label[lang]}</Link>)}
        <a className="nav-social" href={SOCIAL_LINKS.x} target="_blank" rel="noopener noreferrer" aria-label={lang === "zh" ? "X（推特）" : "X (Twitter)"}><Icon name="x" size={16} />{lang === "zh" ? "推特" : "X (Twitter)"}</a>
        <a className="nav-social" href={SOCIAL_LINKS.github} target="_blank" rel="noopener noreferrer"><Icon name="github" size={17} />GitHub</a>
      </nav>
      <div className="status">
        <button className="btn ghost sm lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")} aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}><Icon name="globe" size={16} />{lang === "zh" ? "EN" : "中文"}</button>
        <WalletButton lang={lang} />
      </div>
    </header>
    {showNetwork ? <div className="network-bar"><span className="network-name"><span className="network-symbol" aria-hidden>◆</span> BNB Smart Chain <span className="network-id">MAINNET</span></span><div className="network-status">{status ?? <><span className="network-dash" />{lang === "zh" ? "链上资产工作台" : "On-chain asset workspace"}</>}</div></div> : null}
    </>
  );
}

/** Page frame for the transaction pages: top bar, page heading, wrong-chain guard. */
export function Shell({ title, sub, active, children }: { title: Record<Lang, string>; sub?: Record<Lang, string>; active: Page; children: (lang: Lang) => React.ReactNode }) {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>(params.get("lang") === "en" ? "en" : "zh");
  return (
    <div className="wrap">
      <TopBar lang={lang} setLang={setLang} active={active} showNetwork={false} />
      <main id="main-content" className="page-main">
        <div className="page-head"><div><span className="eyebrow">RELIC DESK <span>/</span> {active === "/mint" ? "COLLECTION" : "MARKETPLACE"}</span><h1>{title[lang]}<span className="heading-dot">.</span></h1>{sub ? <p className="muted">{sub[lang]}</p> : null}</div><span className="page-context"><Icon name={active === "/mint" ? "layers" : "activity"} size={16} />{active === "/mint" ? (lang === "zh" ? "Relic 系列" : "Relic collection") : "RELICS / LOOMS"}</span></div>
        <ChainGuard lang={lang} />
        {children(lang)}
      </main>
      <footer className="app-footer">
        <div className="footer-start">
          <span><span className="footer-mark">◆</span> RELIC DESK <span className="dim">· {lang === "zh" ? "你的资产，由你掌控" : "Your assets. Your control."}</span></span>
          <nav className="footer-social" aria-label={lang === "zh" ? "社交链接" : "Social links"}>
            <a href={SOCIAL_LINKS.x} target="_blank" rel="noopener noreferrer" aria-label={lang === "zh" ? "X（推特）" : "X (Twitter)"} title={lang === "zh" ? "X（推特）" : "X (Twitter)"}><Icon name="x" size={16} /></a>
            <a href={SOCIAL_LINKS.github} target="_blank" rel="noopener noreferrer" aria-label="GitHub" title="GitHub"><Icon name="github" size={17} /></a>
          </nav>
        </div>
        <span className="footer-chain">BNB Smart Chain <span className="dim">/ 56</span></span>
      </footer>
    </div>
  );
}
