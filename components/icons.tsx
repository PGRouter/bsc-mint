import type { ReactNode } from "react";

type IconName = "brand" | "chart" | "activity" | "layers" | "wallet" | "arrow-right" | "arrow-up-right" | "globe" | "check" | "external" | "coins" | "chevron-down" | "swap" | "shield" | "clock" | "spark" | "grid" | "plus" | "copy" | "info" | "x" | "github";

const paths: Record<Exclude<IconName, "brand">, ReactNode> = {
  chart: <><path d="M4 4v16h16M8 15l4-5 4 2 4-7" /><path d="M16 5h4v4" /></>,
  activity: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
  wallet: <><path d="M20 7V5a2 2 0 0 0-2-2L5 6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5" /><path d="M21 12h-5v5h5M17.5 14.5h.01" /></>,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  "arrow-up-right": <path d="M6 18 18 6M6 6h12v12" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  external: <><path d="M14 3h7v7m0-7L11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></>,
  coins: <><ellipse cx="10" cy="6" rx="7" ry="3" /><path d="M3 6v5c0 1.7 3.1 3 7 3 1 0 2-.1 3-.3M3 11v5c0 1.7 3.1 3 7 3h1M17 6v4" /><ellipse cx="17" cy="13" rx="4" ry="2" /><path d="M13 13v6c0 1.1 1.8 2 4 2s4-.9 4-2v-6M13 16c0 1.1 1.8 2 4 2s4-.9 4-2" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  swap: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4 4-4-4 4-4" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  x: <><path d="M4 3h5l11 18h-5L4 3ZM20 3 4 21" /></>,
  github: <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "brand" ? <g fill="currentColor" stroke="none"><path d="m12 1 9 5.2v10.6L12 22l-9-5.2V6.2L12 1Zm0 4.6L7 8.5v5.8l5 2.9 5-2.9V8.5l-5-2.9Z" fillRule="evenodd" /><path d="m12 8.5 3.1 1.8v3.6L12 15.7l-3.1-1.8v-3.6L12 8.5Z" /></g> : paths[name]}
  </svg>;
}
