import { RpcPool } from "@/lib/rpc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Read-only JSON-RPC proxy for the browser. Writes never pass through here: the user's wallet signs and broadcasts. */
const ALLOWED = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber",
]);

type Req = { id?: number | string; jsonrpc?: string; method: string; params?: unknown[] };

export async function POST(req: Request) {
  const body = (await req.json()) as Req | Req[];
  const one = async (r: Req) => {
    if (!ALLOWED.has(r.method)) return { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32601, message: `method not allowed: ${r.method}` } };
    try {
      const result = await RpcPool.call((c) => c.request({ method: r.method as "eth_chainId", params: r.params as never }));
      return { jsonrpc: "2.0", id: r.id ?? null, result };
    } catch (e) {
      const err = e as { code?: number; data?: unknown; details?: string; shortMessage?: string; cause?: { code?: number; data?: unknown } };
      return { jsonrpc: "2.0", id: r.id ?? null, error: { code: err.cause?.code ?? err.code ?? -32603, message: err.details ?? err.shortMessage ?? "rpc error", data: err.cause?.data ?? err.data } };
    }
  };
  return Response.json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
}
