"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { WalletConfig } from "@/lib/wagmi";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  return <WagmiProvider config={WalletConfig.config}><QueryClientProvider client={qc}>{children}</QueryClientProvider></WagmiProvider>;
}
