import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";

type Provider = { label: string; client: PublicClient; fails: number; cooldownUntil: number; ms: number; lastOk: number };

/** Server-only RPC pool. URLs come from BSC_RPC_URL (comma-separated) and never leave the server. */
export class RpcPool {
  private static providers: Provider[] | null = null;
  static readonly COOLDOWN_MS = 30_000;

  private static list(): Provider[] {
    if (!RpcPool.providers) {
      const urls = (process.env.BSC_RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
      if (!urls.length) throw new Error("BSC_RPC_URL is not set");
      RpcPool.providers = urls.map((url, i) => ({
        label: `rpc#${i + 1}`,
        client: createPublicClient({ chain: bsc, transport: http(url, { timeout: 20_000, retryCount: 1 }) }) as PublicClient,
        fails: 0, cooldownUntil: 0, ms: 0, lastOk: 0,
      }));
    }
    return RpcPool.providers;
  }

  /** Runs fn on the first healthy provider, failing over to the next one on error. */
  static async call<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
    const now = Date.now();
    const all = RpcPool.list();
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
        p.cooldownUntil = Date.now() + RpcPool.COOLDOWN_MS;
      }
    }
    throw lastErr;
  }

  /** Public status: labels only, never URLs. */
  static status() {
    const now = Date.now();
    return RpcPool.list().map(({ label, fails, cooldownUntil, ms, lastOk }) => ({ label, fails, cooldown: cooldownUntil > now, ms, lastOk }));
  }
}
