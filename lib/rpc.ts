import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";

type Provider = { label: string; client: PublicClient; fails: number; cooldownUntil: number; ms: number; lastOk: number };
const COOLDOWN_MS = 30_000;
const BACKUP_DELAY_MS = 350;
const READ_BUDGET_MS = 7_500;
const parseUrls = (value: string | undefined) => (value ?? "").split(",").map((url) => url.trim()).filter(Boolean);

/** Delay the extra read until needed; each attempt owns an independently cancellable client scope. */
function fastRead<T>(ordered: Provider[], fn: (c: PublicClient) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const running = new Map<AbortController, Provider>();
    let next = 0;
    let done = false;
    let lastError: unknown;

    const cleanup = () => {
      clearTimeout(backupTimer);
      clearTimeout(budgetTimer);
      for (const controller of running.keys()) controller.abort();
      running.clear();
    };
    const failed = (p: Provider) => {
      p.fails += 1;
      p.cooldownUntil = Date.now() + COOLDOWN_MS;
    };
    const launch = () => {
      if (done || next >= ordered.length || running.size >= 2) return;
      const p = ordered[next++];
      const controller = new AbortController();
      running.set(controller, p);
      const started = Date.now();
      void Promise.resolve().then(() => fn(p.client.scope({ signal: controller.signal }))).then(out => {
        if (done || controller.signal.aborted) return;
        Object.assign(p, { ms: Date.now() - started, lastOk: Date.now(), fails: 0, cooldownUntil: 0 });
        // The winner remains usable while all unfinished competing requests are canceled.
        running.delete(controller);
        done = true;
        cleanup();
        resolve(out);
      }, error => {
        if (done || controller.signal.aborted) return;
        lastError = error;
        failed(p);
      }).finally(() => {
        running.delete(controller);
        if (done) return;
        if (next < ordered.length) launch();
        else if (!running.size) {
          done = true;
          cleanup();
          reject(lastError);
        }
      });
    };
    const budgetTimer = setTimeout(() => {
      if (done) return;
      done = true;
      for (const p of running.values()) failed(p);
      cleanup();
      reject(Object.assign(new Error("RPC read timed out after 7500ms"), { shortMessage: "RPC read timed out; please retry" }));
    }, READ_BUDGET_MS);
    const backupTimer = setTimeout(launch, BACKUP_DELAY_MS);
    launch();
  });
}

/** Each server-only pool owns its clients and health state, even when URL lists match. */
function createRpcPool(readUrls: () => string[], prefix: string, missingEnvironment: string, fastFallback = false) {
  let providers: Provider[] | null = null;

  const list = (): Provider[] => {
    if (!providers) {
      const urls = readUrls();
      if (!urls.length) throw new Error(`${missingEnvironment} is not set`);
      providers = urls.map((url, i) => ({
        label: `${prefix}#${i + 1}`,
        client: createPublicClient({ chain: bsc, transport: http(url, { timeout: 8_000, retryCount: 0 }) }) as PublicClient,
        fails: 0, cooldownUntil: 0, ms: 0, lastOk: 0,
      }));
    }
    return providers;
  };

  return {
    COOLDOWN_MS,
    /** Ordinary reads can race one delayed backup; archive scans keep serial failover. */
    async call<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
      const now = Date.now();
      const all = list();
      const ordered = [...all.filter((p) => p.cooldownUntil <= now), ...all.filter((p) => p.cooldownUntil > now)];
      if (fastFallback) return fastRead(ordered, fn);
      let lastErr: unknown;
      for (const p of ordered) {
        const t0 = Date.now();
        try {
          const out = await fn(p.client);
          Object.assign(p, { ms: Date.now() - t0, lastOk: Date.now(), fails: 0, cooldownUntil: 0 });
          return out;
        } catch (e) {
          lastErr = e;
          p.fails += 1;
          p.cooldownUntil = Date.now() + COOLDOWN_MS;
        }
      }
      throw lastErr;
    },

    /** Public status: labels only, never URLs. */
    status() {
      const now = Date.now();
      return list().map(({ label, fails, cooldownUntil, ms, lastOk }) => ({ label, fails, cooldown: cooldownUntil > now, ms, lastOk }));
    },
  } as const;
}

/** General browser-proxy reads; these endpoints need not support historical logs. */
export const RpcPool = createRpcPool(() => parseUrls(process.env.BSC_RPC_URL), "rpc", "BSC_RPC_URL", true);

/** Chain indexing uses archive/log-capable endpoints, with a legacy fallback when unset or empty. */
export const HistoryRpcPool = createRpcPool(() => {
  const urls = parseUrls(process.env.HISTORY_RPC_URL);
  return urls.length ? urls : parseUrls(process.env.BSC_RPC_URL);
}, "history", "HISTORY_RPC_URL or BSC_RPC_URL");
