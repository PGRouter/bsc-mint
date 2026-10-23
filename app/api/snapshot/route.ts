import { Indexer } from "@/lib/indexer";
import { after } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  await Indexer.prepare();
  after(() => Indexer.sync());
  const me = new URL(req.url).searchParams.get("me")?.toLowerCase() || undefined;
  return Response.json(Indexer.snapshot(me), { headers: { "cache-control": "no-store" } });
}
