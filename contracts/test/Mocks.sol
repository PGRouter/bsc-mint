// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ERC721} from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';

contract MockToken {
    mapping(address => uint256) public balanceOf;
    address public failTo;
    uint8 public mode;
    address public callback;
    bytes public callbackData;
    function mint(address who,uint256 value) external {balanceOf[who]+=value;}
    function configure(address to,uint8 m,address cb,bytes calldata data) external { failTo=to;mode=m;callback=cb;callbackData=data; }
    function transfer(address to,uint256 value) external returns(bool) {
        if(to==failTo && mode==1) return false;
        if(to==failTo && mode==2) revert('PAYMENT');
        if(callback!=address(0)) { (bool ok,)=callback.call(callbackData); require(ok,'CALLBACK'); }
        balanceOf[msg.sender]-=value; balanceOf[to]+=value;
        if(to==failTo && mode==4) balanceOf[to]-=1;
        if(mode==3 && (failTo==address(0) || to==failTo)) assembly { return(0,0) }
        return true;
    }
}
contract MockNFT is ERC721 {
    bool public failTransfer;
    constructor() ERC721('Mock','M') {}
    function mint(address to,uint256 id) external {_mint(to,id);}
    function setFail(bool value) external {failTransfer=value;}
    function transferFrom(address from,address to,uint256 id) public override {require(!failTransfer,'NFTFAIL'); super.transferFrom(from,to,id);}
}
contract MockMarket {
    struct Bid {address buyer;uint8 asset;uint256 price;uint32 remaining;uint16 feeBps;uint64 createdAt;}
    mapping(uint256=>Bid) public bid;
    address constant TOKEN=0x55d398326f99059fF775485246999027B3197955;
    address constant RELIC=0xe8C6b38b5E63377a96b268319B66638f772254bb;
    address constant LOOM=0x94C7e58e1412593eEE7456982EFC6F75BB08D02e;
    address public constant feeRecipient=address(0x1234);
    uint8 public fault;
    event BidFilled(uint256 indexed id,address indexed seller,address indexed buyer,uint8 asset,uint256 tokenId,uint256 price,uint256 fee);
    function setBid(uint256 id,address buyer,uint8 asset,uint256 price,uint32 qty,uint16 fee) external {bid[id]=Bid(buyer,asset,price,qty,fee,1);}
    function setFault(uint8 value) external {fault=value;}
    function fill(uint256 id,uint256[] calldata ids) external {
        Bid memory b=bid[id];require(b.remaining>0 && b.buyer!=msg.sender,'ORDER');
        if(fault!=1) {if(b.remaining==1) delete bid[id];else bid[id].remaining--;}
        if(fault!=2) IERC721(b.asset==0?RELIC:LOOM).safeTransferFrom(msg.sender,b.buyer,ids[0]);
        uint256 fee=b.price*b.feeBps/10000;
        require(IERC20(TOKEN).transfer(feeRecipient,fee));
        require(IERC20(TOKEN).transfer(msg.sender,b.price-fee-(fault==3?1:0)));
        emit BidFilled(id,msg.sender,b.buyer,b.asset,ids[0],b.price,fee);
    }
}
contract CallbackBuyer {
    address public target;bytes public data;
    function configure(address t,bytes calldata d) external {target=t;data=d;}
    function onERC721Received(address,address,uint256,bytes calldata) external returns(bytes4) {
        (bool ok,)=target.call(data);require(ok,'REENTER');return this.onERC721Received.selector;
    }
}
