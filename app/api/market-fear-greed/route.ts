import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// CNN's US-equity Fear & Greed index (not the cryptocurrency index or per-stock RSI).
type Reading = { score: number; timestamp: string | null; receivedAt: number };
let lastGood: Reading | null = null;
let pending: Promise<Reading> | null = null;
let lastAttempt = 0;

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://www.cnn.com/markets/fear-and-greed",
  Origin: "https://www.cnn.com",
};

async function fetchCNN(): Promise<Reading> {
  const base = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  const date = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  // A dated graph endpoint is used by the same CNN chart and is a fallback
  // when the no-date endpoint is temporarily unavailable.
  for (const url of [base, `${base}/${date}`]) {
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        cache: "no-store",
        signal: AbortSignal.timeout(6500),
      });
      if (!response.ok) continue;
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("fear_and_greed" in data)) continue;
      const item = (data as { fear_and_greed?: { score?: unknown; timestamp?: unknown } }).fear_and_greed;
      const score = typeof item?.score === "number" ? item.score : Number(item?.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) continue;
      return { score, timestamp: typeof item?.timestamp === "string" ? item.timestamp : null, receivedAt: Date.now() };
    } catch { /* Try the other official CNN graph URL. */ }
  }
  throw new Error("CNN sentiment feed unavailable");
}

export async function GET() {
  const now = Date.now();
  // One market-level reading is shared by all symbols; prevent rapid hammering.
  if (lastGood && now - lastGood.receivedAt < 120_000) {
    return NextResponse.json({ score: lastGood.score, timestamp: lastGood.timestamp, source: "CNN Fear & Greed", stale: false });
  }
  if (now - lastAttempt < 20_000 && !pending) {
    if (lastGood) return NextResponse.json({ score: lastGood.score, timestamp: lastGood.timestamp, source: "CNN Fear & Greed", stale: true });
    return NextResponse.json({ score: null, source: "CNN Fear & Greed", error: "unavailable" }, { status: 503 });
  }
  try {
    if (!pending) {
      lastAttempt = now;
      pending = fetchCNN().finally(() => { pending = null; });
    }
    lastGood = await pending;
    return NextResponse.json({ score: lastGood.score, timestamp: lastGood.timestamp, source: "CNN Fear & Greed", stale: false });
  } catch {
    if (lastGood) return NextResponse.json({ score: lastGood.score, timestamp: lastGood.timestamp, source: "CNN Fear & Greed", stale: true });
    return NextResponse.json({ score: null, source: "CNN Fear & Greed", error: "unavailable" }, { status: 503 });
  }
}
