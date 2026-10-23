import test from "node:test";
import assert from "node:assert/strict";
import { account, bid, deferred, loadModule, nodes, snapshot, textOf } from "./helpers.mjs";

// Drive the real hooks and effects with controllable network responses and timers.
// No wallet or RPC connection is created.
function pollingHarness(file, { fetch: fetcher, exportName = "default", props = {}, lang = "zh" } = {}) {
  const slots = [], effects = [], intervals = new Map(), timers = new Map(), requests = [], canvasCalls = [];
  const document = { visibilityState: "visible" };
  let cursor = 0, dirty = true, output, timerId = 0, onDone;
  const noop = () => {};
  const ctx = new Proxy({}, { get: (_, key) => key === "measureText" ? () => ({ width: 10 }) : () => canvasCalls.push(key), set: () => true });
  const canvas = { clientWidth: 900, clientHeight: 340, style: {}, getContext: () => ctx, addEventListener: noop, removeEventListener: noop };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial === null ? canvas : initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  const pc = { waitForTransactionReceipt: async args => { requests.push(args); return { status: "success" }; } };
  const mod = loadModule(file, {
    react,
    wagmi: {
      usePublicClient: () => pc,
      useWalletClient: () => ({ data: { chain: { id: 56 } } }),
      useReadContracts: () => ({ data: [], refetch: noop }),
    },
    "next/navigation": { useSearchParams: () => new URLSearchParams() },
    "@/components/shell": { Shell: "Shell", TopBar: "TopBar" },
    "@/components/kline": { KLine: "KLine" },
    "@/components/wallet": { useWalletGate: () => ({ address: account, ok: true }) },
    "@/components/tx": { TxStatus: "TxStatus", useTx: callback => { onDone = callback; return { phase: "idle", busy: false, label: "" }; } },
    "@/components/ui": loadModule("components/ui.tsx"),
  }, {
    document,
    URLSearchParams,
    window: { location: { href: "http://localhost/" }, history: { replaceState: noop }, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop },
    AbortController, AbortSignal,
    fetch: (...args) => fetcher(...args),
    setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  function render() {
    cursor = 0; dirty = false;
    output = mod[exportName](props);
    if (output?.type === "Shell") {
      const inner = output.props.children(lang);
      output = inner.type(inner.props);
    }
    effects.splice(0).forEach(effect => effect());
    return output;
  }
  async function flush() {
    if (dirty) render();
    for (let i = 0; i < 32; i++) { await Promise.resolve(); if (dirty) render(); }
  }
  return {
    render, flush, document, requests, canvasCalls,
    get output() { return output; },
    byId: id => nodes(output).find(node => node.props["data-testid"] === id),
    button: label => nodes(output).find(node => node.type === "button" && textOf(node) === label),
    poll: () => [...intervals.values()].map(timer => timer.fn()),
    completeTx: () => onDone?.(),
    expire: ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}

function abortablePending(requests) {
  return (url, options = {}) => {
    const pending = deferred();
    requests.push({ url, ...options, ...pending });
    options.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
    return pending.promise;
  };
}

function monitorSnapshot() {
  const s = snapshot();
  return { ...s, now: 1000, block: 1, ready: true, backfill: 1, stale: false, staleAge: null, error: null,
    rpc: [], mint: null, contracts: {}, asset: Object.fromEntries(Object.entries(s.asset).map(([asset, view]) => [asset, {
      ...view, count: 1, best: 1, escrow: 2, demand: 2, bigCount: 0, bigEscrow: 0, lastPrice: null,
      volume: { totalUsdt: 0, totalFills: 0, last1m: { count: 0, usdt: 0 }, last5m: { count: 0, usdt: 0 }, last15m: { count: 0, usdt: 0 } },
      holders: [], holderCount: 0,
    }])) };
}

for (const [name, file] of [["monitor", "app/monitor.tsx"], ["trade", "app/trade/panel.tsx"], ["K-line", "components/kline.tsx"]]) {
  const extra = name === "K-line" ? { exportName: "KLine", props: { asset: "relic", lang: "zh", title: "价格走势" } } : {};
  test(`${name} keeps only one polling request in flight`, async () => {
    const requests = [];
    const h = pollingHarness(file, { ...extra, fetch: abortablePending(requests) });
    h.render(); h.poll(); h.poll();
    if (name === "trade") { h.completeTx(); h.expire(4500); }
    assert.equal(requests.length, 1);
    requests[0].resolve(Response.json(name === "K-line" ? { candles: [] } : name === "monitor" ? monitorSnapshot() : snapshot()));
    await h.flush(); h.poll();
    assert.equal(requests.length, 2, "polling resumes after the prior request settles");
    h.unmount(); await h.flush();
  });

  test(`${name} skips hidden pages and resumes when visible`, async () => {
    const requests = [];
    const h = pollingHarness(file, { ...extra, fetch: abortablePending(requests) });
    h.document.visibilityState = "hidden";
    h.render(); h.poll();
    assert.equal(requests.length, 0);
    h.document.visibilityState = "visible";
    h.poll();
    assert.equal(requests.length, 1);
    h.unmount(); await h.flush();
  });

  test(`${name} aborts stalled requests after 8 seconds and permits another poll`, async () => {
    const requests = [];
    const h = pollingHarness(file, { ...extra, fetch: abortablePending(requests) });
    h.render(); h.expire(8000); await h.flush();
    assert.equal(requests[0].signal?.aborted, true);
    h.poll();
    assert.equal(requests.length, 2);
    h.unmount(); await h.flush();
  });
}

test("a pending RELIC snapshot does not block the next LOOM context", async () => {
  const requests = [];
  const h = pollingHarness("app/trade/panel.tsx", { fetch: abortablePending(requests) });
  h.render(); h.button("LOOMS").props.onClick(); h.render();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal?.aborted, true);
  requests[1].resolve(Response.json(snapshot()));
  await h.flush();
  assert.ok(textOf(h.byId("book")).includes("#9"));
  h.unmount(); await h.flush();
});

test("a late candle response cannot overwrite the newly selected period", async () => {
  const requests = [];
  const h = pollingHarness("components/kline.tsx", {
    exportName: "KLine", props: { asset: "relic", lang: "zh", title: "价格走势" },
    fetch: (url, options) => { const pending = deferred(); requests.push({ url, ...options, ...pending }); return pending.promise; },
  });
  h.render(); h.button("5m").props.onClick(); h.render();
  assert.ok(requests[0].url.includes("sec=60"));
  assert.ok(requests[1].url.includes("sec=300"));
  const candle = price => ({ t: 60000, o: price, h: price + 1, l: price - 1, c: price, v: 1, n: 1 });
  requests[1].resolve(Response.json({ candles: [candle(20)] })); await h.flush();
  requests[0].resolve(Response.json({ candles: [candle(10)] })); await h.flush();
  assert.ok(textOf(h.byId("ohlc")).includes("20.00"));
  assert.equal(textOf(h.byId("ohlc")).includes("10.00"), false);
  h.unmount(); await h.flush();
});

for (const change of ["period", "asset"]) {
  test(`changing the K-line ${change} clears the prior chart even if the new request fails`, async () => {
    const requests = [];
    const props = { asset: "relic", lang: "zh", title: "价格走势" };
    const h = pollingHarness("components/kline.tsx", { exportName: "KLine", props, fetch: abortablePending(requests) });
    h.render();
    requests[0].resolve(Response.json({ candles: [{ t: 60000, o: 20, h: 21, l: 19, c: 20, v: 1, n: 1 }] }));
    await h.flush();
    assert.ok(textOf(h.byId("ohlc")).includes("20.00"));
    if (change === "period") h.button("5m").props.onClick(); else props.asset = "loom";
    h.render();
    requests[1].reject(new Error("New chart unavailable"));
    await h.flush();
    assert.equal(h.byId("ohlc"), undefined, "the new selection must not label old candles");
    assert.ok(textOf(h.output).includes("暂无成交数据"));
    assert.equal(h.canvasCalls.at(-1), "clearRect", "the canvas must clear with the old candle state");
    h.unmount(); await h.flush();
  });
}

test("a K-line refresh failure preserves candles for the same asset and period", async () => {
  const requests = [];
  const h = pollingHarness("components/kline.tsx", {
    exportName: "KLine", props: { asset: "relic", lang: "zh", title: "价格走势" }, fetch: abortablePending(requests),
  });
  h.render();
  requests[0].resolve(Response.json({ candles: [{ t: 60000, o: 20, h: 21, l: 19, c: 20, v: 1, n: 1 }] }));
  await h.flush(); h.poll();
  requests[1].reject(new Error("Refresh unavailable"));
  await h.flush();
  assert.ok(textOf(h.byId("ohlc")).includes("20.00"));
  assert.equal(textOf(h.output).includes("暂无成交数据"), false);
  h.unmount(); await h.flush();
});

test("a failed trade refresh keeps the last successful order book", async () => {
  let calls = 0;
  const h = pollingHarness("app/trade/panel.tsx", { fetch: async () => {
    if (++calls === 1) return Response.json(snapshot());
    throw new Error("RPC unavailable");
  } });
  await h.flush();
  const refresh = await Promise.allSettled(h.poll()); await h.flush();
  assert.equal(refresh[0].status, "fulfilled", "refresh failures are handled by the component");
  assert.ok(textOf(h.byId("book")).includes(`#${bid(7).id}`));
  h.unmount();
});

for (const [lang, syncing, indexed, delayed] of [
  ["zh", "历史数据同步中", "当前买单簿为已索引数据", "数据延迟，显示最近成功数据"],
  ["en", "Syncing history", "The order book shows indexed data", "Data delayed. Showing the last successful data"],
]) {
  test(`trade labels partial history and progress in ${lang}`, async () => {
    const h = pollingHarness("app/trade/panel.tsx", { lang, fetch: async () => Response.json({ ...snapshot(), ready: true, backfill: 0.37, stale: false }) });
    await h.flush();
    const banner = h.byId("trade-backfill");
    assert.ok(textOf(banner).includes(syncing));
    assert.ok(textOf(banner).includes(indexed));
    assert.ok(textOf(banner).includes("37%"));
    assert.ok(textOf(h.byId("book")).includes("#7"));
    h.unmount();
  });

  test(`trade labels delayed snapshots in ${lang}`, async () => {
    const h = pollingHarness("app/trade/panel.tsx", { lang, fetch: async () => Response.json({ ...snapshot(), ready: true, backfill: 1, stale: true }) });
    await h.flush();
    assert.ok(textOf(h.byId("trade-stale")).includes(delayed));
    assert.ok(textOf(h.byId("book")).includes("#7"));
    h.unmount();
  });
}

test("trade keeps the loading book when the API explicitly reports not ready", async () => {
  const data = snapshot(); data.asset.relic.bids = [];
  const h = pollingHarness("app/trade/panel.tsx", { fetch: async () => Response.json({ ...data, ready: false, backfill: 0, stale: false }) });
  await h.flush();
  assert.ok(nodes(h.byId("book")).some(node => node.props.className === "sk-row"));
  assert.equal(textOf(h.byId("book")).includes("暂无"), false);
  h.unmount();
});

test("trade removes sync banners after indexing catches up", async () => {
  let complete = false;
  const h = pollingHarness("app/trade/panel.tsx", { fetch: async () => Response.json({ ...snapshot(), ready: true, backfill: complete ? 1 : 0.5, stale: false }) });
  await h.flush();
  assert.ok(h.byId("trade-backfill"));
  complete = true; await Promise.all(h.poll()); await h.flush();
  assert.equal(h.byId("trade-backfill"), undefined);
  assert.equal(h.byId("trade-stale"), undefined);
  h.unmount();
});

test("trade accepts older snapshot fixtures without readiness metadata", async () => {
  const h = pollingHarness("app/trade/panel.tsx", { fetch: async () => Response.json(snapshot()) });
  await h.flush();
  assert.ok(textOf(h.byId("book")).includes("#7"));
  assert.equal(h.byId("trade-backfill"), undefined);
  assert.equal(h.byId("trade-stale"), undefined);
  h.unmount();
});

test("receipt confirmation polls at two seconds without changing transaction flow", async () => {
  const h = pollingHarness("components/tx.tsx", { exportName: "useTx", props: () => {} });
  h.render();
  const order = [];
  await h.output.run("test", async () => { order.push("simulate"); }, async () => { order.push("sign"); return `0x${"1".repeat(64)}`; });
  assert.deepEqual(order, ["simulate", "sign"]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].pollingInterval, 2000);
  await h.flush();
  assert.equal(h.output.phase, "success");
});
