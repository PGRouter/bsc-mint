import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getContractAddress, keccak256 } from "viem";
import { loadModule, panelHarness } from "./helpers.mjs";
import { verifyRouterDeployment } from "../scripts/platform-fee-verification.mjs";

const artifact = JSON.parse(readFileSync(new URL("../lib/platform-fee-bytecode.json", import.meta.url), "utf8"));
const account = "0x1111111111111111111111111111111111111111";
const { preparePlatformDeployment } = loadModule("lib/platform-deployment.ts");
const hash = `0x${"12".repeat(32)}`;
const address = getContractAddress({ from: account, nonce: 0n });
const configuration = {
  market: "0xfaD7D1300e43A7b8F0b5a2FE5eF9A306f89c6EfC", usdt: "0x55d398326f99059fF775485246999027B3197955",
  relic: "0xe8C6b38b5E63377a96b268319B66638f772254bb", loom: "0x94C7e58e1412593eEE7456982EFC6F75BB08D02e",
  feeRecipient: "0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15", platformFeeBps: 50n,
};
const client = () => ({
  getChainId: async () => 56, estimateGas: async () => 1_000_000n, getGasPrice: async () => 1_000_000_000n,
  getTransactionReceipt: async () => ({ status: "success", contractAddress: address, blockNumber: 100n }),
  getTransaction: async () => ({ to: null, value: 0n, input: artifact.bytecode, from: account, nonce: 0 }),
  getBlockNumber: async () => 102n, getBytecode: async () => artifact.deployedBytecode,
  readContract: async ({ functionName }) => configuration[functionName],
});

test("deployment preparation estimates only the reviewed zero-value creation transaction", async () => {
  const c = client(); let request;
  c.estimateGas = async value => { request = value; return 1_000_000n; };
  const prepared = await preparePlatformDeployment(c, account, artifact);
  assert.equal(request.value, 0n); assert.equal(request.account, account); assert.equal(request.data, artifact.bytecode);
  assert.equal(prepared.estimatedCost, 1_000_000_000_000_000n);
  assert.equal("sendTransaction" in c, false);
});

test("deployment rejects wrong chain and altered creation code before gas estimation", async () => {
  const c = client(); c.getChainId = async () => 1;
  await assert.rejects(preparePlatformDeployment(c, account, artifact), /BSC/);
  await assert.rejects(preparePlatformDeployment(client(), account, { ...artifact, bytecode: artifact.bytecode + "00" }), /字节码/);
});

test("activation verifier requires successful exact code and fixed seller-only configuration", async () => {
  const result = await verifyRouterDeployment(client(), hash, artifact);
  assert.equal(result.address, address); assert.equal(result.startBlock, 100n);
  assert.equal(result.runtimeHash, keccak256(artifact.deployedBytecode));
});

for (const [name, mutate, reason] of [
  ["wrong chain", c => { c.getChainId = async () => 97; }, /BSC/],
  ["reverted deployment", c => { c.getTransactionReceipt = async () => ({ status: "reverted" }); }, /成功/],
  ["nonzero BNB value", c => { const get = c.getTransaction; c.getTransaction = async () => ({ ...await get(), value: 1n }); }, /零金额/],
  ["different creation code", c => { const get = c.getTransaction; c.getTransaction = async () => ({ ...await get(), input: "0x1234" }); }, /字节码/],
  ["insufficient confirmations", c => { c.getBlockNumber = async () => 101n; }, /3 次/],
  ["different runtime", c => { c.getBytecode = async () => "0x1234"; }, /运行代码/],
  ["different recipient", c => { c.readContract = async ({ functionName }) => functionName === "feeRecipient" ? account : configuration[functionName]; }, /feeRecipient/],
  ["different rate", c => { c.readContract = async ({ functionName }) => functionName === "platformFeeBps" ? 100n : configuration[functionName]; }, /platformFeeBps/],
]) test(`activation rejects ${name}`, async () => {
  const c = client(); mutate(c); await assert.rejects(verifyRouterDeployment(c, hash, artifact), reason);
});

function deploymentHarness({ connected = true, chain = 56, configured } = {}) {
  const gate = { address: connected ? account : undefined, ok: connected && chain === 56 };
  const c = client(); let signatures = 0;
  const wallet = { chain: { id: chain }, getChainId: async () => chain, getAddresses: async () => [gate.address],
    deployContract: async () => { signatures++; return hash; } };
  c.waitForTransactionReceipt = c.getTransactionReceipt;
  const h = panelHarness("app/platform-fee/panel.tsx", { mocks: {
    wagmi: { usePublicClient: () => c, useWalletClient: () => ({ data: connected ? wallet : undefined }) },
    "@/components/wallet": { useWalletGate: () => gate },
    "@/lib/platform-fee": { PLATFORM_FEE_RECIPIENT: configuration.feeRecipient, platformFeeRouterAddress: () => configured },
    "@/lib/platform-fee-bytecode.json": { default: artifact },
  } });
  return { h, gate, signatures: () => signatures };
}

for (const options of [{ connected: false }, { chain: 97 }, { configured: address }]) {
  test(`deployment page cannot prepare or sign in gated state ${JSON.stringify(options)}`, async () => {
    const { h, signatures } = deploymentHarness(options); await h.flush();
    assert.equal(h.byId("prepare-deploy").props.disabled, true);
    await h.byId("prepare-deploy").props.onClick(); await h.flush();
    assert.equal(h.byId("deploy-router"), undefined); assert.equal(signatures(), 0);
  });
}

test("deployment page estimates on explicit click and waits for user consent and another click", async () => {
  const { h, signatures } = deploymentHarness(); await h.flush();
  assert.equal(signatures(), 0); assert.equal(h.byId("deploy-router"), undefined);
  await h.byId("prepare-deploy").props.onClick(); await h.flush();
  assert.equal(signatures(), 0); assert.equal(h.byId("deploy-router").props.disabled, true);
  await h.byId("deploy-router").props.onClick(); assert.equal(signatures(), 0);
  h.all().find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } });
  await h.flush(); assert.equal(h.byId("deploy-router").props.disabled, false);
  await h.byId("deploy-router").props.onClick(); await h.flush();
  assert.equal(signatures(), 1);
});

test("wallet changes after deployment estimate prevent signing", async () => {
  const { h, gate, signatures } = deploymentHarness(); await h.flush();
  await h.byId("prepare-deploy").props.onClick(); await h.flush();
  h.all().find(n => n.type === "input").props.onChange({ target: { checked: true } }); await h.flush();
  gate.ok = false; h.render();
  const button = h.byId("deploy-router"); assert.equal(button.props.disabled, true);
  await button.props.onClick(); assert.equal(signatures(), 0);
});
