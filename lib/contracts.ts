import { parseAbi, type Address } from "viem";

/**
 * Contract addresses and the minimal read-only ABI surface.
 *
 * Addresses: taken from the reference site's config and cross-checked on-chain
 * (market.game()/relic()/loom()/usdt() and game.relic()/market() all point at each other).
 * Methods/events: human-readable fragments copied from the reference frontend bundle,
 * and every selector/topic below was confirmed present in the deployed bytecode.
 * The contracts are NOT source-verified on BscScan; see the PR for details.
 */
export class Contracts {
  static readonly game: Address = "0xB0D5f3108aF164f5F7046F53ab59FD2779812d10";
  static readonly relic: Address = "0xe8C6b38b5E63377a96b268319B66638f772254bb";
  static readonly loom: Address = "0x94C7e58e1412593eEE7456982EFC6F75BB08D02e";
  static readonly market: Address = "0xfaD7D1300e43A7b8F0b5a2FE5eF9A306f89c6EfC";
  /** = market.usdt() on-chain (BSC-USD). */
  static readonly usdt: Address = "0x55d398326f99059fF775485246999027B3197955";
  /** = game.handleRegistry() on-chain (.ai Agent ID registry). */
  static readonly handleRegistry: Address = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";

  /** Custom errors from the reference frontend bundle, used to decode revert reasons. */
  static readonly errorsAbi = parseAbi([
    "error BnbTransferFailed(address recipient)",
    "error InvalidConfig()",
    "error MintNotStarted(uint64 startTime)",
    "error NoBnbMintMatch(uint256 value, uint8 minted)",
    "error NoHandle(address account)",
    "error QuotaExceeded(bytes32 handleHash, uint8 minted, uint8 requested)",
    "error SoldOut(uint256 remaining)",
    "error ERC721NonexistentToken(uint256 tokenId)",
    "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
    "error ERC721InvalidApprover(address approver)",
    "error ERC721NonexistentToken(uint256 tokenId)",
    "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
  ]);

  /** Market write surface: fragments from the reference bundle, selectors confirmed in bytecode, behaviour checked on a local fork. */
  static readonly marketWriteAbi = parseAbi([
    "function placeBid(uint8 asset, uint256 price, uint32 quantity) returns (uint256 id)",
    "function cancelBid(uint256 id)",
    "function fill(uint256 id, uint256[] tokenIds)",
  ]);

  /** Per-token NFT approval (no setApprovalForAll: approvals are scoped to exactly what is sold). */
  static readonly nftApproveAbi = parseAbi([
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function getApproved(uint256 tokenId) view returns (address)",
    "function isApprovedForAll(address owner, address operator) view returns (bool)",
    "function approve(address to, uint256 tokenId)",
  ]);

  static readonly mintAbi = parseAbi([
    "function quote(address account, uint8 n) view returns (uint256 cost, uint8 remaining)",
    "function quoteBnb(address account, uint8 n) view returns (uint256 cost, uint8 remaining)",
    "function mint(uint8 n)",
    "error MintNotStarted(uint64 startTime)",
    "error NoHandle(address account)",
    "error QuotaExceeded(bytes32 handleHash, uint8 minted, uint8 requested)",
    "error SoldOut(uint256 remaining)",
    "error NoBnbMintMatch(uint256 value, uint8 minted)",
  ]);

  static readonly erc20Abi = parseAbi([
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);

  static readonly registryAbi = parseAbi(["function handleOf(address account) view returns (string handle)"]);

  static readonly gameAbi = parseAbi([
    "struct Config { uint256 firstPrice; uint256 paidPrice; uint8 perHandle; uint8 loomSize; uint256 firstPriceBnb; uint256 paidPriceBnb; }",
    "function config() view returns (Config)",
    "function publicMinted() view returns (uint256)",
    "function publicCap() view returns (uint256 cap)",
    "function mintStartTime() view returns (uint64)",
    "function requireHandle() view returns (bool)",
  ]);

  static readonly marketAbi = parseAbi([
    "function feeBps() view returns (uint16)",
    "event BidPlaced(uint256 indexed id, address indexed buyer, uint8 indexed asset, uint256 price, uint32 quantity, uint16 feeBps)",
    "event BidCancelled(uint256 indexed id, uint32 refundedQty, uint256 refundedUsdt)",
    "event BidFilled(uint256 indexed id, address indexed seller, address indexed buyer, uint8 asset, uint256 tokenId, uint256 price, uint256 fee)",
  ]);

  static readonly erc721Abi = parseAbi([
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  ]);
}
