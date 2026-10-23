import type { ReactNode } from "react";

export class TableState {
  static loading(cols: number, rows = 5): ReactNode {
    return Array.from({ length: rows }, (_, r) => (
      <tr key={`sk${r}`} className="sk-row" aria-hidden>
        {Array.from({ length: cols }, (_, c) => <td key={c}><span className="sk" style={{ width: `${40 + ((r * 7 + c * 13) % 45)}%` }} /></td>)}
      </tr>
    ));
  }
  static empty(cols: number, text: string): ReactNode {
    return <tr><td className="empty" colSpan={cols}><span className="empty-ico" aria-hidden>◇</span>{text}</td></tr>;
  }
  static of(list: unknown[] | undefined, cols: number, text: string, rows = 5): ReactNode {
    if (!list) return TableState.loading(cols, rows);
    return list.length ? null : TableState.empty(cols, text);
  }
}
