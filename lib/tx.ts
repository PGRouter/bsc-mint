import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, type Hex } from "viem";
import { Contracts } from "./contracts";

export type TxPhase = "idle" | "simulating" | "signing" | "submitted" | "success" | "failed" | "rejected";

/** Helpers for turning wallet/RPC errors into user-facing states. */
export class TxErrors {
  static isRejected(e: unknown): boolean {
    if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return true;
    const code = (e as { code?: number; cause?: { code?: number } })?.code ?? (e as { cause?: { code?: number } })?.cause?.code;
    return code === 4001;
  }

  /** Best-effort revert reason: custom error name+args, revert string, or the short message. */
  static reason(e: unknown): string {
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (rev?.data?.errorName) return `${rev.data.errorName}(${(rev.data.args ?? []).map(String).join(", ")})`;
      if (rev?.reason) return rev.reason;
      const data = (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
      if (data && data.length >= 10) {
        try { const d = decodeErrorResult({ abi: Contracts.errorsAbi, data }); return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`; } catch { /* unknown selector */ }
        return `revert ${data.slice(0, 10)}`;
      }
      return e.shortMessage;
    }
    return e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
}
