import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

function proxy() {
  const calls = [];
  const { POST } = loadModule("app/api/rpc/route.ts", {
    "@/lib/rpc": { RpcPool: { call: fn => fn({ request: async r => {
      calls.push(r);
      if (r.method === "eth_getBalance") throw { code: -32000, data: "0xdead", details: "upstream failed" };
      return "0x38";
    } }) } },
  });
  return {
    calls,
    post: body => POST(new Request("http://audit.local/api/rpc", { method: "POST", body })),
  };
}

test("invalid JSON returns a parse error rather than throwing", async () => {
  const p = proxy();
  const res = await p.post("{");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  assert.equal(p.calls.length, 0);
});

for (const body of ["null", "1", '"rpc"', "[]", "{}", '[null]', '{"jsonrpc":"2.0","method":1}', '{"jsonrpc":"1.0","method":"eth_chainId","id":1}', '{"jsonrpc":"2.0","method":"eth_chainId","id":{}}']) {
  test(`invalid request ${body} is rejected before any upstream call`, async () => {
    const p = proxy();
    const res = await p.post(body);
    const json = await res.json();
    const error = Array.isArray(json) ? json[0] : json;
    assert.equal(error.error.code, -32600);
    assert.equal(error.id, null);
    assert.equal(p.calls.length, 0);
  });
}

test("mixed batch preserves valid responses when another entry is null", async () => {
  const p = proxy();
  const res = await p.post(JSON.stringify([null, { jsonrpc: "2.0", method: "eth_chainId", id: 0 }]));
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json[0].error.code, -32600);
  assert.deepEqual(json[1], { jsonrpc: "2.0", id: 0, result: "0x38" });
  assert.equal(p.calls.length, 1);
});

for (const params of [null, "bad", 1, {}]) {
  test(`non-positional params ${JSON.stringify(params)} are rejected`, async () => {
    const p = proxy();
    const res = await p.post(JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params, id: "read" }));
    const json = await res.json();
    assert.equal(json.error.code, -32602);
    assert.equal(json.id, "read");
    assert.equal(p.calls.length, 0);
  });
}

for (const id of [0, "wallet-read", null]) {
  test(`valid read keeps request id ${JSON.stringify(id)}`, async () => {
    const p = proxy();
    const res = await p.post(JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id }));
    assert.deepEqual(await res.json(), { jsonrpc: "2.0", id, result: "0x38" });
  });
}

test("write methods remain blocked", async () => {
  const p = proxy();
  const res = await p.post('{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":[],"id":1}');
  assert.equal((await res.json()).error.code, -32601);
  assert.equal(p.calls.length, 0);
});

test("upstream RPC errors retain code and revert data", async () => {
  const p = proxy();
  const res = await p.post('{"jsonrpc":"2.0","method":"eth_getBalance","params":[],"id":2}');
  assert.deepEqual((await res.json()).error, { code: -32000, message: "upstream failed", data: "0xdead" });
});

test("valid notifications return no body for single and batch requests", async () => {
  const p = proxy();
  const notification = { jsonrpc: "2.0", method: "eth_chainId" };
  for (const body of [notification, [notification]]) {
    const res = await p.post(JSON.stringify(body));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
});
