import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Point = { t: number; v: number };
type IndexSeries = { name: string; points: Point[] };
type Payload = { nasdaq: IndexSeries; sp500: IndexSeries; updatedAt: number };
// 1s UI polling; history feed provides one-minute candles, not second-by-second ticks.
const TTL_MS = 1_500;
const RETRY_MS = 1_500;
let retryAfter = 0;
let cached: { data: Payload; until: number } | null = null;
let pending: Promise<Payload> | null = null;

async function fetchSeries(symbol: string, name: string): Promise<IndexSeries> {
  const errors: string[] = [];
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1m`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; PortfolioDashboard/1.0)" },
        signal: AbortSignal.timeout(6500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const chart = data?.chart?.result?.[0];
      if (!chart) throw new Error("Empty chart result");
      const timestamps: unknown[] = chart?.timestamp ?? [];
      const prices: unknown[] = chart?.indicators?.quote?.[0]?.close ?? [];
      const points: Point[] = timestamps.flatMap((value, i) => {
        const close = prices[i];
        return typeof value === "number" && typeof close === "number" && Number.isFinite(value) && Number.isFinite(close)
          ? [{ t: value, v: close }] : [];
      });
      if (!points.length) throw new Error("No intraday points");
      return { name, points: points.slice(-450) };
    } catch (e) { errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  throw new Error(`${name} (${errors.join("; ")})`);
}

async function load(): Promise<Payload> {
  const [nasdaq, sp500] = await Promise.all([
    fetchSeries("^IXIC", "NASDAQ Composite"),
    fetchSeries("^GSPC", "S&P 500"),
  ]);
  return { nasdaq, sp500, updatedAt: Date.now() };
}

export async function GET() {
  if (cached && Date.now() < cached.until) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store" } });
  }
  if (!pending && Date.now() >= retryAfter) {
    const task = load().then(data => {
      cached = { data, until: Date.now() + TTL_MS };
      retryAfter = 0;
      return data;
    }).catch(error => {
      retryAfter = Date.now() + RETRY_MS;
      throw error;
    }).finally(() => { if (pending === task) pending = null; });
    void task.catch(() => undefined);
    pending = task;
  }
  // If upstream is slow, retain previously confirmed prices; never synthesize moves.
  if (cached) return NextResponse.json(cached.data, {
    headers: { "Cache-Control": "no-store", "X-Data-Stale": "true" },
  });
  if (!pending) return NextResponse.json({ error: "지수 제공처 재시도 중" }, { status: 503 });
  try {
    const data = await pending;
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (cached) return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store", "X-Data-Stale": "true" } });
    const reason = e instanceof Error ? e.message : "Unknown provider error";
    console.error("market-indices provider error:", reason);
    return NextResponse.json({ error: `지수 시세 제공처 연결 실패: ${reason}` }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
