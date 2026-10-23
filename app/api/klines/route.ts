import { Indexer, type Asset } from "@/lib/indexer";
import { after } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sec = Number(q.get("sec") ?? 60);
  if (!(Indexer.PERIODS as readonly number[]).includes(sec)) return Response.json({ error: `sec must be one of ${Indexer.PERIODS.join(",")}` }, { status: 400 });
  const asset: Asset = q.get("asset") === "loom" ? "loom" : "relic";
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 200) || 200, 1), 1000);
  after(() => Indexer.sync());
  return Response.json({ sec, asset, now: Date.now(), candles: Indexer.klines(sec, asset, limit) }, { headers: { "cache-control": "no-store" } });
}
