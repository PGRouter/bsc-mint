import { formatUnits } from "viem";

/** Readable number/address/time formatting shared by all pages. */
export class Fmt {
  static n(v: number, d = 2) { return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : "-"; }
  static compact(v: number) { return Math.abs(v) >= 1e4 ? v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : Fmt.n(v); }
  /** bigint with `dec` decimals -> grouped string with at most `d` fraction digits. */
  static units(v: bigint | undefined, dec = 18, d = 4) { return v === undefined ? "-" : Fmt.n(Number(formatUnits(v, dec)), d); }
  static addr(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
  static time(ts: number) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour12: false }) : "-"; }
  static period(s: number) { return s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`; }
  static pct(v: number) { return `${Math.floor(Math.max(0, Math.min(1, v)) * 100)}%`; }
}
