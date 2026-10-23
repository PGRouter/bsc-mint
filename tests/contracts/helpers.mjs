import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
export const addresses={market:'0xfaD7D1300e43A7b8F0b5a2FE5eF9A306f89c6EfC',usdt:'0x55d398326f99059fF775485246999027B3197955',relic:'0xe8C6b38b5E63377a96b268319B66638f772254bb',loom:'0x94C7e58e1412593eEE7456982EFC6F75BB08D02e',recipient:'0x3D91889209f9ca69b7Cb73D7a8C463f4deFB5c15',protocol:'0x0000000000000000000000000000000000001234'};
export const erc20=parseAbi(['function balanceOf(address) view returns(uint256)']);
export const nft=parseAbi(['function ownerOf(uint256) view returns(address)','function approve(address,uint256)','function getApproved(uint256) view returns(address)','function safeTransferFrom(address,address,uint256)']);
export const market=parseAbi(['function bid(uint256) view returns(address buyer,uint8 asset,uint256 price,uint32 remaining,uint16 feeBps,uint64 createdAt)']);
export function compileMocks(){const input={language:'Solidity',sources:{'contracts/test/Mocks.sol':{content:readFileSync('contracts/test/Mocks.sol','utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.deployedBytecode.object','evm.bytecode.object']}}}};const output=JSON.parse(solc.compile(JSON.stringify(input),{import:path=>({contents:readFileSync('node_modules/'+path,'utf8')})}));if(output.errors?.some(e=>e.severity==='error'))throw Error(output.errors.map(e=>e.formattedMessage).join('\n'));return output.contracts['contracts/test/Mocks.sol'];}
export async function startEvm({forkUrl,blockNumber}={}){
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const binary=['node_modules/@foundry-rs/anvil/anvil','node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil','node_modules/@foundry-rs/anvil-darwin-arm64/bin/anvil'].find(existsSync);if(!binary)throw Error('Anvil binary unavailable');
 const args=['--port',String(port),'--host','127.0.0.1','--chain-id','56','--silent'];if(forkUrl)args.push('--fork-url',forkUrl,...(blockNumber?['--fork-block-number',String(blockNumber)]:[]));
 const child=spawn(binary,args,{env:{...process.env,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b.toString();if(forkUrl)console.log('Anvil diagnostic',b.toString().replace(/https?:[^\s"']+/g,'[RPC]'));});
 const transport=http(`http://127.0.0.1:${port}`,{retryCount:0});const client=createPublicClient({transport});let ready=false;for(let i=0;i<600;i++){try{await client.getChainId();ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}if(!ready){child.kill();throw Error('Local Anvil failed to start: '+diagnostic.replace(/https?:[^\s"']+/g,'[RPC]'));}
 const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');const wallet=createWalletClient({account,transport});
 const send=async(address,abi,functionName,args=[],from=account.address)=>{await client.request({method:'anvil_impersonateAccount',params:[from]});await client.request({method:'anvil_setBalance',params:[from,'0x56bc75e2d63100000']});const hash=await wallet.writeContract({account:from,address,abi,functionName,args,chain:null,gas:8000000n});return client.waitForTransactionReceipt({hash});};
 const deploy=async(artifact)=>{const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode??'0x'+artifact.evm.bytecode.object,chain:null,gas:8000000n});const receipt=await client.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('Deployment failed');return receipt.contractAddress;};
 return {client,wallet,account,send,deploy,close:()=>{child.kill();}};
}
