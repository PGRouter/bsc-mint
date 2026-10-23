import { getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { Contracts } from "@/lib/contracts";
import { PLATFORM_FEE_RUNTIME_HASH } from "@/lib/platform-fee-runtime";

export const PLATFORM_FEE_BPS = 50n;
export const PLATFORM_FEE_RECIPIENT: Address = "0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15";
export const PLATFORM_SALE_ABI = parseAbi([
  "event PlatformSale(uint256 indexed bidId,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 gross,uint256 marketFee,uint256 platformFee,uint256 proceeds)",
]);
export const PLATFORM_FEE_ABI = parseAbi([
  "function market() view returns (address)",
  "function usdt() view returns (address)",
  "function relic() view returns (address)",
  "function loom() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function quote(uint256 bidId) view returns (address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 marketFeeBps,uint256 marketFee,uint256 platformFee,uint256 proceeds)",
  "function sell(uint256 bidId,uint256 tokenId,uint256 minProceeds,uint256 deadline)",
  "event PlatformSale(uint256 indexed bidId,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 gross,uint256 marketFee,uint256 platformFee,uint256 proceeds)",
]);
export const MARKET_BID_ABI = parseAbi([
  "function bid(uint256 id) view returns (address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 feeBps,uint64 time)",
]);
export type SellerQuote = {
  buyer: Address; asset: number; gross: bigint; remaining: number; marketFeeBps: bigint;
  marketFee: bigint; platformFee: bigint; proceeds: bigint; spender: Address; routed: boolean;
};
type ReadClient = Pick<PublicClient, "getChainId" | "getBytecode" | "readContract">;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A configured but invalid router must never silently become a fee-free route. */
export function platformFeeRouterAddress(): Address | undefined {
  const value = process.env.NEXT_PUBLIC_PLATFORM_FEE_ROUTER?.trim();
  if (!value) return undefined;
  if (!isAddress(value) || sameAddress(value, zeroAddress)) throw new Error("Invalid platform fee router configuration");
  if (!platformFeeStartBlock()) throw new Error("Platform router deployment block is missing");
  return getAddress(value);
}

/** A configured route must have an indexable deployment boundary before activation. */
export function platformFeeStartBlock(): bigint | undefined {
  const value = process.env.NEXT_PUBLIC_PLATFORM_FEE_START_BLOCK;
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid platform fee start block");
  return BigInt(value);
}

export function calculateSaleQuote(gross: bigint, marketFeeBps: bigint, platformFeeBps = PLATFORM_FEE_BPS) {
  if (gross <= 0n || marketFeeBps < 0n || platformFeeBps < 0n || marketFeeBps + platformFeeBps > 10000n) throw new Error("Invalid sale fees");
  const marketFee = gross * marketFeeBps / 10000n;
  const platformFee = gross * platformFeeBps / 10000n;
  return { gross, marketFeeBps, marketFee, platformFee, proceeds: gross - marketFee - platformFee };
}

/** Verify deployed runtime and all fixed constants on every live quote / pre-sign check. */
export async function verifyPlatformFeeRouter(client: ReadClient, router: Address): Promise<void> {
  if (await client.getChainId() !== 56) throw new Error("Switch to BSC (56)");
  const code = await client.getBytecode({ address: router });
  if (!code || code === "0x" || keccak256(code) !== PLATFORM_FEE_RUNTIME_HASH) throw new Error("Platform router runtime mismatch");
  const names = ["market", "usdt", "relic", "loom", "feeRecipient", "platformFeeBps"] as const;
  const expected = [Contracts.market, Contracts.usdt, Contracts.relic, Contracts.loom, PLATFORM_FEE_RECIPIENT];
  const values = await Promise.all(names.map(functionName => client.readContract({ address: router, abi: PLATFORM_FEE_ABI, functionName })));
  for (let i = 0; i < expected.length; i++) if (typeof values[i] !== "string" || !sameAddress(String(values[i]), expected[i])) throw new Error(`Platform router ${names[i]} mismatch`);
  if (BigInt(values[5] as bigint) !== PLATFORM_FEE_BPS) throw new Error("Platform router fee mismatch");
}

export async function readSellerQuote(client: ReadClient, input: { router?: Address; bidId: bigint; asset: number; seller: Address }): Promise<SellerQuote> {
  if (await client.getChainId() !== 56) throw new Error("Switch to BSC (56)");
  if (input.router) await verifyPlatformFeeRouter(client, input.router);
  const [buyer, asset, price, remaining, bps] = await client.readContract({ address: Contracts.market, abi: MARKET_BID_ABI, functionName: "bid", args: [input.bidId] });
  if (sameAddress(buyer, zeroAddress) || sameAddress(buyer, input.seller) || asset !== input.asset || remaining < 1) throw new Error("Bid no longer available for this seller / asset");
  const amounts = calculateSaleQuote(price, BigInt(bps), input.router ? PLATFORM_FEE_BPS : 0n);
  if (input.router) {
    const quote = await client.readContract({ address: input.router, abi: PLATFORM_FEE_ABI, functionName: "quote", args: [input.bidId] });
    const expected = [buyer.toLowerCase(), asset, price, remaining, bps, amounts.marketFee, amounts.platformFee, amounts.proceeds];
    if (quote.some((value, i) => (typeof value === "string" ? value.toLowerCase() : value) !== expected[i])) throw new Error("Platform quote changed or disagrees with market order");
  }
  return { ...amounts, buyer, asset, remaining, spender: input.router ?? Contracts.market, routed: !!input.router };
}

export function sameSellerQuote(a: SellerQuote, b: SellerQuote): boolean {
  return a.buyer.toLowerCase() === b.buyer.toLowerCase() && a.spender.toLowerCase() === b.spender.toLowerCase() &&
    a.asset === b.asset && a.gross === b.gross && a.remaining === b.remaining && a.marketFeeBps === b.marketFeeBps &&
    a.marketFee === b.marketFee && a.platformFee === b.platformFee && a.proceeds === b.proceeds && a.routed === b.routed;
}

export async function readNftSaleState(client: ReadClient, nft: Address, tokenId: bigint, seller: Address, spender: Address) {
  const [owner, approved, approvedForAll] = await Promise.all([
    client.readContract({ address: nft, abi: Contracts.nftApproveAbi, functionName: "ownerOf", args: [tokenId] }),
    client.readContract({ address: nft, abi: Contracts.nftApproveAbi, functionName: "getApproved", args: [tokenId] }),
    client.readContract({ address: nft, abi: Contracts.nftApproveAbi, functionName: "isApprovedForAll", args: [seller, spender] }),
  ]);
  if (!sameAddress(owner, seller)) throw new Error("NFT is no longer owned by the connected wallet");
  return { approved: sameAddress(approved, spender) || approvedForAll };
}
