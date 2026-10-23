import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const sourceFile = new URL("../lib/index-cache.ts", import.meta.url);

// Each module gets its own environment and working directory, without changing
// the real process or the existing shared test harness.
function loadCache(dir, file, seedFile) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(sourceFile, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require,
    process: {
      env: {
        ...(file === undefined ? {} : { BSC_INDEX_CACHE_FILE: file }),
        ...(seedFile === undefined ? {} : { BSC_INDEX_SEED_FILE: seedFile }),
      },
      cwd: () => dir, pid: process.pid,
    },
  }, { filename: sourceFile.pathname });
  return exports.IndexCache;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-index-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const publicRows = (count) => Array.from({ length: count }, (_, id) => ({
  id,
  owner: `0x${id.toString(16).padStart(40, "0")}`,
  price: (id % 379) / 100,
  quantity: id % 23 + 1,
  block: 80000000 + id,
}));

test("large public index data survives a gzip round trip at the configured path", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "nested", "custom-index.json.gz");
  const cache = loadCache(dir, file);
  const value = { version: 1, chainId: 56, block: 80012000, bids: publicRows(12000) };
  await cache.write(value);
  assert.deepEqual(structuredClone(await cache.read()), value);
  const raw = await fs.readFile(file);
  assert.ok(raw.length < JSON.stringify(value).length);
  assert.deepEqual(JSON.parse((await decompress(raw)).toString("utf8")), value);
});

test("the default cache lives in the mocked working directory", async (t) => {
  const dir = await fixture(t);
  const cache = loadCache(dir);
  await cache.write({ block: 80123456 });
  const file = path.join(dir, ".cache", "bsc-indexer-v1.json.gz");
  assert.deepEqual(JSON.parse((await decompress(await fs.readFile(file))).toString("utf8")), { block: 80123456 });
  assert.deepEqual(structuredClone(await cache.read()), { block: 80123456 });
});

test("a missing writable cache restores the default server-side seed", async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, "data"));
  await fs.writeFile(path.join(dir, "data", "bsc-indexer-seed.json.gz"), await compress('{"block":80010000}'));
  const cache = loadCache(dir, path.join(dir, "writable", "index.json.gz"));
  assert.deepEqual(structuredClone(await cache.read()), { block: 80010000 });
});

test("a configured seed takes precedence over the default seed path", async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, "data"));
  await fs.writeFile(path.join(dir, "data", "bsc-indexer-seed.json.gz"), await compress('{"block":80010000}'));
  const seedFile = path.join(dir, "custom-seed.json.gz");
  await fs.writeFile(seedFile, await compress('{"block":80020000}'));
  const cache = loadCache(dir, path.join(dir, "index.json.gz"), seedFile);
  assert.deepEqual(structuredClone(await cache.read()), { block: 80020000 });
});

test("an existing writable cache takes precedence over the seed", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "index.json.gz");
  const seedFile = path.join(dir, "seed.json.gz");
  await fs.writeFile(file, await compress('{"block":80030000}'));
  await fs.writeFile(seedFile, await compress('{"block":80010000}'));
  const cache = loadCache(dir, file, seedFile);
  assert.deepEqual(structuredClone(await cache.read()), { block: 80030000 });
});

test("invalid gzip or JSON in the writable cache falls back to the seed", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "index.json.gz");
  const seedFile = path.join(dir, "seed.json.gz");
  await fs.writeFile(seedFile, await compress('{"block":80010000}'));
  const cache = loadCache(dir, file, seedFile);
  for (const invalid of [Buffer.from("not gzip"), await compress("{incomplete")]) {
    await fs.writeFile(file, invalid);
    assert.deepEqual(structuredClone(await cache.read()), { block: 80010000 });
  }
});

test("saving an incremental checkpoint never changes the read-only seed", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "writable", "index.json.gz");
  const seedFile = path.join(dir, "seed.json.gz");
  const original = await compress('{"block":80010000}');
  await fs.writeFile(seedFile, original, { mode: 0o444 });
  const cache = loadCache(dir, file, seedFile);
  assert.deepEqual(structuredClone(await cache.read()), { block: 80010000 });
  await cache.write({ block: 80040000 });
  assert.deepEqual(structuredClone(await cache.read()), { block: 80040000 });
  assert.deepEqual(await fs.readFile(seedFile), original);
});

test("missing, invalid gzip and malformed JSON checkpoints read as null", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "index.json.gz");
  const cache = loadCache(dir, file);
  assert.equal(await cache.read(), null);
  await fs.writeFile(file, "not gzip");
  assert.equal(await cache.read(), null);
  await fs.writeFile(file, await compress("{incomplete"));
  assert.equal(await cache.read(), null);
});

test("an unavailable destination or unserializable value does not reject writes", async (t) => {
  const dir = await fixture(t);
  const blocked = path.join(dir, "not-a-directory");
  await fs.writeFile(blocked, "occupied");
  const unavailable = loadCache(dir, path.join(blocked, "index.json.gz"));
  await assert.doesNotReject(unavailable.write({ block: 1 }));
  assert.equal(await unavailable.read(), null);

  const cache = loadCache(dir, path.join(dir, "index.json.gz"));
  await cache.write({ block: 2 });
  const circular = {}; circular.self = circular;
  await assert.doesNotReject(cache.write(circular));
  assert.deepEqual(structuredClone(await cache.read()), { block: 2 });
});

test("readers see only complete checkpoints during concurrent replacements", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "index.json.gz");
  const first = loadCache(dir, file);
  const second = loadCache(dir, file);
  const rows = publicRows(20000);
  await first.write({ revision: 0, rows });

  let finished = false;
  const writes = Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).write({ revision: i + 1, rows })))
    .finally(() => { finished = true; });
  let reads = 0;
  do {
    const raw = await fs.readFile(file);
    const snapshot = JSON.parse((await decompress(raw)).toString("utf8"));
    assert.ok(Number.isInteger(snapshot.revision) && snapshot.revision >= 0 && snapshot.revision <= 8);
    assert.deepEqual(snapshot.rows, rows);
    reads++;
  } while (!finished);
  await writes;
  assert.ok(reads > 0);
  const final = structuredClone(await first.read());
  assert.ok(final.revision >= 1 && final.revision <= 8);
  assert.deepEqual(final.rows, rows);
  assert.deepEqual(await fs.readdir(dir), ["index.json.gz"]);
});

test("replacing an existing checkpoint restricts file permissions to its owner", { skip: process.platform === "win32" }, async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "index.json.gz");
  await fs.writeFile(file, await compress('{"block":1}'), { mode: 0o644 });
  const cache = loadCache(dir, file);
  await cache.write({ block: 2 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
