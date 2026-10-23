import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { decodeEventLog, parseAbi } from 'viem';
import { addresses as a,startEvm,erc20,nft,market } from './helpers.mjs';

// The upstream endpoint is never passed to child processes or printed. All writes
// go to disposable localhost Anvil. The proxy permits read-only upstream methods.
async function readProxy(){
 const env=readFileSync('.env.local','utf8');
 const get=name=>{const line=env.split(/\r?\n/).find(line=>line.startsWith(name+'='));return line?.slice(name.length+1).trim().replace(/^["']|["']$/g,'');};
 const url=(get('HISTORY_RPC_URL')??get('BSC_RPC_URL'))?.split(',')[0].trim();if(!url)throw Error('Fork requires HISTORY_RPC_URL or BSC_RPC_URL');
 const allowed=new Set(['eth_chainId','eth_gasPrice','eth_getAccountInfo','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_call','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getProof','net_version']);
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;try{const payload=JSON.parse(body);if(!(Array.isArray(payload)?payload:[payload]).every(p=>allowed.has(p.method))){console.log('Rejected upstream method', (Array.isArray(payload)?payload:[payload]).map(p=>p.method));throw Error('Read-only upstream');}const upstream=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(25000)});res.writeHead(upstream.status,{'content-type':'application/json'});res.end(await upstream.text());}catch{res.writeHead(502);res.end('{"error":"read-only upstream unavailable"}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return{url:`http://127.0.0.1:${server.address().port}`,close:()=>server.closeAllConnections()||server.close()};
}

test('BSC fixed-block fork: both NFT collections settle atomically, buyer pays no extra', {timeout:240000}, async t=>{
 const proxy=await readProxy();let evm;
 try{
 evm=await startEvm({forkUrl:proxy.url,blockNumber:129389993});console.log('Local BSC fork started');
 const artifact=JSON.parse(readFileSync('lib/platform-fee-bytecode.json','utf8'));const router=await evm.deploy(artifact);const client=evm.client;
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args});
 const balance=who=>read(a.usdt,erc20,'balanceOf',[who]);
 const feeAbi=parseAbi(['function feeRecipient() view returns(address)']);
 const protocolRecipient=await read(a.market,feeAbi,'feeRecipient');
 const chosen={};
 for(const id of[8241n,8212n]){const b=await read(a.market,market,'bid',[id]);if(b[3]>0&&b[1]<2&&!chosen[b[1]])chosen[b[1]]={id,b};if(chosen[0]&&chosen[1])break;}
 assert.ok(chosen[0]&&chosen[1],'active orders available for both assets');
 for(const asset of[0,1])await t.test(`real ${asset===0?'RELICS':'LOOMS'} fill + minimum rollback`,async()=>{
 const{id,b}=chosen[asset];const[buyer,,gross,qty,bps]=b;const collection=asset===0?a.relic:a.loom;let seller,tokenId;
 for(let id=1n;id<=60n;id++){try{const owner=await read(collection,nft,'ownerOf',[id]);if(owner.toLowerCase()!==buyer.toLowerCase()&&(await client.getCode({address:owner}))===undefined){seller=owner;tokenId=id;break;}}catch{}}
 assert.ok(seller,'a real EOA NFT holder found');
 const quote=await read(router,artifact.abi,'quote',[id]);assert.equal(quote[0].toLowerCase(),buyer.toLowerCase());assert.equal(quote[4],bps);assert.equal(quote[6],gross*50n/10000n);
 assert.equal((await evm.send(collection,nft,'approve',[router,tokenId],seller)).status,'success');
 const parties=[seller,buyer,a.recipient,protocolRecipient,router,a.market];const balances=()=>Promise.all(parties.map(balance));const before=await balances();
 const failed=await evm.send(router,artifact.abi,'sell',[id,tokenId,quote[7]+1n,2n**255n],seller);assert.equal(failed.status,'reverted');assert.deepEqual(await balances(),before);assert.equal(await read(collection,nft,'ownerOf',[tokenId]),seller);assert.equal((await read(a.market,market,'bid',[id]))[3],qty);assert.equal((await read(collection,nft,'getApproved',[tokenId])).toLowerCase(),router.toLowerCase());
 const receipt=await evm.send(router,artifact.abi,'sell',[id,tokenId,quote[7],2n**255n],seller);
 if(receipt.status!=='success'){const trace=await client.request({method:'debug_traceTransaction',params:[receipt.transactionHash,{tracer:'callTracer'}]});console.log('LOCAL_FORK_REVERT',JSON.stringify(trace));}
 assert.equal(receipt.status,'success','real market must accept router as seller and intermediary');
 const after=await balances();const expected=new Map();function add(who,amount){const key=who.toLowerCase();expected.set(key,(expected.get(key)??0n)+amount);}add(seller,quote[7]);add(buyer,0n);add(a.recipient,quote[6]);add(protocolRecipient,quote[5]);add(router,0n);add(a.market,-gross);
 for(let i=0;i<parties.length;i++)assert.equal(after[i]-before[i],expected.get(parties[i].toLowerCase()));
 assert.equal((await read(collection,nft,'ownerOf',[tokenId])).toLowerCase(),buyer.toLowerCase());assert.equal((await read(a.market,market,'bid',[id]))[3],qty-1);assert.equal(await read(collection,nft,'getApproved',[tokenId]),'0x0000000000000000000000000000000000000000');
 const routed=receipt.logs.filter(l=>l.address.toLowerCase()===router.toLowerCase()).map(l=>decodeEventLog({abi:artifact.abi,...l}));assert.equal(routed.length,1);assert.deepEqual(routed[0].args,{bidId:id,seller,buyer,asset,tokenId,gross,marketFee:quote[5],platformFee:quote[6],proceeds:quote[7]});
 console.log(`Verified fork block 129389993 asset ${asset}, bid ${id}, token ${tokenId}, gross ${gross}, orderFeeBps ${bps}`);
 });
 }finally{evm?.close();proxy.close();}
});
