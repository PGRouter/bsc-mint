import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";

type Provider = { label: string; client: PublicClient; fails: number; cooldownUntil: number; ms: number; lastOk: number };
const COOLDOWN_MS = 30_000;
const parseUrls = (value: string | undefined) => (value ?? "").split(",").map((url) => url.trim()).filter(Boolean);

/** Each server-only pool owns its clients and health state, even when URL lists match. */
function createRpcPool(readUrls: () => string[], prefix: string, missingEnvironment: string) {
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
    /** Runs fn on the first healthy provider, failing over to the next one on error. */
    async call<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
      const now = Date.now();
      const all = list();
      const ordered = [...all.filter((p) => p.cooldownUntil <= now), ...all.filter((p) => p.cooldownUntil > now)];
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
export const RpcPool = createRpcPool(() => parseUrls(process.env.BSC_RPC_URL), "rpc", "BSC_RPC_URL");

/** Chain indexing uses archive/log-capable endpoints, with a legacy fallback when unset or empty. */
export const HistoryRpcPool = createRpcPool(() => {
  const urls = parseUrls(process.env.HISTORY_RPC_URL);
  return urls.length ? urls : parseUrls(process.env.BSC_RPC_URL);
}, "history", "HISTORY_RPC_URL or BSC_RPC_URL");
