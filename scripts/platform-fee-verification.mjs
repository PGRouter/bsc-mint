import { getContractAddress, keccak256 } from "viem";

// Independent deployment-time expectations: never accept values supplied by a wallet or artifact.
const expected = {
  market: "0xfaD7D1300e43A7b8F0b5a2FE5eF9A306f89c6EfC",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  relic: "0xe8C6b38b5E63377a96b268319B66638f772254bb",
  loom: "0x94C7e58e1412593eEE7456982EFC6F75BB08D02e",
  feeRecipient: "0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15",
  platformFeeBps: 50n,
};
export class VerificationError extends Error {}
const reject = message => { throw new VerificationError(message); };

/** Read-only verification. Returns activation values only after all receipt/config checks pass. */
export async function verifyRouterDeployment(client, hash, artifact) {
  if (await client.getChainId() !== 56) reject("网络不是 BSC 主网（56）");
  if (keccak256(artifact.deployedBytecode) !== artifact.runtimeHash || keccak256(artifact.bytecode) !== artifact.bytecodeHash) reject("本地构建产物摘要不匹配，请先重新编译");
  const [receipt, transaction, latest] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), client.getBlockNumber(),
  ]);
  if (receipt.status !== "success" || !receipt.contractAddress || transaction.to !== null || transaction.value !== 0n) reject("交易不是成功的零金额合约部署");
  if (transaction.input.toLowerCase() !== artifact.bytecode.toLowerCase()) reject("部署交易字节码与本地已审核合约不同");
  if (receipt.blockNumber + 2n > latest) reject("部署交易尚未达到 3 次区块确认");
  const address = receipt.contractAddress;
  if (getContractAddress({ from: transaction.from, nonce: BigInt(transaction.nonce) }).toLowerCase() !== address.toLowerCase()) reject("部署地址与交易发送者及 nonce 不符");
  const code = await client.getBytecode({ address });
  if (!code || keccak256(code) !== artifact.runtimeHash) reject("链上运行代码与已审核合约不同");
  for (const [functionName, value] of Object.entries(expected)) {
    const actual = await client.readContract({ address, abi: artifact.abi, functionName });
    if (typeof value === "bigint" ? actual !== value : typeof actual !== "string" || actual.toLowerCase() !== value.toLowerCase()) reject(`合约 ${functionName} 配置不符`);
  }
  return { address, startBlock: receipt.blockNumber, transactionHash: hash, runtimeHash: artifact.runtimeHash };
}
