import { encodeDeployData, keccak256, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { PLATFORM_FEE_BYTECODE_HASH, PLATFORM_FEE_RUNTIME_HASH, PLATFORM_FEE_SOURCE_HASH } from "@/lib/platform-fee-runtime";

export type RouterArtifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; runtimeHash: Hex; sourceHash: string; compiler: string };
type DeploymentClient = Pick<PublicClient, "getChainId" | "estimateGas" | "getGasPrice">;

/** Deployment is prepared by reads only. The caller must explicitly request a wallet signature. */
export async function preparePlatformDeployment(client: DeploymentClient, account: Address, artifact: RouterArtifact) {
  if (await client.getChainId() !== 56) throw new Error("请切换到 BSC 主网（56）");
  if (!/^0x[0-9a-f]+$/i.test(artifact.bytecode) || artifact.bytecode.length < 100) throw new Error("部署字节码无效");
  if (keccak256(artifact.bytecode) !== PLATFORM_FEE_BYTECODE_HASH) throw new Error("部署字节码与已审核版本不一致");
  if (artifact.sourceHash !== PLATFORM_FEE_SOURCE_HASH || artifact.runtimeHash !== PLATFORM_FEE_RUNTIME_HASH || keccak256(artifact.deployedBytecode) !== PLATFORM_FEE_RUNTIME_HASH) throw new Error("合约构建产物与已审核版本不一致");
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode });
  const [gas, gasPrice] = await Promise.all([
    client.estimateGas({ account, data, value: 0n }),
    client.getGasPrice(),
  ]);
  return { account, data, gas, gasPrice, estimatedCost: gas * gasPrice };
}
