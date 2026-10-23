import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { verifyRouterDeployment, VerificationError } from "./platform-fee-verification.mjs";

// RPC credentials remain server-side; do not put them in command arguments or output.
try { process.loadEnvFile(new URL("../.env.local", import.meta.url)); } catch { /* environment may already be supplied */ }
const hash = process.argv[2];
if (!/^0x[0-9a-f]{64}$/i.test(hash ?? "")) {
  console.error("用法：npm run verify:platform-fee -- <部署交易哈希>"); process.exitCode = 1;
} else {
  const rpc = (process.env.HISTORY_RPC_URL || process.env.BSC_RPC_URL || "").split(",").map(value => value.trim()).find(Boolean);
  if (!rpc) { console.error("请在本地环境配置服务端 BSC_RPC_URL 或 HISTORY_RPC_URL"); process.exitCode = 1; }
  else try {
    const artifact = JSON.parse(readFileSync(new URL("../lib/platform-fee-bytecode.json", import.meta.url), "utf8"));
    const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 15000, retryCount: 1 }) });
    const verified = await verifyRouterDeployment(client, hash, artifact);
    console.log("链上部署核验通过；以下配置需在网站重新构建发布后生效：");
    console.log(`NEXT_PUBLIC_PLATFORM_FEE_ROUTER=${verified.address}`);
    console.log(`NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK=${verified.startBlock}`);
    console.log(`部署交易：${verified.transactionHash}`);
    console.log(`运行代码摘要：${verified.runtimeHash}`);
  } catch (error) {
    console.error(error instanceof VerificationError ? error.message : "RPC 读取或核验失败，请检查节点和交易后重试（未修改任何配置）"); process.exitCode = 1;
  }
}
