"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type IndexPoint = { t: number; v: number };
type IndexSeries = { name: string; points: IndexPoint[] };
type IndexResponse = { nasdaq: IndexSeries; sp500: IndexSeries; updatedAt: number };
const W = 600;
const H = 211;
const PAD = { left: 55, right: 55, top: 14, bottom: 28 };
const BLUE = "#39aaff";
const RED = "#ff5265";
const formatLevel = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function bounds(points: IndexPoint[]): [number, number] {
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.16, Math.abs(max) * 0.0002);
  return [min - pad, max + pad];
}

export default function MarketIndexPulse() {
  const [data, setData] = useState<IndexResponse | null>(null);
  const [error, setError] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(30);
  // Animate the chart's horizontal position continuously, independently of the
  // 1-second quote requests. Keep the actual wall clock (no synthetic prices).
  const [clockTime, setClockTime] = useState(() => Date.now() / 1000);
  useEffect(() => {
    let frame = 0;
    let lastFrame = 0;
    const animate = (time: number) => {
      if (time - lastFrame >= 32 && !document.hidden) {
        lastFrame = time;
        setClockTime(Date.now() / 1000);
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const pinchDistance = useRef<number | null>(null);
  const pinchStartMinutes = useRef(30);
  const changeWindow = (delta: number) => setWindowMinutes(m => Math.max(30, Math.min(300, m + delta)));
  const touchDistance = (touches: React.TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const busy = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (document.hidden || busy.current) return;
      busy.current = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8500);
      try {
        const response = await fetch("/api/market-indices", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Index request failed");
        const next = await response.json() as IndexResponse;
        if (!cancelled && next.nasdaq?.points?.length && next.sp500?.points?.length) {
          setData((old) => old?.updatedAt === next.updatedAt ? old : next);
          setError(false);
        } else if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        window.clearTimeout(timeout);
        busy.current = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  const graph = useMemo(() => {
    if (!data) return null;
    const series = [data.nasdaq.points, data.sp500.points];
    const allTimes = series.flat().map((p) => p.t);
    if (!allTimes.length) return null;
    // Anchor X to the actual current time, not to the last Yahoo 1-minute candle.
    const maxT = clockTime;
    const span = windowMinutes * 60;
    const minT = maxT - span;
    const visible = series.map((points) => points.filter((p) => p.t >= minT && p.t <= maxT));
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const axis = visible.map((points, index) => bounds(points.length ? points : [series[index][series[index].length - 1]]));
    const x = (t: number) => PAD.left + (t - minT) / span * plotW;
    const y = (v: number, side: number) => PAD.top + (axis[side][1] - v) / (axis[side][1] - axis[side][0]) * plotH;
    const path = (points: IndexPoint[], side: number) => {
      // Curved, time-preserving interpolation through genuine one-minute samples.
      // Control points follow each interval's time order, preventing backtracking.
      if (!points.length) return "";
      if (points.length === 1) return `M${x(points[0].t).toFixed(2)},${y(points[0].v, side).toFixed(2)}`;
      const p = points.map((point) => ({ x: x(point.t), y: y(point.v, side) }));
      let d = `M${p[0].x.toFixed(2)},${p[0].y.toFixed(2)}`;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        const prev = p[Math.max(0, i - 1)], next = p[Math.min(p.length - 1, i + 2)];
        const delta = b.x - a.x;
        const slopeA = (b.y - prev.y) / Math.max(0.001, b.x - prev.x);
        const slopeB = (next.y - a.y) / Math.max(0.001, next.x - a.x);
        const handle = delta / 3;
        // Curve smoothly, but limit control handles to their adjacent price range.
        const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
        const cy1 = Math.max(low, Math.min(high, a.y + slopeA * handle));
        const cy2 = Math.max(low, Math.min(high, b.y - slopeB * handle));
        d += ` C${(a.x + handle).toFixed(2)},${cy1.toFixed(2)} ${(b.x - handle).toFixed(2)},${cy2.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
      }
      return d;
    };
    const ticks = Array.from({ length: 7 }, (_, i) => minT + span * i / 6);
    return { axis, x, y, path, ticks, plotH, visible };
  }, [data, windowMinutes, clockTime]);
  const lastNasdaq = data?.nasdaq.points.at(-1)?.v;
  const lastSp = data?.sp500.points.at(-1)?.v;
  return (
    <section className="portfolio-index-pulse" aria-label="NASDAQ and S&P 500 live market pulse">
      <div className="pulse-zoom-controls" aria-label="차트 표시 시간 조절">
        <button type="button" onClick={() => changeWindow(-30)} disabled={windowMinutes <= 30} aria-label="차트 30분 확대">＋</button>
        <span>{windowMinutes >= 60 ? `${windowMinutes / 60}시간` : `${windowMinutes}분`}</span>
        <button type="button" onClick={() => changeWindow(30)} disabled={windowMinutes >= 300} aria-label="차트 30분 축소">－</button>
      </div>
      <div className="index-pulse-heading">
        <span className="index-pulse-caption">MARKET PULSE <span className="pulse-live-indicator" aria-hidden="true" /></span>
        <div className="index-pulse-legend">
          <span style={{ color: BLUE }}><i style={{ background: BLUE }} />NASDAQ {lastNasdaq === undefined ? "—" : formatLevel(lastNasdaq)}</span>
          <span style={{ color: RED }}><i style={{ background: RED }} />S&amp;P 500 {lastSp === undefined ? "—" : formatLevel(lastSp)}</span>
        </div>
      </div>
      <div className="index-pulse-monitor" style={{ touchAction: "pan-y" }} onTouchStart={(e) => { if (e.touches.length === 2) { pinchDistance.current = touchDistance(e.touches); pinchStartMinutes.current = windowMinutes; } }} onTouchMove={(e) => { if (e.touches.length === 2 && pinchDistance.current) { const ratio = pinchDistance.current / Math.max(1, touchDistance(e.touches)); const scaled = Math.round(pinchStartMinutes.current * ratio / 30) * 30; setWindowMinutes(Math.max(30, Math.min(300, scaled))); } }} onTouchEnd={(e) => { if (e.touches.length < 2) pinchDistance.current = null; }}>
        {graph && data ? (
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="나스닥(왼쪽 Y축)과 S&P 500(오른쪽 Y축) 1분봉 시세" preserveAspectRatio="none">
            <defs>
              <filter id="market-neon-glow" x="-60%" y="-200%" width="220%" height="500%"><feGaussianBlur stdDeviation="3.3" /></filter>
              <linearGradient id="market-neon-sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#3bd5fd" stopOpacity="0"/><stop offset="0.52" stopColor="#3bd5fd" stopOpacity="0.09"/><stop offset="1" stopColor="#3bd5fd" stopOpacity="0"/></linearGradient>
              <clipPath id="market-neon-clip"><rect x={PAD.left} y={PAD.top} width={W-PAD.left-PAD.right} height={H-PAD.top-PAD.bottom} /></clipPath>
            </defs>
            {Array.from({length: 5}, (_, i) => {
              const yy = PAD.top + graph.plotH * i / 4;
              return <g key={i}>
                <line x1={PAD.left} x2={W-PAD.right} y1={yy} y2={yy} stroke="#30516a" strokeWidth="0.65" strokeDasharray="3 5" opacity=".6" />
                <text x={PAD.left-7} y={yy+3} textAnchor="end" fontSize="10" fontWeight="900" fill={BLUE}>{formatLevel(graph.axis[0][1]-(graph.axis[0][1]-graph.axis[0][0])*i/4)}</text>
                <text x={W-PAD.right+7} y={yy+3} textAnchor="start" fontSize="10" fontWeight="900" fill={RED}>{formatLevel(graph.axis[1][1]-(graph.axis[1][1]-graph.axis[1][0])*i/4)}</text>
              </g>;
            })}
            {graph.ticks.map((t,i) => <text key={i} x={PAD.left + (t-graph.ticks[0]) / (windowMinutes*60)*(W-PAD.left-PAD.right)} y={H-8} textAnchor="middle" fontSize="9" fill="#91a6bb">{new Date(t*1000).toLocaleTimeString("en-US", {hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"Asia/Seoul"})}</text>)}
            <g clipPath="url(#market-neon-clip)">
              <rect className="neon-scan" x={PAD.left} y={PAD.top} width="105" height={H-PAD.top-PAD.bottom} fill="url(#market-neon-sweep)" />
              {[BLUE, RED].map((color,i) => <g key={color}>
                <path d={graph.path(graph.visible[i],i)} fill="none" stroke={color} strokeWidth="9" opacity=".43" filter="url(#market-neon-glow)" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                <path d={graph.path(graph.visible[i],i)} fill="none" stroke={color} strokeWidth="3.1" opacity=".88" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                <path d={graph.path(graph.visible[i],i)} fill="none" stroke="#ffffff" strokeWidth="0.8" opacity=".8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                <path className="neon-trace" d={graph.path(graph.visible[i],i)} fill="none" stroke="#ffffff" strokeWidth="1.3" opacity=".55" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                {graph.visible[i].length>0 && <g>
                  <circle cx={graph.x(graph.visible[i][graph.visible[i].length-1].t)} cy={graph.y(graph.visible[i][graph.visible[i].length-1].v,i)} r="9" fill={color} opacity=".5" filter="url(#market-neon-glow)" />
                  <circle cx={graph.x(graph.visible[i][graph.visible[i].length-1].t)} cy={graph.y(graph.visible[i][graph.visible[i].length-1].v,i)} r="3.3" fill="#fff" stroke={color} strokeWidth="2"><animate attributeName="r" values="3;4.8;3" dur="2s" repeatCount="indefinite" /></circle>
                </g>}
              </g>)}
            </g>
          </svg>
        ) : <div className="index-pulse-empty">{error ? "지수 데이터를 불러올 수 없습니다." : "NASDAQ · S&P 500 지수 불러오는 중…"}</div>}
      </div>
      <div className="index-pulse-footnote"><span>X축 한국시간(KST) · 매초 이동 · 가격은 공급원 실제 수신 시 반영</span></div>
      <style jsx>{`
        .portfolio-index-pulse { grid-area:indices; min-width:0; box-sizing:border-box; padding:4px 4px 3px; border-top:1px solid #edf0f5; }
        .index-pulse-heading { display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; padding:0 3px 5px; }
        .index-pulse-caption { display:inline-flex; align-items:center; gap:7px; font-size:10px; font-weight:800; letter-spacing:.08em; color:#861f41; }
        .pulse-live-indicator { width:5px;height:5px;border-radius:50%;background:#30d5f9;box-shadow:0 0 7px #30d5f9;animation:live-light 2s ease-in-out infinite; }
        .index-pulse-legend { display:flex; flex-wrap:wrap; gap:9px; font-size:10px; font-weight:750; font-variant-numeric:tabular-nums; }
        .index-pulse-legend span { white-space:nowrap; }
        .index-pulse-legend i { display:inline-block; height:6px; width:10px; border-radius:4px; margin-right:4px; vertical-align:middle;box-shadow:0 0 6px currentColor; }
        .index-pulse-monitor { background:radial-gradient(ellipse at 48% 42%,#123047 0%,#071420 72%,#06101b 100%);border-radius:10px;overflow:hidden;border:1px solid #25435b;box-shadow:inset 0 0 18px #06111d;position:relative; }
        .index-pulse-monitor::after {content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,transparent 0px,transparent 3px,rgba(134,192,244,.022) 4px);}
        .pulse-zoom-controls {display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 4px 6px;font-size:10px;color:#64748b;font-weight:800;}
        .pulse-zoom-controls button {border:1px solid #d6dee9;background:#fff;color:#861f41;border-radius:6px;width:25px;height:23px;font-size:16px;cursor:pointer;}
        .pulse-zoom-controls button:disabled {opacity:.35;cursor:default;}
        svg { display:block; width:100%; height:204px; overflow:hidden; }
        .neon-scan { animation:neon-sweep 2s linear infinite; }
        .neon-trace { stroke-dasharray:2 10; animation:neon-flow 1.5s linear infinite; }
        @keyframes neon-flow { from { stroke-dashoffset:0; } to { stroke-dashoffset:-12; } }
        @keyframes neon-sweep { from { transform:translateX(-120px) } to {transform:translateX(610px)} }
        @keyframes live-light { 50%{opacity:.25;box-shadow:0 0 2px #30d5f9;} }
        .index-pulse-empty {height:204px;display:grid;place-items:center;text-align:center;font-size:11px;color:#a1bed3;}
        .index-pulse-footnote {display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:4px 4px 0;font-size:9px;color:#64748b;}
        @media(max-width:480px) {svg,.index-pulse-empty{height:175.2px;}.index-pulse-legend{font-size:9px;gap:7px;}.index-pulse-footnote{font-size:8px;}}
        @media(prefers-reduced-motion:reduce) {.neon-scan,.neon-trace,.pulse-live-indicator{animation:none;}}
      `}</style>
    </section>
  );
}
