import { createConfig, http } from "wagmi";
import { bsc } from "wagmi/chains";
import { injected } from "@wagmi/core";

/** Client wallet config: BSC only, injected wallets only, reads proxied through /api/rpc (no RPC URL in the browser). */
export class WalletConfig {
  static readonly chain = bsc;
  static readonly config = createConfig({
    chains: [bsc],
    connectors: [injected()],
    transports: { [bsc.id]: http("/api/rpc") },
    ssr: true,
  });
}
