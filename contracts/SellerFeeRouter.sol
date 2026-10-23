// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import {IERC721Receiver} from '@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

interface IOriginalMarket {
    function bid(uint256 id) external view returns(address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 feeBps,uint64 createdAt);
    function fill(uint256 id,uint256[] calldata tokenIds) external;
}

/// @notice Single-NFT seller settlement for the fixed BSC market. Buyers never approve this router.
contract SellerFeeRouter is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant market=0xfaD7D1300e43A7b8F0b5a2FE5eF9A306f89c6EfC;
    address public constant usdt=0x55d398326f99059fF775485246999027B3197955;
    address public constant relic=0xe8C6b38b5E63377a96b268319B66638f772254bb;
    address public constant loom=0x94C7e58e1412593eEE7456982EFC6F75BB08D02e;
    address public constant feeRecipient=0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15;
    uint256 public constant platformFeeBps=50;
    address private receivingNft;
    address private receivingSeller;
    uint256 private receivingToken;

    error WrongChain();
    error InvalidOrder();
    error Expired();
    error SelfTrade();
    error NotOwner();
    error MinimumProceeds();
    error UnexpectedNFT();
    error SettlementMismatch();

    event PlatformSale(uint256 indexed bidId,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 gross,uint256 marketFee,uint256 platformFee,uint256 proceeds);

    constructor(){if(block.chainid!=56) revert WrongChain();}

    function quote(uint256 bidId) public view returns(address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 marketFeeBps,uint256 marketFee,uint256 platformFee,uint256 proceeds){
        (buyer,asset,price,remaining,marketFeeBps,)=IOriginalMarket(market).bid(bidId);
        if(buyer==address(0)||buyer==address(this)||asset>1||price==0||remaining==0||uint256(marketFeeBps)+platformFeeBps>10000) revert InvalidOrder();
        marketFee=Math.mulDiv(price,marketFeeBps,10000);
        platformFee=Math.mulDiv(price,platformFeeBps,10000);
        proceeds=price-marketFee-platformFee;
    }

    function sell(uint256 bidId,uint256 tokenId,uint256 minProceeds,uint256 deadline) external nonReentrant {
        if(block.timestamp>deadline) revert Expired();
        (address buyer,uint8 asset,uint256 gross,uint32 remaining,uint16 feeBps,uint256 marketFee,uint256 platformFee,uint256 proceeds)=quote(bidId);
        if(buyer==msg.sender) revert SelfTrade();
        if(proceeds<minProceeds) revert MinimumProceeds();
        IERC721 nft=IERC721(asset==0?relic:loom);
        if(nft.ownerOf(tokenId)!=msg.sender) revert NotOwner();
        IERC20 token=IERC20(usdt);
        uint256 initialBalance=token.balanceOf(address(this));
        receivingNft=address(nft);receivingSeller=msg.sender;receivingToken=tokenId;
        nft.safeTransferFrom(msg.sender,address(this),tokenId);
        if(receivingNft!=address(0)||nft.ownerOf(tokenId)!=address(this)) revert UnexpectedNFT();
        nft.approve(market,tokenId);
        uint256[] memory ids=new uint256[](1);ids[0]=tokenId;
        IOriginalMarket(market).fill(bidId,ids);
        if(nft.ownerOf(tokenId)!=buyer||token.balanceOf(address(this))!=initialBalance+gross-marketFee) revert SettlementMismatch();
        (address nextBuyer,uint8 nextAsset,uint256 nextPrice,uint32 nextRemaining,uint16 nextFee,)=IOriginalMarket(market).bid(bidId);
        if(nextRemaining!=remaining-1) revert SettlementMismatch();
        if(nextRemaining>0&&(nextBuyer!=buyer||nextAsset!=asset||nextPrice!=gross||nextFee!=feeBps)) revert SettlementMismatch();
        uint256 recipientBefore=token.balanceOf(feeRecipient);
        uint256 sellerBefore=token.balanceOf(msg.sender);
        if(platformFee>0) token.safeTransfer(feeRecipient,platformFee);
        if(proceeds>0) token.safeTransfer(msg.sender,proceeds);
        if(token.balanceOf(address(this))!=initialBalance) revert SettlementMismatch();
        if(msg.sender==feeRecipient){
            if(token.balanceOf(msg.sender)!=sellerBefore+platformFee+proceeds) revert SettlementMismatch();
        }else{
            if(token.balanceOf(feeRecipient)!=recipientBefore+platformFee||token.balanceOf(msg.sender)!=sellerBefore+proceeds) revert SettlementMismatch();
        }
        emit PlatformSale(bidId,msg.sender,buyer,asset,tokenId,gross,marketFee,platformFee,proceeds);
    }

    function onERC721Received(address operator,address from,uint256 tokenId,bytes calldata) external returns(bytes4){
        if(msg.sender!=receivingNft||operator!=address(this)||from!=receivingSeller||tokenId!=receivingToken) revert UnexpectedNFT();
        delete receivingNft;delete receivingSeller;delete receivingToken;
        return IERC721Receiver.onERC721Received.selector;
    }
}
