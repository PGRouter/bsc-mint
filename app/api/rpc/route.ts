import { RpcPool } from "@/lib/rpc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Read-only JSON-RPC proxy for the browser. Writes never pass through here: the user's wallet signs and broadcasts. */
const ALLOWED = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber",
]);

type Req = { id?: number | string | null; jsonrpc: "2.0"; method: string; params?: unknown[] };

function isRequest(value: unknown): value is Req {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.jsonrpc === "2.0" && typeof r.method === "string" &&
    (!("id" in r) || r.id === null || typeof r.id === "string" || (typeof r.id === "number" && Number.isFinite(r.id)));
}

function rpcError(code: number, message: string, id: Req["id"] = null) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return Response.json(rpcError(-32700, "Parse error"), { status: 400 }); }
  if (Array.isArray(body) && !body.length) return Response.json(rpcError(-32600, "Invalid Request"), { status: 400 });
  const one = async (value: unknown) => {
    if (!isRequest(value)) return rpcError(-32600, "Invalid Request");
    const r = value;
    const notification = !("id" in r);
    if ("params" in r && !Array.isArray(r.params)) return notification ? undefined : rpcError(-32602, "Invalid params", r.id);
    if (!ALLOWED.has(r.method)) return notification ? undefined : rpcError(-32601, `method not allowed: ${r.method}`, r.id);
    try {
      const result = await RpcPool.call((c) => c.request({ method: r.method as "eth_chainId", params: r.params as never }));
      return notification ? undefined : { jsonrpc: "2.0", id: r.id, result };
    } catch (e) {
      if (notification) return undefined;
      const err = e as { code?: number; data?: unknown; details?: string; shortMessage?: string; cause?: { code?: number; data?: unknown } };
      return { jsonrpc: "2.0", id: r.id ?? null, error: { code: err.cause?.code ?? err.code ?? -32603, message: err.details ?? err.shortMessage ?? "rpc error", data: err.cause?.data ?? err.data } };
    }
  };
  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map(one))).filter(r => r !== undefined);
    return results.length ? Response.json(results) : new Response(null, { status: 204 });
  }
  const result = await one(body);
  return result ? Response.json(result, { status: isRequest(body) ? 200 : 400 }) : new Response(null, { status: 204 });
}
