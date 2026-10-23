import { Indexer } from "@/lib/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  await Indexer.sync();
  return Response.json(Indexer.snapshot(), { headers: { "cache-control": "no-store" } });
}
