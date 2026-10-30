"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CalculatedHolding } from "../lib/portfolio-calculations";

type MarketMetric = {
  ticker: string;
  price: number | null;
  sma60: number | null;
  sma120: number | null;
  return1Day: number | null;
  return3Month: number | null;
  return3Year: number | null;
  high52Week: number | null;
  low52Week: number | null;
};

type MapHolding = CalculatedHolding & {
  targetAllocation: number;
  gap: number;
  score: number;
  side: "BUY" | "SELL" | "BALANCED";
  level: 0 | 1 | 2 | 3;
  marketReturn1Day: number | null;
};

type Rect = { x: number; y: number; width: number; height: number };
type LayoutItem<T> = { item: T; weight: number; rect: Rect };

const TARGET_STORAGE_KEY = "stock-portfolio-target-allocations-v1";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function initials(ticker: string) {
  return ticker.slice(0, 2).toUpperCase();
}

function CompanyMark({ ticker, size = 36 }: { ticker: string; size?: number }) {
  const symbol = ticker.trim().toUpperCase();
  const hue = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const token = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN?.trim();

  const sources = useMemo(() => {
    const items = [`/logos/${symbol.toLowerCase()}.svg`];
    if (token) {
      items.push(
        `https://img.logo.dev/ticker/${encodeURIComponent(symbol)}?token=${encodeURIComponent(token)}&size=128&format=png`,
      );
    }
    items.push(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`);
    return items;
  }, [symbol, token]);

  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [symbol]);

  return (
    <span
      className="map-company-mark"
      style={{
        width: size,
        height: size,
        background: index < sources.length ? "#fff" : `hsl(${hue} 70% 94%)`,
        color: `hsl(${hue} 55% 35%)`,
      }}
    >
      {index < sources.length ? (
        <img
          src={sources[index]}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setIndex((current) => current + 1)}
        />
      ) : initials(symbol)}
    </span>
  );
}

/** Squarified treemap: each tile area follows its allocation, while rows
 * are packed to avoid the long thin rectangles produced by binary splitting. */
function splitTreemap<T>(
  items: Array<{ item: T; weight: number }>,
  rect: Rect,
): LayoutItem<T>[] {
  if (!items.length || rect.width <= 0 || rect.height <= 0) return [];
  const sorted = [...items].filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return [];

  // Work in pixel areas so the same algorithm handles any viewport shape.
  const pending = sorted.map((entry) => ({
    ...entry,
    area: (entry.weight / totalWeight) * rect.width * rect.height,
  }));
  const result: LayoutItem<T>[] = [];
  let remaining = { ...rect };

  const worstAspect = (row: typeof pending, side: number) => {
    if (!row.length || side <= 0) return Infinity;
    const sum = row.reduce((acc, entry) => acc + entry.area, 0);
    const max = Math.max(...row.map((entry) => entry.area));
    const min = Math.min(...row.map((entry) => entry.area));
    return Math.max(
      (side * side * max) / (sum * sum),
      (sum * sum) / (side * side * min),
    );
  };

  const layoutRow = (row: typeof pending) => {
    const rowArea = row.reduce((acc, entry) => acc + entry.area, 0);
    // Along the shorter side, the strip thickness is proportional to area.
    if (remaining.width >= remaining.height) {
      const stripWidth = remaining.height > 0 ? rowArea / remaining.height : 0;
      let y = remaining.y;
      row.forEach((entry, index) => {
        const height = index === row.length - 1
          ? remaining.y + remaining.height - y
          : stripWidth > 0 ? entry.area / stripWidth : 0;
        result.push({ item: entry.item, weight: entry.weight,
          rect: { x: remaining.x, y, width: stripWidth, height } });
        y += height;
      });
      remaining = { ...remaining, x: remaining.x + stripWidth,
        width: Math.max(0, remaining.width - stripWidth) };
    } else {
      const stripHeight = remaining.width > 0 ? rowArea / remaining.width : 0;
      let x = remaining.x;
      row.forEach((entry, index) => {
        const width = index === row.length - 1
          ? remaining.x + remaining.width - x
          : stripHeight > 0 ? entry.area / stripHeight : 0;
        result.push({ item: entry.item, weight: entry.weight,
          rect: { x, y: remaining.y, width, height: stripHeight } });
        x += width;
      });
      remaining = { ...remaining, y: remaining.y + stripHeight,
        height: Math.max(0, remaining.height - stripHeight) };
    }
  };

  let row: typeof pending = [];
  for (const entry of pending) {
    const side = Math.min(remaining.width, remaining.height);
    if (!row.length || worstAspect([...row, entry], side) <= worstAspect(row, side)) {
      row.push(entry);
    } else {
      layoutRow(row);
      row = [entry];
    }
  }
  if (row.length) layoutRow(row);
  return result;
}

/** Keep the treemap dense, but never render slivers that cannot be tapped. */
function tappableTreemap<T>(
  items: Array<{ item: T; weight: number }>,
  rect: Rect,
  minWidth = 42,
  minHeight = 30,
): LayoutItem<T>[] {
  const remaining = [...items].sort((a, b) => b.weight - a.weight);
  while (remaining.length) {
    const layout = splitTreemap(remaining, rect);
    if (layout.every(({ rect: tile }) =>
      tile.width >= minWidth && tile.height >= minHeight
    )) return layout;
    // Remove the smallest allocation, then reclaim its area for larger holdings.
    remaining.pop();
  }
  return [];
}

function calculateSignal(
  currentAllocation: number,
  targetAllocation: number,
  metric?: MarketMetric,
): { side: "BUY" | "SELL" | "BALANCED"; level: 0 | 1 | 2 | 3 } {
  const gap = targetAllocation - currentAllocation;
  if (Math.abs(gap) < 0.01) return { side: "BALANCED", level: 0 };
  if (!metric || !finite(metric.price)) return { side: gap > 0 ? "BUY" : "SELL", level: 0 };

  if (gap > 0) {
    const return3Month = finite(metric.return3Month)
      ? metric.return3Month
      : Number.POSITIVE_INFINITY;
    const distance60 =
      finite(metric.sma60) && metric.sma60 > 0
        ? (metric.price / metric.sma60 - 1) * 100
        : Number.POSITIVE_INFINITY;
    const near52Low =
      finite(metric.low52Week) && metric.low52Week > 0 &&
      metric.price <= metric.low52Week * 1.03;

    if ((return3Month <= -30 || distance60 <= -30) && near52Low) return { side: "BUY", level: 3 };
    if (return3Month <= -20 || distance60 <= -20) return { side: "BUY", level: 2 };
    if (return3Month <= -10 || distance60 <= -10) return { side: "BUY", level: 1 };
    return { side: "BUY", level: 0 };
  }

  const near52High =
    finite(metric.high52Week) &&
    metric.high52Week > 0 &&
    metric.price >= metric.high52Week * 0.97;

  if (!near52High) return { side: "SELL", level: 0 };
  if (finite(metric.return3Year) && metric.return3Year >= 200) return { side: "SELL", level: 3 };
  if (finite(metric.return3Year) && metric.return3Year >= 100) return { side: "SELL", level: 2 };
  return { side: "SELL", level: 1 };
}

function buyDrawdown(metric?: MarketMetric) {
  if (!metric) return null;
  const threeMonth = finite(metric.return3Month) ? Math.max(0, -metric.return3Month) : null;
  const distance60 =
    finite(metric.price) && finite(metric.sma60) && metric.sma60 > 0
      ? Math.max(0, -(metric.price / metric.sma60 - 1) * 100)
      : null;
  const values = [threeMonth, distance60].filter(finite);
  return values.length ? Math.max(...values) : null;
}

function buyScore(drawdown: number | null) {
  if (!finite(drawdown) || drawdown <= 0) return 0;
  if (drawdown < 10) return (drawdown / 10) * 33;
  if (drawdown < 20) return 33 + ((drawdown - 10) / 10) * 34;
  if (drawdown < 30) return 67 + ((drawdown - 20) / 10) * 23;
  return Math.min(95, 90 + ((drawdown - 30) / 20) * 5);
}

function sellScore(metric?: MarketMetric) {
  if (!metric || !finite(metric.price) || !finite(metric.high52Week) || metric.high52Week <= 0) {
    return 0;
  }

  const highRatio = metric.price / metric.high52Week;
  const return3Year = finite(metric.return3Year) ? metric.return3Year : 0;

  if (highRatio < 0.97) return clamp(((highRatio - 0.8) / 0.17) * 33, 0, 33);
  if (return3Year < 100) return 33 + clamp(return3Year / 100, 0, 1) * 34;
  if (return3Year < 200) return 67 + ((return3Year - 100) / 100) * 23;
  return Math.min(95, 90 + ((return3Year - 200) / 200) * 5);
}

function continuousScore(
  signal: { side: "BUY" | "SELL" | "BALANCED"; level: 0 | 1 | 2 | 3 },
  metric?: MarketMetric,
) {
  if (signal.side === "BALANCED") return 0;

  const technical =
    signal.side === "BUY"
      ? buyScore(buyDrawdown(metric))
      : sellScore(metric);

  const executionBonus =
    signal.level === 3 &&
    ((signal.side === "BUY" && finite(metric?.return1Day) && metric.return1Day < 0) ||
      (signal.side === "SELL" && finite(metric?.return1Day) && metric.return1Day > 0))
      ? 5
      : 0;

  let stageScore = 0;
  if (signal.level === 0) {
    stageScore = clamp(technical, 0, 29.9);
  } else if (signal.level === 1) {
    stageScore = 30 + clamp((technical - 33) / 34, 0, 1) * 29.9;
  } else if (signal.level === 2) {
    stageScore = 60 + clamp((technical - 67) / 23, 0, 1) * 24.9;
  } else {
    stageScore = 85 + clamp((technical - 90) / 5, 0, 1) * 10 + executionBonus;
  }

  return Math.round(clamp(stageScore, 0, 100) * 10) / 10;
}

function tileTone(side: MapHolding["side"], score: number) {
  if (side === "BALANCED") return "balanced";
  if (side === "BUY") {
    if (score >= 85) return "buy-strong";
    if (score >= 60) return "buy-high";
    if (score >= 30) return "buy-medium";
    return "buy-low";
  }
  if (score >= 85) return "sell-strong";
  if (score >= 60) return "sell-high";
  if (score >= 30) return "sell-medium";
  return "sell-low";
}

function formatPercent(value: number | null | undefined, digits = 1) {
  if (!finite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export default function MarketMapTab({ holdings }: { holdings: CalculatedHolding[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the map geometry stable when mobile browser chrome appears/disappears.
  const stableViewportRef = useRef<{ width: number; height: number } | null>(null);
  const quadrantPlotRef = useRef<HTMLDivElement>(null);
  const [quadrantPlotSize, setQuadrantPlotSize] = useState({ width: 360, height: 290 });
  // Keep the same label-to-dot offset across live quote updates.
  const quadrantLabelAnchorsRef = useRef(new Map<string, { dx: number; dy: number }>());
  const quadrantLabelSizeRef = useRef("");
  useEffect(() => {
    const node = quadrantPlotRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setQuadrantPlotSize((old) =>
        Math.abs(old.width - rect.width) < 1 && Math.abs(old.height - rect.height) < 1
          ? old : { width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const [size, setSize] = useState({ width: 1100, height: 338 });
  const [metrics, setMetrics] = useState<Record<string, MarketMetric>>({});
  // A separate live quote cache avoids 60-second history refreshes overwriting
  // the current quote used by the quadrant plot.
  const [liveQuotes, setLiveQuotes] = useState<Record<string, { price: number; return1Day: number | null }>>({});

  const [targets, setTargets] = useState<Record<string, number>>({});
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [focusedCategory, setFocusedCategory] = useState<string>("ALL");
  const [viewMode, setViewMode] = useState<"score" | "daily">("score");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TARGET_STORAGE_KEY);
      if (stored) setTargets(JSON.parse(stored));
    } catch {
      setTargets({});
    }
  }, []);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const recalculate = () => {
      // Mobile address bars change window.innerHeight during scrolling.
      // Only genuine width changes (rotation / responsive reflow) are allowed
      // to reset our viewport-height reference.
      const width = Math.max(1, Math.round(node.getBoundingClientRect().width));
      const previous = stableViewportRef.current;
      if (!previous || Math.abs(previous.width - width) >= 2) {
        stableViewportRef.current = { width, height: window.innerHeight };
      }
      const fixedViewportHeight = stableViewportRef.current!.height;
      const height = Math.round(width < 720
        ? Math.max(405, Math.min(585, fixedViewportHeight * 0.61))
        : Math.max(670, Math.min(1100, width * 0.75)));
      setSize((current) => Math.abs(current.width - width) < 2 && current.height === height
        ? current : { width, height });
    };
    const observer = new ResizeObserver(recalculate);
    observer.observe(node);
    window.addEventListener("resize", recalculate);
    recalculate();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recalculate);
    };
  }, [holdings.length, holdings.map((holding) => holding.category || "Other").join("|")]);

  useEffect(() => {
    const symbols = holdings.map((holding) => holding.ticker).filter(Boolean);
    if (!symbols.length) return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/rebalancing-data?symbols=${encodeURIComponent(symbols.join(","))}&t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = await response.json() as { data?: MarketMetric[] };
        if (!cancelled) {
          setMetrics((current) => ({
            ...current,
            ...Object.fromEntries((payload.data ?? []).map((item) => [item.ticker, item])),
          }));
        }
      } catch {
        // Keep previous data.
      }
    };

    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [holdings.map((holding) => holding.ticker).join(",")]);

  // Refresh only the largest ten holdings every second. Do not launch
  // overlapping requests when the provider is slow.
  const topTenSymbols = useMemo(
    () => [...holdings]
      .filter((holding) => holding.shares > 0 && holding.allocation > 0)
      .sort((a, b) => b.allocation - a.allocation)
      .slice(0, 10)
      .map((holding) => holding.ticker),
    [holdings],
  );
  const topTenKey = topTenSymbols.join(",");
  useEffect(() => {
    if (!topTenKey) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const response = await fetch(
          `/api/live-quotes?symbols=${encodeURIComponent(topTenKey)}&t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = await response.json() as {
          data?: Array<{ ticker: string; price: number | null; return1Day: number | null }>;
        };
        if (cancelled) return;
        setLiveQuotes((current) => {
          const next = { ...current };
          for (const quote of payload.data ?? []) {
            if (!finite(quote.price) || quote.price <= 0) continue;
            next[quote.ticker] = {
              price: quote.price,
              return1Day: finite(quote.return1Day) ? quote.return1Day : null,
            };
          }
          return next;
        });
      } catch {
        // Retain last known quotes during a transient network outage.
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [topTenKey]);

  const quadrantPoints = useMemo(() => {
    return [...holdings]
      .filter((holding) => holding.shares > 0 && holding.allocation > 0)
      .sort((a, b) => b.allocation - a.allocation)
      .slice(0, 10)
      .map((holding) => {
        const live = liveQuotes[holding.ticker];
        const currentPrice = finite(live?.price) ? live.price
          : finite(metrics[holding.ticker]?.price) ? metrics[holding.ticker].price!
          : holding.currentPrice;
        const daily = finite(live?.return1Day) ? live.return1Day
          : finite(metrics[holding.ticker]?.return1Day) ? metrics[holding.ticker].return1Day!
          : holding.dailyChangePercent;
        return {
          ticker: holding.ticker,
          allocation: holding.allocation,
          averageCost: holding.averageCost,
          price: currentPrice,
          // Horizontal: today's change. Vertical: return versus average cost.
          x: finite(daily) ? daily : null,
          y: finite(holding.averageCost) && holding.averageCost > 0
            ? (currentPrice / holding.averageCost - 1) * 100 : null,
        };
      });
  }, [holdings, liveQuotes, metrics]);

  const validQuadrantPoints = quadrantPoints.filter(
    (point): point is typeof point & { x: number; y: number } =>
      finite(point.x) && finite(point.y),
  );
  // Use a constant six-interval grid centered on zero, with readable 1/2/5/10
  // multiples rather than dividing an arbitrary data maximum into fractions.
  // The full three-step positive/negative range always contains every point.
  const niceGridStep = (maximum: number, minimumStep: number) => {
    const raw = Math.max(maximum * 1.08 / 3, minimumStep);
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return Math.max(minimumStep, multiple * magnitude);
  };
  const quadrantXStep = niceGridStep(Math.max(0, ...validQuadrantPoints.map((point) => Math.abs(point.x))), 1);
  const quadrantYStep = niceGridStep(Math.max(0, ...validQuadrantPoints.map((point) => Math.abs(point.y))), 5);
  const quadrantXMax = quadrantXStep * 3;
  const quadrantYMax = quadrantYStep * 3;
  const quadrantTicks = [-3, -2, -1, 0, 1, 2, 3];
  const quadrantTickLabel = (value: number) => `${value > 0 ? "+" : ""}${value}%`;
  // Avoid placing names outside the plot's bounds; always keep both axes
  // fixed around zero so the quadrant meanings never flip.
  const quadrantCoordinate = (x: number, y: number) => ({
    left: `${clamp(50 + (x / quadrantXMax) * 46, 6, 94)}%`,
    top: `${clamp(50 - (y / quadrantYMax) * 44, 8, 92)}%`,
  });

  // Keep ticker labels inside their actual quadrant, close to their neon dots.
  // A stable collision solver reserves the four corner descriptions and the
  // left/bottom numeric axes; it never changes a dot's true market coordinates.
  const quadrantLabelPositions = (() => {
    const w = Math.max(280, quadrantPlotSize.width);
    const h = Math.max(260, quadrantPlotSize.height);
    const labelW = w < 430 ? 43 : 49;
    const labelH = 19;
    const layoutKey = `${w}:${h}:${labelW}`;
    if (quadrantLabelSizeRef.current !== layoutKey) {
      quadrantLabelAnchorsRef.current.clear();
      quadrantLabelSizeRef.current = layoutKey;
    }
    type Box = { x: number; y: number; w: number; h: number };
    const reserved: Box[] = [
      { x: 0, y: 0, w: 47, h },
      { x: 0, y: h - 20, w, h: 20 },
      { x: 49, y: 5, w: Math.min(115, w * .31), h: 25 },
      { x: w - Math.min(120, w * .33) - 5, y: 5, w: Math.min(120, w * .33), h: 25 },
      { x: 49, y: h - 55, w: Math.min(115, w * .31), h: 27 },
      { x: w - Math.min(120, w * .33) - 5, y: h - 55, w: Math.min(120, w * .33), h: 27 },
    ];
    const overlap = (a: Box, b: Box) =>
      Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const dots = validQuadrantPoints.map((point) => ({
      point,
      px: w * clamp(50 + point.x / quadrantXMax * 46, 6, 94) / 100,
      py: h * clamp(50 - point.y / quadrantYMax * 44, 8, 92) / 100,
    }));
    // Small clearance for the real neon dots; labels should be *adjacent*
    // by default, not displaced by large artificial 26px keepout boxes.
    const dotKeepouts: Box[] = dots.map((dot) => ({ x: dot.px - 6, y: dot.py - 6, w: 12, h: 12 }));
    const ordered = dots.map((dot, idx) => ({ ...dot, idx, density: dots.reduce((sum, other) =>
      sum + (Math.hypot(dot.px - other.px, dot.py - other.py) < 85 ? 1 : 0), 0),
    })).sort((a, b) => b.density - a.density || a.idx - b.idx);
    const occupied: Box[] = [...reserved];
    const placed: Array<{ x: number; y: number }> = Array(dots.length);
    // Cached anchors are placed first. Live ticks move labels together with
    // their own dots instead of re-running a global collision search.
    for (const dot of ordered) {
      const anchor = quadrantLabelAnchorsRef.current.get(dot.point.ticker);
      if (!anchor) continue;
      // Existing anchors are reused only if they still respect the preferred
      // vertical placement (upper quadrants above, lower quadrants below).
      const preferredAbove = dot.point.y >= 0;
      const isPreferred = preferredAbove ? anchor.dy < -labelH / 2 : anchor.dy > labelH / 2;
      const isSide = Math.abs(anchor.dx) >= labelW / 2 && Math.abs(anchor.dy) <= labelH / 2;
      if (!isPreferred && !isSide) {
        quadrantLabelAnchorsRef.current.delete(dot.point.ticker);
        continue;
      }
      const x = clamp(dot.px + anchor.dx, 48, w - labelW - 5);
      const y = clamp(dot.py + anchor.dy, 31, h - labelH - 20);
      const cachedBox = { x, y, w: labelW, h: labelH };
      // Never lock in a distant label when an adjacent slot has opened up.
      // Distance is measured to the nearest edge, not the label center.
      const edgeDistance = (box: Box) => Math.hypot(
        dot.px - clamp(dot.px, box.x, box.x + box.w),
        dot.py - clamp(dot.py, box.y, box.y + box.h),
      );
      const nearbySlots: Box[] = (preferredAbove
        ? [[0, -labelH / 2 - 4], [labelW / 2 + 4, 0], [-labelW / 2 - 4, 0]]
        : [[0, labelH / 2 + 4], [labelW / 2 + 4, 0], [-labelW / 2 - 4, 0]]
      ).map(([dx, dy]) => ({
        x: clamp(dot.px + dx - labelW / 2, 48, w - labelW - 5),
        y: clamp(dot.py + dy - labelH / 2, 31, h - labelH - 20),
        w: labelW, h: labelH,
      }));
      const nearerFreeSlot = nearbySlots.some((slot) =>
        edgeDistance(slot) + 3 < edgeDistance(cachedBox) &&
        !occupied.some((r) => overlap(slot, r) > 0) &&
        !dotKeepouts.some((r) => overlap(slot, r) > 0)
      );
      if (nearerFreeSlot || edgeDistance(cachedBox) > 22) {
        quadrantLabelAnchorsRef.current.delete(dot.point.ticker);
        continue;
      }
      if (occupied.some((r) => overlap(cachedBox, r) > 0) ||
          dotKeepouts.some((r) => overlap(cachedBox, r) > 0)) {
        quadrantLabelAnchorsRef.current.delete(dot.point.ticker);
        continue;
      }
      placed[dot.idx] = { x, y };
      occupied.push({ x, y, w: labelW, h: labelH });
    }
    for (const dot of ordered) {
      if (placed[dot.idx]) continue;
      let best: Box | null = null;
      let bestCost = Number.POSITIVE_INFINITY;
      // Quadrant-aware ordering: upper half ABOVE the point, lower half
      // BELOW the point. Use left/right only if the nearest vertical slots
      // are blocked. Avoid diagonal jumps and distant labels.
      const above = dot.point.y >= 0;
      const candidateGroups: Array<Array<[number, number]>> = [
        [4, 7, 11, 16].map((gap): [number, number] => [0, above ? -labelH / 2 - gap : labelH / 2 + gap]),
        [4, 7, 11, 16].flatMap((gap): Array<[number, number]> => [
          [labelW / 2 + gap, 0], [-labelW / 2 - gap, 0],
        ]),
        [21, 29, 40, 55].flatMap((gap): Array<[number, number]> => [
          [0, above ? -labelH / 2 - gap : labelH / 2 + gap],
          [labelW / 2 + gap, 0], [-labelW / 2 - gap, 0],
        ]),
      ];
      for (const group of candidateGroups) {
        let groupBest: Box | null = null;
        let groupCost = Number.POSITIVE_INFINITY;
        for (const [dx, dy] of group) {
          const candidate: Box = {
            x: clamp(dot.px + dx - labelW / 2, 48, w - labelW - 5),
            y: clamp(dot.py + dy - labelH / 2, 31, h - labelH - 20),
            w: labelW, h: labelH,
          };
          const collision = occupied.reduce((sum, r) => sum + overlap(candidate, r), 0);
          const blockedDots = dotKeepouts.reduce((sum, r) => sum + overlap(candidate, r), 0);
          const nearX = clamp(dot.px, candidate.x, candidate.x + candidate.w);
          const nearY = clamp(dot.py, candidate.y, candidate.y + candidate.h);
          const distance = Math.hypot(nearX - dot.px, nearY - dot.py);
          const cost = (collision > 0 ? 100000 + collision * 100 : 0)
            + (blockedDots > 0 ? 100000 + blockedDots * 200 : 0) + distance;
          if (cost < groupCost) { groupCost = cost; groupBest = candidate; }
        }
        if (groupBest && groupCost < 100000) {
          best = groupBest;
          break;
        }
        if (groupBest && groupCost < bestCost) { bestCost = groupCost; best = groupBest; }
      }
      if (!best) continue;
      occupied.push(best);
      placed[dot.idx] = { x: best.x, y: best.y };
      quadrantLabelAnchorsRef.current.set(dot.point.ticker, {
        dx: best.x - dot.px, dy: best.y - dot.py,
      });
    }
    return placed;
  })();

  const mappedHoldings = useMemo<MapHolding[]>(() => {
    return holdings.map((holding) => {
      const targetAllocation = finite(targets[holding.ticker])
        ? targets[holding.ticker]
        : holding.allocation;
      const metric = metrics[holding.ticker];
      const signal = calculateSignal(holding.allocation, targetAllocation, metric);
      return {
        ...holding,
        targetAllocation,
        gap: targetAllocation - holding.allocation,
        score: continuousScore(signal, metric),
        side: signal.side,
        level: signal.level,
        marketReturn1Day: finite(metric?.return1Day)
          ? metric.return1Day
          : holding.dailyChangePercent,
      };
    });
  }, [holdings, targets, metrics]);

  const categories = useMemo(() => {
    const grouped = new Map<string, MapHolding[]>();
    for (const holding of mappedHoldings) {
      const category = holding.category || "Other";
      grouped.set(category, [...(grouped.get(category) ?? []), holding]);
    }
    return Array.from(grouped.entries())
      .map(([name, items]) => ({
        name,
        items,
        allocation: items.reduce((sum, item) => sum + Math.max(item.allocation, 0), 0),
      }))
      .sort((a, b) => b.allocation - a.allocation);
  }, [mappedHoldings]);

  // The ALL view includes sectors whose REAL portfolio share exceeds 1%.
  // Do not filter their individual holdings: sector content remains complete.
  const visibleCategories = focusedCategory === "ALL"
    ? categories.filter((category) => category.allocation > 1)
    : categories.filter((category) => category.name === focusedCategory);

  // A bounded, rectangular tiling: every row spans the SAME canvas width,
  // and the final row ends on the SAME canvas bottom.  No tile may protrude.
  // Unlike unconstrained squarify, row groups are chosen with header legibility
  // as a hard constraint wherever geometry permits.
  const categoryLayout = useMemo(() => {
    const inset = 5;
    const canvas: Rect = {
      x: inset, y: inset,
      width: Math.max(0, size.width - inset * 2),
      height: Math.max(0, size.height - inset * 2),
    };
    const entries = visibleCategories.filter(c => c.allocation > 0);
    const n = entries.length;
    const total = entries.reduce((sum, c) => sum + c.allocation, 0);
    if (!n || total <= 0 || canvas.width <= 0 || canvas.height <= 0) return [];
    const prefix = [0];
    entries.forEach(c => prefix.push(prefix[prefix.length - 1] + c.allocation));
    const nameWidth = (name: string) => Math.max(48, 16 + name.length * 6.6);
    const solve = (strict: boolean) => {
      const dp = Array(n + 1).fill(Infinity) as number[];
      const next = Array(n).fill(-1) as number[];
      dp[n] = 0;
      for (let i = n - 1; i >= 0; i--) {
        for (let j = i + 1; j <= n; j++) {
          const weight = prefix[j] - prefix[i];
          const h = canvas.height * weight / total;
          let cost = 0;
          let allowed = true;
          for (let k = i; k < j; k++) {
            const w = canvas.width * entries[k].allocation / weight;
            const shortW = Math.max(0, nameWidth(entries[k].name) - w);
            const shortH = Math.max(0, 56 - h);
            if (strict && (shortW > .01 || shortH > .01)) { allowed = false; break; }
            // Favor square-ish sections, but never favor them over headers.
            const ratio = Math.max(w / Math.max(h, 1), h / Math.max(w, 1));
            cost += Math.log(Math.max(1, ratio)) ** 2 * 4;
            cost += shortW * shortW * 300 + shortH * shortH * 300;
          }
          if (!allowed || !Number.isFinite(dp[j])) continue;
          cost += 1 + dp[j];
          if (cost < dp[i]) { dp[i] = cost; next[i] = j; }
        }
      }
      return next[0] > 0 ? next : null;
    };
    const groups = solve(true) ?? solve(false);
    if (!groups) return [];
    const result: LayoutItem<(typeof entries)[number]>[] = [];
    let y = canvas.y;
    for (let i = 0; i < n;) {
      const j = groups[i];
      if (j <= i || j > n) break;
      const rowWeight = prefix[j] - prefix[i];
      const rowBottom = j === n ? canvas.y + canvas.height
        : Math.min(canvas.y + canvas.height, y + canvas.height * rowWeight / total);
      let x = canvas.x;
      for (let k = i; k < j; k++) {
        const right = k === j - 1 ? canvas.x + canvas.width
          : Math.min(canvas.x + canvas.width, x + canvas.width * entries[k].allocation / rowWeight);
        result.push({item: entries[k], weight: entries[k].allocation,
          rect: {x, y, width: Math.max(0, right - x), height: Math.max(0, rowBottom - y)}});
        x = right;
      }
      y = rowBottom;
      i = j;
    }
    return result;
  }, [visibleCategories, size]);

  return (
    <section className="market-map-page">
      <section className="hero market-map-hero">
        <div>
          <span>PORTFOLIO MARKET MAP</span>
          <h1>Allocation Intelligence Map</h1>
          <p>사각형 크기는 현재 비중, 색상은 리밸런싱 상태를 보여줍니다. 카테고리를 선택하거나 종목을 눌러 확인하세요.</p>
        </div>
      </section>

      <section className="map-toolbar card">
        <div className="map-category-filter">
          <button className={focusedCategory === "ALL" ? "active" : ""} onClick={() => setFocusedCategory("ALL")}>All Categories</button>
          {categories.map((category) => (
            <button
              key={category.name}
              className={focusedCategory === category.name ? "active" : ""}
              onClick={() => setFocusedCategory(category.name)}
            >
              {category.name}
            </button>
          ))}
        </div>
        <div className="map-view-toggle">
          <button className={viewMode === "score" ? "active" : ""} onClick={() => setViewMode("score")}>Rebalancing</button>
          <button className={viewMode === "daily" ? "active" : ""} onClick={() => setViewMode("daily")}>Daily Change</button>
        </div>
      </section>

      <section className="market-map-grid">
        <section className="treemap-card card">
          <div className="treemap-heading">
            <div><span>LIVE PORTFOLIO MAP</span><h2>{focusedCategory === "ALL" ? "All Categories" : focusedCategory}</h2></div>
            <div className="map-legend">
              {viewMode === "score" ? (
                <>
                  <span><i className="legend-buy-strong" />Strong Buy</span>
                  <span><i className="legend-buy" />Buy</span>
                  <span><i className="legend-balanced" />Balanced</span>
                  <span><i className="legend-sell" />Sell</span>
                  <span><i className="legend-sell-strong" />Strong Sell</span>
                </>
              ) : (
                <>
                  <span><i className="legend-daily-up" />Up</span>
                  <span><i className="legend-balanced" />Flat</span>
                  <span><i className="legend-daily-down" />Down</span>
                </>
              )}
            </div>
          </div>

          <div className="treemap-host" ref={hostRef} style={{ height: size.height }}>
            {categoryLayout.map(({ item: category, rect }) => {
              // A constant sector gutter leaves the same visible space at every edge.
              const sectorInset = 1;
              // Reserve the REAL header height, including all of its box.
              // A 27px header over a 22px reservation caused the overlap.
              const headerHeight = Math.min(24, Math.max(0, rect.height - sectorInset * 2));
              const innerRect = {
                x: sectorInset,
                y: sectorInset + headerHeight,
                width: Math.max(0, rect.width - sectorInset * 2),
                height: Math.max(0, rect.height - sectorInset * 2 - headerHeight),
              };
              // Hide only sub-legible stock slivers, then redistribute their
              // freed area across the remaining holdings in this same sector.
              // Full category mode still allows inspection of small holdings.
              const candidates = category.items
                .filter((holding) => holding.allocation > 0)
                .map((holding) => ({ item: holding, weight: holding.allocation }));
              const holdingLayout = tappableTreemap(candidates, innerRect, 29, 24);

              return (
                <div key={category.name} className="map-sector-viewport" style={{
                  left: Math.max(0, rect.x), top: Math.max(0, rect.y),
                  width: Math.min(Math.max(0, rect.width), Math.max(0, size.width - rect.x)),
                  height: Math.min(Math.max(0, rect.height), Math.max(0, size.height - rect.y)),
                }}>
                  {headerHeight > 0 && (
                    <button
                      className="category-map-label"
                      style={{
                        left: sectorInset,
                        top: sectorInset,
                        width: Math.max(0, rect.width - sectorInset * 2),
                        height: headerHeight,
                      }}
                      title={`${category.name} · ${category.allocation.toFixed(1)}%`}
                      onClick={() =>
                        setFocusedCategory((current) =>
                          current === category.name ? "ALL" : category.name,
                        )
                      }
                    >
                      <strong style={{ fontSize: `${Math.min(10, Math.max(8, (rect.width - 14) / Math.max(1, category.name.length * 0.62)))}px` }}>{category.name}</strong>
                      {rect.width >= 186 && <span>{category.allocation.toFixed(1)}%</span>}
                    </button>
                  )}

                  {holdingLayout.map(({ item: holding, rect: tileRect }) => {
                    const compact = tileRect.width < 118 || tileRect.height < 86;
                    const tiny = tileRect.width < 72 || tileRect.height < 58;
                    const showAllocation = tileRect.width >= 56 && tileRect.height >= 42;
                    const daily = holding.marketReturn1Day ?? 0;
                    const tone =
                      viewMode === "daily"
                        ? daily > 0.15
                          ? "daily-up"
                          : daily < -0.15
                            ? "daily-down"
                            : "balanced"
                        : tileTone(holding.side, holding.score);

                    return (
                      <button
                        key={holding.ticker}
                        className={`market-tile ${tone} ${selectedTicker === holding.ticker ? "selected" : ""}`}
                        style={{
                           left: Math.max(0, tileRect.x + 0.35),
                          top: Math.max(0, tileRect.y + 0.35),
                          width: Math.max(0, Math.min(tileRect.width - 0.7, rect.width - tileRect.x - 0.35)),
                          height: Math.max(0, Math.min(tileRect.height - 0.7, rect.height - tileRect.y - 0.35)),
                        }}
                        onClick={() => setSelectedTicker(holding.ticker)}
                        title={`${holding.ticker} · 현재 ${holding.allocation.toFixed(2)}% · 목표 ${holding.targetAllocation.toFixed(2)}% · 점수 ${holding.score.toFixed(1)}`}
                      >
                        {!tiny && <CompanyMark ticker={holding.ticker} size={compact ? 27 : 38} />}
                        <div className="market-tile-copy">
                          <strong>{holding.ticker}</strong>
                          {showAllocation && <span>{holding.allocation.toFixed(2)}%</span>}
                          {!compact && (
                            <small>
                              {viewMode === "score"
                                ? `${holding.score.toFixed(1)} pts`
                                : formatPercent(holding.marketReturn1Day)}
                            </small>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>

      </section>

      <section className="quadrant-card card" aria-label="상위 10개 종목 실시간 수익률 4사분면">
        <div className="quadrant-heading">
          <div>
            <span>LIVE RETURN QUADRANTS</span>
            <h2>Top 10 · 수익률 4사분면</h2>
          </div>
          <span className="quadrant-refresh"><i /> 1초 간격 시세 갱신</span>
        </div>
        <div className="quadrant-plot" ref={quadrantPlotRef} role="img" aria-label="가로축 금일 등락률, 세로축 매수가 대비 수익률로 나타낸 상위 10개 종목 산점도">
          {quadrantTicks.map((fraction) => (
            <div
              key={`x-grid-${fraction}`}
              className={`quadrant-grid-line quadrant-grid-vertical${fraction === 0 ? " axis-zero" : ""}`}
              style={{ left: `${50 + fraction / 3 * 46}%` }}
            />
          ))}
          {quadrantTicks.map((fraction) => (
            <div
              key={`y-grid-${fraction}`}
              className={`quadrant-grid-line quadrant-grid-horizontal${fraction === 0 ? " axis-zero" : ""}`}
              style={{ top: `${50 - fraction / 3 * 44}%` }}
            />
          ))}
          {quadrantTicks.map((fraction) => (
            <span
              key={`x-tick-${fraction}`}
              className="quadrant-grid-label quadrant-grid-label-x"
              style={{ left: `${50 + fraction / 3 * 46}%` }}
            >{quadrantTickLabel(quadrantXStep * fraction)}</span>
          ))}
          {quadrantTicks.map((fraction) => (
            <span
              key={`y-tick-${fraction}`}
              className="quadrant-grid-label quadrant-grid-label-y"
              style={{ top: `${50 - fraction / 3 * 44}%` }}
            >{quadrantTickLabel(quadrantYStep * fraction)}</span>
          ))}
          {/* Leader lines connect distant ticker labels to their actual neon dots.
              A transparent SVG overlay never intercepts interaction. */}
          <svg className="quadrant-leader-lines" viewBox={`0 0 ${Math.max(280, quadrantPlotSize.width)} ${Math.max(260, quadrantPlotSize.height)}`} preserveAspectRatio="none" aria-hidden="true">
            {validQuadrantPoints.map((point, index) => {
              const label = quadrantLabelPositions[index];
              if (!label) return null;
              const w = Math.max(280, quadrantPlotSize.width);
              const h = Math.max(260, quadrantPlotSize.height);
              const px = w * clamp(50 + point.x / quadrantXMax * 46, 6, 94) / 100;
              const py = h * clamp(50 - point.y / quadrantYMax * 44, 8, 92) / 100;
              const labelW = w < 430 ? 43 : 49;
              const labelH = 19;
              const lx = clamp(px, label.x + 2, label.x + labelW - 2);
              const ly = clamp(py, label.y + 2, label.y + labelH - 2);
              const distance = Math.hypot(px - lx, py - ly);
              // Close-by names need no leader line; reserve it for the few
              // labels that genuinely must move away to avoid a collision.
              // Adjacent labels are self-explanatory: do not draw decorative
              // leaders from dots to text only a few pixels away.
              if (distance <= 22) return null;
              const inset = 6;
              const x1 = px + (lx - px) * inset / distance;
              const y1 = py + (ly - py) * inset / distance;
              return <line key={`leader-${point.ticker}`} x1={x1} y1={y1} x2={lx} y2={ly}
                stroke={point.y >= 0 ? "#ff8290" : "#80c1ff"} strokeWidth="0.6" strokeOpacity="0.55" />;
            })}
          </svg>
          {validQuadrantPoints.map((point) => (
            <div
              key={point.ticker}
              className={`quadrant-point ${point.y >= 0 ? "gain" : "loss"}`}
              style={quadrantCoordinate(point.x, point.y)}
              title={`${point.ticker} · 매수가 $${point.averageCost.toFixed(2)} · 현재가 $${point.price.toFixed(2)} · 매수가 대비 ${formatPercent(point.y)} · 당일 ${formatPercent(point.x)}`}
            >
              <span className="quadrant-neon-dot" aria-hidden="true" />
            </div>
          ))}
          <span className="quadrant-zone zone-tl">2사분면 · 매수 수익 / 오늘 하락</span>
          <span className="quadrant-zone zone-tr">1사분면 · 매수 수익 / 오늘 상승</span>
          <span className="quadrant-zone zone-bl">3사분면 · 매수 손실 / 오늘 하락</span>
          <span className="quadrant-zone zone-br">4사분면 · 매수 손실 / 오늘 상승</span>
          {validQuadrantPoints.map((point, index) => (
            <div key={`label-${point.ticker}`}
              className={`quadrant-floating-label ${point.y >= 0 ? "gain" : "loss"}`}
              style={{ left: quadrantLabelPositions[index]?.x ?? 50, top: quadrantLabelPositions[index]?.y ?? 65 }}
              title={`${point.ticker}: 매수가 대비 ${formatPercent(point.y)}, 오늘 ${formatPercent(point.x)}`}>
              <strong>{point.ticker}</strong><small>{formatPercent(point.y)}</small>
            </div>
          ))}
          {validQuadrantPoints.length === 0 && (
            <div className="quadrant-empty">평균 매수가와 시세가 있는 종목을 표시합니다.</div>
          )}
        </div>
        <div className="quadrant-axis-bottom"><span className="quadrant-axis-down">← 금일 하락</span><span className="quadrant-axis-up">금일 상승 →</span></div>
        {quadrantPoints.some((point) => point.y === null) && (
          <p className="quadrant-note">평균 매수가가 등록되지 않은 종목은 점으로 표시하지 않았습니다.</p>
        )}
        <div className="quadrant-prices">
          {quadrantPoints.map((point, index) => (
            <div key={point.ticker} className="quadrant-price">
              <div className="quadrant-price-heading">
                <span className={`quadrant-price-rank${index < 3 ? ` rank-${index + 1}` : ""}`}>{index + 1}</span>
                <b>{point.ticker}</b>
              </div>
              <div className="quadrant-price-data">
                <div className="quadrant-price-field">
                  <span>수익률</span>
                  <strong className={finite(point.y) ? point.y >= 0 ? "positive" : "negative" : ""}>{formatPercent(point.y)}</strong>
                </div>
                <div className="quadrant-price-field">
                  <span>금일</span>
                  <strong className={finite(point.x) ? point.x >= 0 ? "positive" : "negative" : ""}>{formatPercent(point.x)}</strong>
                </div>
                <div className="quadrant-price-field">
                  <span>매수</span>
                  <strong>{point.averageCost > 0 ? `$${point.averageCost.toFixed(2)}` : "—"}</strong>
                </div>
                <div className="quadrant-price-field">
                  <span>현재</span>
                  <strong>${point.price.toFixed(2)}</strong>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <style jsx global>{`
        .quadrant-card { min-width:0; padding:16px; }
        .quadrant-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin:0 0 5px 6px; }
        .quadrant-heading > div > span { color:#e87722; font-size:10px; font-weight:900; letter-spacing:.12em; }
        .quadrant-heading h2 { margin:4px 0; font-size:16px; color:#210a13; }
        .quadrant-refresh { display:inline-flex; align-items:center; white-space:nowrap; font-size:10px; color:#334155; font-weight:700; }
        .quadrant-refresh i { width:6px; height:6px; margin-right:5px; border-radius:50%; background:#16a34a; }
        .quadrant-plot { position:relative; height:315px; overflow:hidden; border:1px solid #dde4ee; border-radius:10px; background:linear-gradient(to bottom,rgba(108,29,45,.27) 0%,rgba(108,29,45,.17) 49.8%,rgba(25,68,132,.21) 50.2%,rgba(25,68,132,.30) 100%),radial-gradient(ellipse at 50% 50%,#1a2b4b 0%,#0e1a33 72%,#0a1225 100%); }
        .quadrant-grid-line { position:absolute; pointer-events:none; z-index:0; }
        .quadrant-grid-vertical { top:0; bottom:0; border-left:1px dashed rgba(153,186,225,.30); }
        .quadrant-grid-horizontal { left:0; right:0; border-top:1px dashed rgba(153,186,225,.30); }
        .quadrant-grid-line.axis-zero.quadrant-grid-vertical { border-left:1.5px solid #88a1c4; }
        .quadrant-grid-line.axis-zero.quadrant-grid-horizontal { border-top:1.5px solid #88a1c4; }
        .quadrant-grid-label { position:absolute; z-index:1; font-size:9px; line-height:1.2; color:#e2e8f0; font-weight:850; pointer-events:none; font-variant-numeric:tabular-nums; background:rgba(9,17,35,.74); padding:1px 2px; border-radius:2px; }
        .quadrant-grid-label-x { bottom:2px; transform:translateX(-50%); }
        .quadrant-grid-label-y { left:3px; transform:translateY(-50%); }
        .quadrant-floating-label { position:absolute; z-index:5; display:flex; width:49px; height:19px; min-width:0; padding:0; flex-direction:column; align-items:center; justify-content:center; gap:1px; border:0; border-radius:0; box-sizing:border-box; background:transparent; white-space:nowrap; pointer-events:none; transition:left .65s linear,top .65s linear; text-shadow:0 1px 3px #020617,0 0 5px #020617; }
        .quadrant-floating-label strong { color:#fff; font-size:8px; font-weight:900; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
        .quadrant-floating-label small { color:#ff707c; font-size:7px; font-weight:850; }
        .quadrant-floating-label.loss small { color:#67b8ff; }
        .quadrant-zone { position:absolute; z-index:4; color:#f1f5f9; font-size:9px; font-weight:850; line-height:1.25; padding:0; border:0; border-radius:0; background:transparent; text-shadow:0 1px 4px #020617; white-space:normal; width:110px; pointer-events:none; }
        .quadrant-zone.zone-tl { top:8px; left:51px; }
        .quadrant-zone.zone-tr { top:8px; right:8px; text-align:right; }
        .quadrant-zone.zone-bl { bottom:30px; left:51px; }
        .quadrant-zone.zone-br { bottom:30px; right:8px; text-align:right; }
        .quadrant-zero-x { position:absolute; top:calc(50% + 4px); left:calc(50% + 5px); font-size:9px; color:#94a3b8; }
        .quadrant-zero-y { position:absolute; top:calc(50% - 15px); left:calc(50% - 21px); font-size:9px; color:#94a3b8; }
        /* Market Pulse-inspired neon signal points: a small illuminated marker,
           with information outside the marker so price movement is observable. */
        .quadrant-leader-lines { position:absolute; z-index:2; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
        .quadrant-point { position:absolute; z-index:3; transform:translate(-50%,-50%); width:12px; height:12px; border:0; border-radius:50%; background:transparent; padding:0; box-sizing:border-box; transition:left .65s linear,top .65s linear; pointer-events:auto; }
        .quadrant-neon-dot { position:absolute; inset:1px; display:block; border-radius:50%; background:var(--neon-color); box-shadow:0 0 0 2px var(--neon-ring),0 0 8px 3px var(--neon-glow),0 0 19px 4px var(--neon-glow); }
        @keyframes quadrant-neon-breathe { 0%,100% { opacity:.66; filter:brightness(.78); box-shadow:0 0 0 1px var(--neon-ring),0 0 5px 1px var(--neon-glow),0 0 11px 2px var(--neon-glow); } 50% { opacity:1; filter:brightness(1.22); box-shadow:0 0 0 2px var(--neon-ring),0 0 10px 4px var(--neon-glow),0 0 21px 5px var(--neon-glow); } }
        .quadrant-neon-dot { animation:quadrant-neon-breathe 1s ease-in-out infinite; transform-origin:center; }
        .quadrant-point:nth-of-type(3n) .quadrant-neon-dot { animation-delay:-.35s; }
        .quadrant-point:nth-of-type(3n + 1) .quadrant-neon-dot { animation-delay:-.65s; }
        .quadrant-neon-dot::after { content:""; position:absolute; inset:2px; border-radius:50%; background:rgba(255,255,255,.85); }
        .quadrant-neon-label { position:absolute; top:-5px; left:18px; display:flex; flex-direction:column; gap:1px; align-items:flex-start; padding:2px 4px; border-radius:4px; background:rgba(9,17,35,.78); color:#f8fafc; line-height:1.1; white-space:nowrap; text-shadow:0 1px 3px #020617; }
        .quadrant-neon-label strong { font-size:10px; font-weight:900; color:#fff; }
        .quadrant-neon-label small { font-size:9px; font-weight:800; color:var(--neon-color); }
        .quadrant-point.gain { --neon-color:#ff545f; --neon-ring:rgba(255,84,95,.35); --neon-glow:rgba(255,55,75,.65); }
        .quadrant-point.loss { --neon-color:#4ca9ff; --neon-ring:rgba(76,169,255,.35); --neon-glow:rgba(42,139,255,.68); }
        .quadrant-point.label-left .quadrant-neon-label { left:auto; right:18px; align-items:flex-end; }
        .quadrant-point:hover,.quadrant-point:focus-within { z-index:10; }
        .quadrant-point:hover .quadrant-neon-dot { box-shadow:0 0 0 3px var(--neon-ring),0 0 13px 5px var(--neon-glow),0 0 22px 7px var(--neon-glow); }
        .quadrant-empty { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:12px; text-align:center; color:#64748b; }
        .quadrant-axis-bottom { display:flex; justify-content:space-between; margin-top:5px; font-size:10px; font-weight:800; }
        .quadrant-axis-down { color:#2563eb; }
        .quadrant-axis-up { color:#dc2626; }
        .quadrant-note { margin:8px 0 0; color:#64748b; font-size:10px; }
        .quadrant-prices { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:5px; margin-top:12px; }
        .quadrant-price { min-width:0; padding:6px 8px; display:flex; flex-direction:column; gap:4px; border:1px solid #e2e8f0; border-radius:8px; font-size:10px; color:#1e293b; font-weight:750; }
        .quadrant-price-heading { display:flex; align-items:center; gap:6px; min-width:0; }
        .quadrant-price-heading b { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#0f172a; font-size:10px; font-weight:900; }
        .quadrant-price-rank { display:inline-grid; flex:0 0 19px; width:19px; height:19px; place-items:center; border-radius:5px; background:#f1f5f9; color:#475569; font-size:10px; font-weight:900; }
        /* Medal colors only on ranks 1–3; number remains legible. */
        .quadrant-price-rank.rank-1 { background:#f4cf59; color:#714c03; }
        .quadrant-price-rank.rank-2 { background:#d8dee8; color:#475569; }
        .quadrant-price-rank.rank-3 { background:#d5a078; color:#653a20; }
        /* Four values use one 2x2 grid so Today's and Current's left edges align. */
        .quadrant-price-data { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); column-gap:8px; row-gap:3px; min-width:0; }
        .quadrant-price-field { display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-start; min-width:0; gap:1px; font-size:10px; line-height:1.15; }
        .quadrant-price-field > span { color:#475569; font-size:10px; font-weight:800; white-space:nowrap; }
        .quadrant-price-field > strong { color:#1e293b; font-size:10px; font-weight:850; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .quadrant-price-field > strong.positive { color:#dc2626; }
        .quadrant-price-field > strong.negative { color:#2563eb; }
        @media(max-width:720px) {
          .quadrant-card { padding:10px; }
          .quadrant-heading { margin-left:12px; }
          .quadrant-heading h2 { font-size:13px; }
          .quadrant-heading p { font-size:9px; }
          .quadrant-refresh { font-size:8px; }
          .quadrant-plot { height:290px; }
          .quadrant-zone { font-size:8px; width:105px; }
          .quadrant-floating-label { width:43px; height:19px; }
          .quadrant-floating-label strong { font-size:7.5px; }
          .quadrant-floating-label small { font-size:6.5px; }
          .quadrant-grid-label { font-size:8px; }
          .quadrant-point { width:10px; height:10px; }
          .quadrant-neon-label { left:14px; top:-5px; padding:2px 3px; }
          .quadrant-point.label-left .quadrant-neon-label { right:14px; }
          .quadrant-neon-label strong { font-size:9px; }
          .quadrant-neon-label small { font-size:8px; }
          .quadrant-prices { grid-template-columns:repeat(2,minmax(0,1fr)); }
        }
        .market-map-page { display:flex; flex-direction:column; gap:18px; padding-bottom:28px; }
        .market-map-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:28px; padding:30px 32px; border:1px solid #e5eaf3; border-radius:24px; background:linear-gradient(135deg,#ffffff 0%,#f3f7ff 60%,#edf3ff 100%); box-shadow:0 18px 45px rgba(30,64,175,.07); }
        .market-map-hero > div:first-child { max-width:680px; }
        .treemap-heading > div > span { color:#4263eb; font-size:11px; font-weight:900; letter-spacing:.16em; }
        .market-map-hero h1 { margin:7px 0 8px; }
        .market-map-hero p { margin:0; color:#303846; font-size:14px; line-height:1.65; }
        .map-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px; }
        .map-category-filter { display:flex; min-width:0; gap:8px; overflow-x:auto; scrollbar-width:none; }
        .map-category-filter::-webkit-scrollbar { display:none; }
        .map-category-filter button,.map-view-toggle button { border:1px solid #dfe5ef; border-radius:12px; background:#fff; color:#303846; font-size:11px; font-weight:850; white-space:nowrap; cursor:pointer; }
        .map-category-filter button { padding:9px 11px; }
        .map-category-filter button span { margin-left:6px; color:#303846; }
        .map-category-filter button.active,.map-view-toggle button.active { border-color:#861f41; background:#861f41; color:#fff; box-shadow:0 8px 18px rgba(134,31,65,.20); }
        .map-category-filter button.active span { color:#f9dce7; }
        .map-view-toggle { display:flex; flex:0 0 auto; gap:4px; padding:4px; border-radius:14px; background:#f1f4f9; }
        .map-view-toggle button { padding:8px 12px; border-color:transparent; background:transparent; }
        /* Keep categories and the map-mode switch on one compact horizontal row. */
        .market-map-page > .map-toolbar.card {
          flex-direction:row;
          align-items:center;
          gap:8px;
          padding:8px 10px;
        }
        .market-map-page > .map-toolbar.card .map-category-filter {
          flex:1 1 auto;
          min-width:0;
          flex-wrap:nowrap;
          overflow-x:auto;
          gap:5px;
          overscroll-behavior-x:contain;
        }
        .market-map-page > .map-toolbar.card .map-category-filter button {
          flex:0 0 auto;
          padding:7px 9px;
        }
        .market-map-page > .map-toolbar.card .map-view-toggle {
          display:flex;
          flex:0 0 auto;
          align-self:center;
          gap:2px;
          padding:3px;
        }
        .market-map-page > .map-toolbar.card .map-view-toggle button {
          padding:7px 9px;
        }
        /* Match Rebalancing's 7px separation between adjacent cards. */
        .market-map-page { gap:7px !important; }
        .market-map-page > .map-toolbar.card + .market-map-grid {
          margin-top:0 !important;
        }

        .market-map-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:0; align-items:start; }
        /* Match the map's actual first grid track. dashboard.tsx forces
           .market-map-page .map-toolbar to width:100% !important, so this
           more-specific selector must also use !important. */
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
          width:calc(100% - 328px) !important;
          max-width:calc(100% - 328px) !important;
          flex:0 0 auto;
          box-sizing:border-box !important;
          min-width:0 !important;
        }
        .treemap-card { min-width:0; overflow:hidden; }
        .treemap-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:8px 22px 8px; }
        .treemap-heading h2 { margin:5px 0 0; color:#172033; font-size:20px; }
        .map-legend { display:flex; flex:0 1 auto; flex-wrap:nowrap; align-items:center; justify-content:flex-end; column-gap:clamp(4px,1vw,10px); min-width:0; white-space:nowrap; }
        .map-legend span { display:inline-flex; flex:0 0 auto; align-items:center; gap:3px; color:#303846; font-size:clamp(7px,.75vw,10px); line-height:1.1; font-weight:800; white-space:nowrap; }
        .map-legend i { flex:0 0 auto; width:clamp(6px,.65vw,9px); height:clamp(6px,.65vw,9px); border-radius:2px; }
        .legend-buy-strong{background:#1d4ed8}.legend-buy{background:#75a2ff}.legend-balanced{background:#aeb8c8}.legend-sell{background:#ff9b9b}.legend-sell-strong{background:#dc2626}.legend-daily-up{background:#ef4444}.legend-daily-down{background:#3b82f6}
        .treemap-host > .map-sector-viewport { position:absolute; overflow:hidden; box-sizing:border-box; contain:layout paint; }
        .treemap-host { position:relative; width:100%; min-height:0; overflow:hidden; box-sizing:border-box; border-top:1px solid #edf0f5; background:#e9eef6; }
        .category-map-label { box-sizing:border-box; position:absolute; z-index:4; display:flex; align-items:center; justify-content:space-between; height:24px; padding:0 6px; border:0; border-radius:2px; background:rgba(17,24,39,.86); color:#fff; cursor:pointer; backdrop-filter:blur(5px); }
        .category-map-label strong { overflow:hidden; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
        .category-map-label span { margin-left:5px; color:#d5deec; font-size:9px; flex:0 0 auto; }
        .category-map-label { overflow:hidden; white-space:nowrap; }
        .category-map-label strong { min-width:0; font-size:9px; letter-spacing:-.015em; text-overflow:clip; }

        .map-sector-viewport > .market-tile { box-sizing:border-box; position:absolute; z-index:2; display:flex; align-items:center; justify-content:center; gap:8px; min-width:0; min-height:0; overflow:hidden; padding:8px; border:1px solid rgba(255,255,255,.72); border-radius:2px; color:#fff; text-align:left; cursor:pointer; transition:transform .16s ease,filter .16s ease,box-shadow .16s ease; box-shadow:inset 0 1px 0 rgba(255,255,255,.18); }
        .market-tile:hover,.market-tile.selected { z-index:5; transform:none; filter:brightness(1.06); box-shadow:0 12px 28px rgba(15,23,42,.22),inset 0 1px 0 rgba(255,255,255,.24); }
        .market-tile.buy-strong{background:linear-gradient(145deg,#163a9d,#2563eb)}.market-tile.buy-high{background:linear-gradient(145deg,#386bd4,#5b8def)}.market-tile.buy-medium{background:linear-gradient(145deg,#6e9be7,#8eb5f4)}.market-tile.buy-low{background:linear-gradient(145deg,#91a9cf,#aebbd1)}
        .market-tile.sell-strong{background:linear-gradient(145deg,#b91c1c,#ef4444)}.market-tile.sell-high{background:linear-gradient(145deg,#e35a5a,#f17676)}.market-tile.sell-medium{background:linear-gradient(145deg,#ed9696,#f4abab)}.market-tile.sell-low{background:linear-gradient(145deg,#b5a6aa,#c5b8bb)}
        .market-tile.balanced{background:linear-gradient(145deg,#778399,#98a3b5)}.market-tile.daily-up{background:linear-gradient(145deg,#b91c1c,#ef4444)}.market-tile.daily-down{background:linear-gradient(145deg,#1d4ed8,#3b82f6)}
        .map-company-mark { display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; overflow:hidden; border:1px solid rgba(255,255,255,.72); border-radius:50%; font-size:10px; font-weight:950; box-shadow:0 4px 12px rgba(15,23,42,.16); }
        .map-company-mark img { width:78%; height:78%; object-fit:contain; }
        .market-tile-copy { min-width:0; }
        .market-tile-copy strong,.market-tile-copy span,.market-tile-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .market-tile-copy strong { font-size:clamp(11px,1.1vw,18px); font-weight:950; letter-spacing:-.02em; }
        .market-tile-copy span { margin-top:2px; font-size:10px; font-weight:850; opacity:.92; }
        .market-tile-copy small { margin-top:2px; font-size:9px; font-weight:750; opacity:.74; }
        .detail-score { text-align:right; font-size:24px; line-height:1; }
        .detail-score small { display:block; margin-top:4px; color:#9aa5b6; font-size:9px; }
        .detail-score.buy{color:#2563eb}.detail-score.sell{color:#dc2626}.detail-score.balanced{color:#64748b}
        .positive{color:#dc2626!important}.negative{color:#2563eb!important}
        @media (max-width:1100px) {
          .market-map-grid { grid-template-columns:1fr; row-gap:7px; }
          .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
            width:100% !important;
            max-width:100% !important;
          }
          .market-map-hero { align-items:flex-start; flex-direction:column; }
        }
        @media (max-width:720px) {
          .market-map-page-wrap { padding-left:10px!important; padding-right:10px!important; }
          .market-map-hero { padding:22px 18px; border-radius:19px; }
          /* Heading size follows the same shared .hero rules as Rebalancing. */
          .map-toolbar { align-items:stretch; flex-direction:column; }
          .map-view-toggle { align-self:flex-start; }
          .market-map-page > .map-toolbar.card {
            flex-direction:row !important;
            align-items:center !important;
            gap:6px !important;
            padding:7px 8px !important;
          }
          .market-map-page > .map-toolbar.card .map-category-filter {
            flex:1 1 auto !important;
            min-width:0 !important;
            flex-wrap:nowrap !important;
          }
          .market-map-page > .map-toolbar.card .map-view-toggle {
            flex:0 0 auto !important;
            align-self:center !important;
          }
          .market-map-page > .map-toolbar.card .map-category-filter button,
          .market-map-page > .map-toolbar.card .map-view-toggle button {
            font-size:10px;
            padding:6px 7px;
          }
          .treemap-heading { flex-direction:column; gap:12px; padding:8px 12px 9px; }
          .map-legend { width:100%; justify-content:flex-start; gap:clamp(4px,1.6vw,10px); }
          .map-legend span { font-size:clamp(7px,2vw,9px); gap:3px; }
          .map-legend i { width:7px; height:7px; }
          .treemap-host { min-height:0; }
          .market-tile { border-radius:2px; padding:5px; }
          .map-company-mark { display:none; }
          .market-tile-copy strong { font-size:10px; }
          .market-tile-copy span { font-size:8px; }
        }
      `}</style>
      <style jsx global>{`
        /* Toolbar recovery: the dashboard's global mobile styles force both
           children to width:100%. Use an explicit grid and override those
           inherited widths so they cannot overlap or overflow. */
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
          display:grid !important;
          grid-template-columns:minmax(0,1fr) auto !important;
          align-items:center !important;
          justify-content:stretch !important;
          column-gap:8px !important;
          row-gap:5px !important;
          padding:8px 10px !important;
          height:auto !important;
          overflow:hidden !important;
          box-sizing:border-box !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-category-filter {
          display:flex !important;
          width:100% !important;
          min-width:0 !important;
          max-width:100% !important;
          flex-wrap:nowrap !important;
          overflow-x:auto !important;
          overflow-y:hidden !important;
          gap:5px !important;
          padding:2px 0 !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-view-toggle {
          display:flex !important;
          width:auto !important;
          min-width:max-content !important;
          max-width:100% !important;
          grid-template-columns:none !important;
          flex-wrap:nowrap !important;
          justify-self:end !important;
          align-self:center !important;
          gap:3px !important;
          padding:3px !important;
          box-sizing:border-box !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-view-toggle > button {
          width:auto !important;
          min-width:0 !important;
          flex:0 0 auto !important;
          height:32px !important;
          padding:0 8px !important;
          overflow:visible !important;
          text-overflow:clip !important;
          white-space:nowrap !important;
        }
        @media(max-width:1100px) {
          .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
            grid-template-columns:minmax(0,1fr) !important;
            width:100% !important;
            max-width:100% !important;
          }
          .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-category-filter {
            grid-column:1 !important;
            grid-row:1 !important;
          }
          .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-view-toggle {
            grid-column:1 !important;
            grid-row:2 !important;
            justify-self:end !important;
          }
        }
        /* Two stable rows: category names only, then two equal-width mode buttons. */
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
          grid-template-columns:minmax(0,1fr) !important;
          row-gap:5px !important;
          overflow:hidden !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-category-filter {
          grid-column:1 !important;
          grid-row:1 !important;
          width:100% !important;
          min-width:0 !important;
          padding:2px 0 !important;
          gap:5px !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-category-filter > button {
          padding:0 9px !important;
          height:30px !important;
          font-size:11px !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-view-toggle {
          display:grid !important;
          grid-column:1 !important;
          grid-row:2 !important;
          grid-template-columns:repeat(2,minmax(0,1fr)) !important;
          justify-self:stretch !important;
          align-self:stretch !important;
          width:100% !important;
          min-width:0 !important;
          max-width:100% !important;
          gap:4px !important;
          padding:3px !important;
          box-sizing:border-box !important;
        }
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card > .map-view-toggle > button {
          width:100% !important;
          min-width:0 !important;
          height:30px !important;
          font-size:11px !important;
          font-weight:850 !important;
          padding:0 8px !important;
          text-align:center !important;
        }
      `}</style>
    </section>
  );
}
