"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; n: number };
const PERIODS = [[30, "30s"], [60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"]] as const;
const UP = "#2ebd85", DN = "#f6465d", AXIS_R = 62, MONO = "ui-monospace, Consolas, monospace";
const fp = (v: number) => v.toFixed(2);
const fv = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + "K" : v.toFixed(1));
const p2 = (n: number) => String(n).padStart(2, "0");

export function KLine({ asset, lang, title }: { asset: "relic" | "loom"; lang: "zh" | "en"; title: string }) {
  const zh = lang === "zh";
  const cv = useRef<HTMLCanvasElement>(null);
  const [sec, setSec] = useState(60);
  const [data, setData] = useState<Candle[]>([]);
  const [legend, setLegend] = useState<{ c: Candle; chg: number } | null>(null);
  const request = useRef<{ sec: number; asset: "relic" | "loom"; active: boolean; controller?: AbortController }>({ sec, asset, active: true });
  const v = useRef({ data: [] as Candle[], hover: null as number | null, count: 0, end: 0, follow: true, drag: false, dx: 0, dEnd: 0, pinch: 0, pCount: 0, sec: 60 });

  const geom = () => {
    const W = cv.current?.clientWidth || 900, H = cv.current?.clientHeight || 340;
    const padL = 8, priceTop = 30, axisB = 22, volH = 58, volGap = 14;
    const priceH = H - priceTop - axisB - volH - volGap;
    return { W, H, padL, axisB, volH, priceTop, priceH, volTop: priceTop + priceH + volGap, plotW: W - padL - AXIS_R };
  };
  const range = () => {
    const s = v.current, n = s.data.length;
    if (!n) return { start: 0, end: 0, count: 0 };
    const count = Math.min(n, Math.max(3, s.count > 0 ? Math.round(s.count) : Math.min(80, n)));
    const end = Math.max(count, Math.min(n, s.follow ? n : s.end || n));
    return { start: end - count, end, count };
  };

  const draw = useCallback(() => {
    const el = cv.current; if (!el) return;
    const s = v.current, dpr = window.devicePixelRatio || 1, G = geom();
    const { W, H, padL, priceTop, priceH, volTop, volH, plotW, axisB } = G;
    el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
    const ctx = el.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const n = s.data.length; if (!n) { setLegend(null); return; }
    const { start, end, count } = range(), step = plotW / count, bw = Math.max(1, Math.min(24, step * 0.7));
    const slice = s.data.slice(start, end);
    const volMax = Math.max(0, ...slice.map((c) => c.v));
    const closes = slice.map((c) => c.c).sort((a, b) => a - b);
    const q = (p: number) => closes[Math.min(closes.length - 1, Math.max(0, Math.round((closes.length - 1) * p)))];
    let lo = closes.length >= 12 ? q(0.03) : closes[0], hi = closes.length >= 12 ? q(0.97) : closes[closes.length - 1];
    if (hi - lo < hi * 0.004) { const m = (hi + lo) / 2; lo = m * 0.996; hi = m * 1.004; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const y = (p: number) => priceTop + priceH - ((p - lo) / (hi - lo)) * priceH;
    const x = (i: number) => padL + (i - start + 0.5) * step;

    ctx.save(); ctx.fillStyle = "rgba(234,236,239,.025)"; ctx.font = '700 64px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("BSC MARKET", padL + plotW / 2, priceTop + priceH / 2); ctx.restore();

    ctx.font = `10px ${MONO}`; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const val = lo + ((hi - lo) * g) / 4, yy = y(val);
      ctx.strokeStyle = "rgba(43,47,54,.72)"; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - AXIS_R, yy); ctx.stroke();
      ctx.fillStyle = "#848E9C"; ctx.fillText(fp(val), W - AXIS_R + 7, yy);
    }
    const every = Math.max(1, Math.ceil(count / 7));
    ctx.strokeStyle = "rgba(43,47,54,.48)"; ctx.fillStyle = "#848E9C"; ctx.textAlign = "center";
    for (let i = 0; i < count; i += every) {
      const d = new Date(slice[i].t), xx = x(start + i);
      const lab = s.sec >= 3600 ? `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:00` : `${p2(d.getHours())}:${p2(d.getMinutes())}${s.sec < 60 ? ":" + p2(d.getSeconds()) : ""}`;
      ctx.beginPath(); ctx.moveTo(xx, priceTop); ctx.lineTo(xx, volTop + volH); ctx.stroke(); ctx.fillText(lab, xx, H - axisB + 11);
    }
    slice.forEach((c, i) => {
      const vh = volMax ? (c.v / volMax) * volH : 0;
      ctx.fillStyle = c.c >= c.o ? "rgba(46,189,133,.30)" : "rgba(246,70,93,.28)";
      ctx.fillRect(x(start + i) - bw / 2, volTop + volH - vh, bw, Math.max(1, vh));
    });
    ctx.fillStyle = "#6A717C"; ctx.textAlign = "left"; ctx.font = `9px ${MONO}`; ctx.fillText("VOLUME", padL + 2, volTop - 4);

    ctx.save(); ctx.beginPath(); ctx.rect(padL, priceTop - 3, plotW, priceH + 6); ctx.clip();
    slice.forEach((c, i) => {
      const col = c.c >= c.o ? UP : DN, cx = x(start + i);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, Math.min(2, bw / 6));
      ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, top, Math.max(1, bw), Math.max(1, bot - top));
    });
    ctx.restore();

    const tag = (yy: number, bg: string, fg: string, txt: string) => {
      ctx.fillStyle = bg; ctx.fillRect(W - AXIS_R + 2, yy - 9, AXIS_R - 6, 18);
      ctx.fillStyle = fg; ctx.font = `600 10.5px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(txt, W - AXIS_R + 7, yy);
    };
    const last = s.data[n - 1], ly = y(last.c), lu = last.c >= last.o;
    if (ly > priceTop && ly < priceTop + priceH) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = lu ? "rgba(46,189,133,.55)" : "rgba(246,70,93,.55)";
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - AXIS_R, ly); ctx.stroke(); ctx.setLineDash([]);
      tag(ly, lu ? UP : DN, "#0B0E11", fp(last.c));
    }
    let idx = end - 1;
    if (s.hover != null && s.hover >= start && s.hover < end) {
      idx = s.hover; const c = s.data[idx], cx = x(idx), cy = y(c.c);
      ctx.strokeStyle = "rgba(240,185,11,.38)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, priceTop); ctx.lineTo(cx, volTop + volH); ctx.moveTo(padL, cy); ctx.lineTo(W - AXIS_R, cy); ctx.stroke(); ctx.setLineDash([]);
      tag(cy, "#2B2F36", "#EAECEF", fp(c.c));
      const d = new Date(c.t), tw = 46, bx = Math.min(W - AXIS_R - tw, Math.max(padL, cx - tw / 2));
      ctx.fillStyle = "#2B2F36"; ctx.fillRect(bx, H - axisB + 1, tw, 18);
      ctx.fillStyle = "#EAECEF"; ctx.textAlign = "center"; ctx.fillText(`${p2(d.getHours())}:${p2(d.getMinutes())}`, bx + tw / 2, H - axisB + 10);
    }
    const c = s.data[idx], prev = idx > 0 ? s.data[idx - 1].c : c.o;
    setLegend({ c, chg: prev ? ((c.c - prev) / prev) * 100 : 0 });
  }, []);

  const load = useCallback(async () => {
    const context = request.current;
    if (!context.active || context.controller || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const controller = new AbortController();
    context.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/klines?sec=${context.sec}&limit=400&asset=${context.asset}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Candles unavailable");
      const j = (await response.json()) as { ready?: boolean; candles?: Candle[] };
      if (request.current !== context || controller.signal.aborted) return;
      if (j?.ready === false || !Array.isArray(j?.candles)) return;
      if (!j.candles.every((c) => c && [c.t, c.o, c.h, c.l, c.c, c.v, c.n].every(Number.isFinite))) return;
      const s = v.current;
      if (!j.candles.length && s.data.length) return;
      s.data = j.candles; if (s.follow || !s.end) s.end = s.data.length; setData(s.data); draw();
    } catch { /* keep last data */ }
    finally {
      clearTimeout(timeout);
      if (context.controller === controller) context.controller = undefined;
    }
  }, [draw]);

  useEffect(() => {
    const changed = request.current.sec !== sec || request.current.asset !== asset;
    const context = { sec, asset, active: true, controller: undefined as AbortController | undefined };
    request.current = context;
    const s = v.current; s.sec = sec; s.follow = true; s.count = 0; s.end = 0; s.hover = null;
    if (changed) {
      s.data = []; s.drag = false; s.dx = 0; s.dEnd = 0; s.pinch = 0; s.pCount = 0;
      setData([]); setLegend(null);
      if (cv.current) cv.current.style.cursor = "grab";
      draw();
    }
    load();
    const id = setInterval(load, 2000);
    return () => {
      clearInterval(id);
      context.active = false;
      context.controller?.abort();
      context.controller = undefined;
    };
  }, [sec, asset, load, draw]);

  useEffect(() => {
    const el = cv.current!; const s = v.current;
    const idxAt = (cx: number) => { const { padL, plotW } = geom(), r = range(); return r.start + Math.floor((cx - el.getBoundingClientRect().left - padL) / (plotW / r.count)); };
    const pan = (cx: number) => { const n = s.data.length, r = range(); if (!n) return; const sh = Math.round((s.dx - cx) / (geom().plotW / r.count)); s.count = r.count; s.end = Math.max(r.count, Math.min(n, s.dEnd + sh)); s.follow = s.end >= n; draw(); };
    const zoomTo = (next: number, anchor?: number) => {
      const n = s.data.length, r = range(); next = Math.max(10, Math.min(n, next));
      if (anchor == null) { s.end = Math.min(n, Math.max(next, s.end || n)); } else { const st = Math.max(0, Math.min(n - next, Math.round(anchor - ((anchor - r.start) / r.count) * next))); s.end = st + next; }
      s.count = next; s.follow = s.end >= n; draw();
    };
    const onMove = (e: MouseEvent) => { if (s.drag) return pan(e.clientX); if (e.target !== el) return; const r = range(); if (!r.count) return; const i = idxAt(e.clientX); s.hover = i >= r.start && i < r.end ? i : null; draw(); };
    const onLeave = () => { s.hover = null; draw(); };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); if (!s.data.length) return; const { padL, plotW } = geom(), r = range(); zoomTo(Math.round(r.count * (e.deltaY > 0 ? 1.25 : 0.8)), r.start + (e.clientX - el.getBoundingClientRect().left - padL) / (plotW / r.count)); };
    const onDown = (e: MouseEvent) => { s.drag = true; s.dx = e.clientX; s.dEnd = range().end; el.style.cursor = "grabbing"; e.preventDefault(); };
    const onUp = () => { if (s.drag) { s.drag = false; el.style.cursor = "grab"; } };
    const onDbl = () => { s.follow = true; s.count = 0; s.end = s.data.length; draw(); };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTS = (e: TouchEvent) => { if (e.touches.length === 1) { s.drag = true; s.dx = e.touches[0].clientX; s.dEnd = range().end; } else if (e.touches.length === 2) { s.pinch = dist(e.touches); s.pCount = range().count; } };
    const onTM = (e: TouchEvent) => { if (!s.data.length) return; if (e.touches.length === 2 && s.pinch > 0) { e.preventDefault(); zoomTo(Math.round(s.pCount * (s.pinch / Math.max(10, dist(e.touches))))); } else if (e.touches.length === 1 && s.drag) { e.preventDefault(); pan(e.touches[0].clientX); } };
    const onTE = () => { s.drag = false; s.pinch = 0; };
    el.style.cursor = "grab";
    el.addEventListener("mouseleave", onLeave); el.addEventListener("wheel", onWheel, { passive: false }); el.addEventListener("mousedown", onDown); el.addEventListener("dblclick", onDbl);
    el.addEventListener("touchstart", onTS, { passive: true }); el.addEventListener("touchmove", onTM, { passive: false }); el.addEventListener("touchend", onTE, { passive: true });
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); window.addEventListener("resize", draw);
    return () => {
      el.removeEventListener("mouseleave", onLeave); el.removeEventListener("wheel", onWheel); el.removeEventListener("mousedown", onDown); el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); el.removeEventListener("touchend", onTE);
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); window.removeEventListener("resize", draw);
    };
  }, [draw]);

  const n = data.length, L = legend;
  const d = L ? new Date(L.c.t) : null;
  return (
    <section className="panel kchart" aria-label={title}>
      <div className="khead">
        <div className="ktitle"><h2 className="panel-title"><Icon name="chart" size={16} />{title}</h2><span className="kpair">{asset === "relic" ? "RELICS" : "LOOMS"}<span> / USDT</span></span></div>
        <span className="muted khint">{zh ? "链上成交" : "On-chain fills"} · {n}{zh ? " 根" : " bars"}</span>
        <div className="ktoolbar">
          <div className="seg" role="group" aria-label={zh ? "周期" : "Period"}>
            {PERIODS.map(([p, l]) => <button key={p} aria-pressed={p === sec} className={p === sec ? "active" : ""} onClick={() => setSec(p)}>{l}</button>)}
          </div>
        </div>
      </div>
      <div className="kbody">
        {L && d ? <div className="kohlc" data-testid="ohlc">
          <span className="ktime">{p2(d.getHours())}:{p2(d.getMinutes())}</span>
          <span>O<b>{fp(L.c.o)}</b></span><span>H<b>{fp(L.c.h)}</b></span><span>L<b>{fp(L.c.l)}</b></span><span>C<b>{fp(L.c.c)}</b></span>
          <span className={`kdelta ${L.chg >= 0 ? "up" : "down"}`}>{L.chg >= 0 ? "+" : ""}{L.chg.toFixed(2)}%</span>
          <span>VOL<b>{fv(L.c.v)}</b></span><span>N<b>{L.c.n}</b></span>
        </div> : null}
        <canvas ref={cv} data-testid="kline" role="img" aria-label={`${title} ${n} bars`} />
        {!n ? <div className="kempty"><span className="kempty-icon"><Icon name="chart" size={26} /></span><strong>{zh ? "暂无成交数据" : "No trade data yet"}</strong><span>{zh ? "新的链上成交将在此自动更新" : "New on-chain fills will update here automatically"}</span></div> : null}
      </div>
      <div className="kchart-note"><span>{n > 0 && n < 8 ? (zh ? "成交历史较少，K 线将随新成交更新。" : "Limited history. Candles update as new trades arrive.") : (zh ? "基于链上成交价格" : "Based on on-chain fill prices")}</span><span className="hide-sm">{zh ? "滚轮缩放 · 拖动平移 · 双击重置" : "Scroll to zoom · Drag to pan · Double-click to reset"}</span></div>
    </section>
  );
}
