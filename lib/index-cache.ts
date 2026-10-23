import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const cacheFile = () => process.env.BSC_INDEX_CACHE_FILE ?? path.join(process.cwd(), ".cache", "bsc-indexer-v1.json.gz");
const seedFile = () => process.env.BSC_INDEX_SEED_FILE ?? path.join(process.cwd(), "data", "bsc-indexer-seed.json.gz");

/** Optional checkpoint storage for public on-chain index data. */
export class IndexCache {
  static async read(): Promise<unknown | null> {
    for (const file of [cacheFile(), seedFile()]) {
      try {
        const raw = await readFile(file);
        return JSON.parse((await decompress(raw)).toString("utf8"));
      } catch {
        // A missing or damaged writable cache can fall back to the bundled seed.
      }
    }
    return null;
  }

  static async write(value: unknown): Promise<void> {
    let temp: string | undefined;
    try {
      const file = cacheFile();
      const raw = await compress(JSON.stringify(value));
      await mkdir(path.dirname(file), { recursive: true });
      temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, raw, { mode: 0o600, flag: "wx" });
      await rename(temp, file);
      temp = undefined;
    } catch {
      // A checkpoint failure must not interrupt indexing or expose environment data.
    } finally {
      if (temp) await unlink(temp).catch(() => {});
    }
  }
}
