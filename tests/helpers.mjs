import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as viem from "viem";

const root = fileURLToPath(new URL("../", import.meta.url));
const jsx = (type, props) => ({ type, props: props ?? {} });

// Execute the production TS/TSX with only wallet, network and React hooks isolated.
export function loadModule(file, mocks = {}, globals = {}) {
  const filename = path.join(root, file);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, console, Response, Request, URL, AbortController, AbortSignal, clearTimeout,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "viem") return viem;
      if (name.startsWith("@/lib/")) return loadModule(name.slice(2) + ".ts", mocks, globals);
      if (name === "./contracts") return loadModule("lib/contracts.ts", mocks, globals);
      if (name === "@/components/icons") return loadModule("components/icons.tsx", mocks, globals);
      throw new Error(`Unexpected import: ${name}`);
    },
  }, { filename });
  return exports;
}

export const account = "0x1111111111111111111111111111111111111111";
export const buyer = "0x2222222222222222222222222222222222222222";
export const bid = (id) => ({ id, buyer, price: 1, qty: 2, total: 2, ts: 1000 });
export const snapshot = () => ({ feeBps: 100, asset: {
  relic: { bids: [bid(7)], mine: [], fills: [] },
  loom: { bids: [bid(9)], mine: [], fills: [] },
} });

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}

export function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? textOf(tree.props?.children) : String(tree);
}

// A small hook driver for event/effect regression tests; no wallet can broadcast.
export function panelHarness(file, options = {}) {
  const slots = [], pending = [], intervals = new Map();
  let cursor = 0, dirty = true, tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) pending.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  const estimates = [], writes = [];
  const pc = {
    estimateGas: async args => { estimates.push(args); return 21000n; },
    getGasPrice: async () => 1000000000n,
  };
  const tx = { phase: "idle", busy: false, label: "", run: (...args) => writes.push(args) };
  const refetch = () => {};
  const mod = loadModule(file, {
    react,
    wagmi: {
      usePublicClient: () => pc,
      useWalletClient: () => ({ data: { chain: { id: 56 } } }),
      useReadContracts: ({ contracts }) => ({ data: contracts.map(c => ({ status: "success", result: options.read?.(c) })), refetch }),
      useBalance: () => ({ data: { value: 100n * 10n ** 18n } }),
    },
    "@/components/shell": { Shell: "Shell" },
    "@/components/tx": { TxStatus: "TxStatus", useTx: () => tx },
    "@/components/wallet": { useWalletGate: () => ({ address: account, ok: true }) },
    "@/components/ui": { TableState: { empty() {}, loading() {} } },
  }, {
    fetch: (...args) => (options.fetch ?? (async () => Response.json(snapshot())))(...args),
    setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
  });
  function render() {
    cursor = 0; dirty = false;
    const inner = mod.default().props.children("zh");
    tree = inner.type(inner.props);
    pending.splice(0).forEach(effect => effect());
    return tree;
  }
  async function flush() {
    if (!tree) render();
    for (let i = 0; i < 16; i++) { await Promise.resolve(); if (dirty) render(); }
    return tree;
  }
  return {
    render, flush, pc, tx, estimates, writes,
    all: () => nodes(tree),
    byId: id => nodes(tree).find(n => n.props["data-testid"] === id),
    button: text => nodes(tree).find(n => n.type === "button" && textOf(n) === text),
    poll: () => [...intervals.values()].forEach(fn => fn()),
  };
}
