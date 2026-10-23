import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "BSC Mint Monitor", description: "Read-only on-chain monitor for BSC mint and market contracts" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
