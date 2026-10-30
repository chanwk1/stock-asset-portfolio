import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RsiEntry = { ticker: string; rsi14: number | null };
const cache = new Map<string, { value: number | null; expires: number }>();
const TTL_MS = 60_000; // Daily-bar RSI does not need one-second upstream polling.

// Wilder's 14-period RSI, based on daily adjusted closing prices where available.
function rsi14(closes: number[]): number | null {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    gains += Math.max(0, delta);
    losses += Math.max(0, -delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, delta)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -delta)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return Math.max(0, Math.min(100, 100 - 100 / (1 + avgGain / avgLoss)));
}

async function getRsi(ticker: string): Promise<RsiEntry> {
  const cached = cache.get(ticker);
  if (cached && cached.expires > Date.now()) return { ticker, rsi14: cached.value };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    let response: Response;
    try {
      response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`Price feed ${response.status}`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const values: unknown[] = result?.indicators?.adjclose?.[0]?.adjclose
      ?? result?.indicators?.quote?.[0]?.close ?? [];
    const closes = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    const value = rsi14(closes);
    cache.set(ticker, { value, expires: Date.now() + TTL_MS });
    return { ticker, rsi14: value };
  } catch {
    // Never fabricate RSI. A previously valid value is preferable to a fake 50.
    return { ticker, rsi14: cached?.value ?? null };
  }
}

export async function GET(request: NextRequest) {
const symbols = Array.from(
  new Set(
    (request.nextUrl.searchParams.get("symbols") ?? "")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z0-9.^=-]{1,15}$/.test(s))
  )
).slice(0, 50);
  const data: RsiEntry[] = [];
  for (let i = 0; i < symbols.length; i += 5) {
    data.push(...await Promise.all(symbols.slice(i, i + 5).map(getRsi)));
  }
  return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
}
