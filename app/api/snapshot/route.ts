import { Indexer } from "@/lib/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await Indexer.sync();
  const me = new URL(req.url).searchParams.get("me")?.toLowerCase() || undefined;
  return Response.json(Indexer.snapshot(me), { headers: { "cache-control": "no-store" } });
}
