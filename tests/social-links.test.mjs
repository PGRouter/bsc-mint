import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadModule, nodes } from "./helpers.mjs";

function pageModules(lang) {
  // Isolate routing, wallets and effects; navigation renders with real React JSX.
  const mocks = {
    react: {
      ...React,
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
      useRef: initial => ({ current: initial }),
      useCallback: fn => fn,
      useEffect: () => {},
    },
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useSearchParams: () => new URLSearchParams(`lang=${lang}`) },
    "next/link": { default: "a" },
    "./wallet": { ChainGuard: () => null, WalletButton: () => null },
  };
  const icons = loadModule("components/icons.tsx", mocks);
  const shell = loadModule("components/shell.tsx", { ...mocks, "./icons": icons });
  const monitor = loadModule("app/monitor.tsx", {
    ...mocks,
    "@/components/shell": shell,
    "@/components/icons": icons,
    "@/components/kline": { KLine: () => null },
    "@/components/ui": loadModule("components/ui.tsx", mocks),
  });
  return { shell, Monitor: monitor.default };
}

function expand(tree) {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== "object") return tree;
  if (typeof tree.type === "function") return expand(tree.type(tree.props));
  return { type: tree.type, props: { ...tree.props, children: expand(tree.props?.children) } };
}

function visibleText(tree) {
  if (Array.isArray(tree)) return tree.map(visibleText).join("");
  if (tree == null || typeof tree === "boolean") return "";
  if (typeof tree !== "object") return String(tree);
  const p = tree.props ?? {};
  if (p.hidden || p["aria-hidden"] === true || p["aria-hidden"] === "true" ||
    /(?:^|\s)sr-only(?:\s|$)/.test(p.className ?? "") || p.style?.display === "none" || p.style?.visibility === "hidden") return "";
  return visibleText(p.children);
}

function assertTopNav(tree, lang) {
  const html = renderToStaticMarkup(tree);
  const nav = nodes(expand(tree)).find(node => node.type === "nav" && node.props.className === "nav");
  assert.ok(nav, "the page renders the shared top navigation");
  const anchors = nodes(nav).filter(node => node.type === "a");
  const expected = [
    [lang === "zh" ? "监控" : "Monitor", `/?lang=${lang}`],
    [lang === "zh" ? "铸造" : "Mint", `/mint?lang=${lang}`],
    [lang === "zh" ? "交易" : "Trade", `/trade?lang=${lang}`],
    [lang === "zh" ? "推特" : "X (Twitter)", "https://x.com/oylpangu"],
    ["GitHub", "https://github.com/PGRouter/bsc-mint"],
  ];
  assert.equal(anchors.length, 5, "social links follow the three internal navigation links");
  for (const [i, [label, href]] of expected.entries()) {
    const link = anchors[i];
    assert.equal(link.props.href, href, `${label} appears in the correct navigation position`);
    assert.equal(visibleText(link).trim(), label, `${label} has a visible text label`);
    if (i >= 3) {
      assert.equal(link.props.target, "_blank");
      const rel = new Set((link.props.rel ?? "").split(/\s+/));
      assert.ok(rel.has("noopener") && rel.has("noreferrer"));
    }
    assert.ok(html.includes(href) && html.includes(label), "the real React render includes the link and its label");
  }
}

function assertSharedTopBar(tree, TopBar) {
  assert.equal(nodes(tree).filter(node => node.type === TopBar).length, 1, "the page renders the shared TopBar");
}

for (const lang of ["zh", "en"]) {
  test(`TopBar places visible and safe social links after Trade in ${lang}`, () => {
    const { shell } = pageModules(lang);
    assertTopNav(React.createElement(shell.TopBar, { lang, setLang: () => {}, active: "/", showNetwork: false }), lang);
  });

  test(`Monitor renders shared top navigation with social links in ${lang}`, () => {
    const { shell, Monitor } = pageModules(lang);
    const tree = Monitor();
    assertSharedTopBar(tree, shell.TopBar);
    assertTopNav(tree, lang);
  });

  for (const active of ["/mint", "/trade"]) {
    test(`${active} Shell renders shared top navigation with social links in ${lang}`, () => {
      const { shell } = pageModules(lang);
      const tree = shell.Shell({ active, title: { zh: "页面", en: "Page" }, children: () => React.createElement("p", null, "Page content") });
      assertSharedTopBar(tree, shell.TopBar);
      assertTopNav(tree, lang);
    });
  }
}
