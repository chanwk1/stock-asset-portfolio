import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Quote = { currentPrice: number; dailyChangePercent: number; previousClose?: number; companyName?: string };
type Provider = "finnhub" | "yahoo" | "fallback";
type FxProvider = "yahoo" | "frankfurter" | "fallback";
// UI polls each second, while upstream fetches are rate-budgeted independently.
// One provider cannot furnish a guaranteed one-second quote for every holding.
const CACHE_MS = 1_000;
const PROVIDER_REFRESH_MS = 1_500;
const FX_REFRESH_MS = 1_500;
let fxCache: { rate: number; provider: FxProvider; until: number } | null = null;
let lastAttempt = 0;
const RETRY_MS = 1_500;
const MAX_TICKERS = 60;
let cached: { key: string; until: number; value: unknown } | null = null;
let pending: { key: string; promise: Promise<unknown> } | null = null;
let retryAfter = 0;

async function jsonFetch(url: string, timeoutMs = 6500): Promise<any> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; PortfolioDashboard/1.0)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function yahooQuote(symbol: string): Promise<Quote> {
  let error = "";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1m`;
      const data = await jsonFetch(url);
      const result = data?.chart?.result?.[0];
      const meta = result?.meta;
      const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
      const current = Number(meta?.regularMarketPrice ?? closes[closes.length - 1]);
      const previous = Number(meta?.chartPreviousClose ?? meta?.previousClose ?? closes[0]);
      if (!(current > 0)) throw new Error("No valid latest price");
      return {
        currentPrice: current,
        dailyChangePercent: previous > 0 ? ((current / previous) - 1) * 100 : 0,
        previousClose: previous > 0 ? previous : undefined,
        companyName: String(meta?.longName || meta?.shortName || symbol),
      };
    } catch (e) { error = `${host}: ${e instanceof Error ? e.message : String(e)}`; }
  }
  throw new Error(`${symbol}: ${error}`);
}

async function finnhubQuote(symbol: string, token: string): Promise<Quote> {
  const data = await jsonFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`);
  const current = Number(data?.c), previous = Number(data?.pc);
  if (!(current > 0)) throw new Error(`${symbol}: invalid Finnhub quote`);
  return { currentPrice: current, dailyChangePercent: previous > 0 ? (current / previous - 1) * 100 : Number(data?.dp) || 0, previousClose: previous > 0 ? previous : undefined };
}

async function fxRate(): Promise<{ rate: number | null; provider: FxProvider; warning?: string }> {
  if (fxCache && fxCache.until > Date.now()) return { rate: fxCache.rate, provider: fxCache.provider };
  // Yahoo's USDKRW=X spot quote is preferable to a daily ECB reference rate.
  try {
    const quote = await yahooQuote("USDKRW=X");
    if (quote.currentPrice > 0) {
      fxCache = { rate: quote.currentPrice, provider: "yahoo", until: Date.now() + FX_REFRESH_MS };
      return { rate: quote.currentPrice, provider: "yahoo" };
    }
  } catch { /* Fall through to the published daily reference rate. */ }
  for (const url of [
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW",
    "https://api.frankfurter.app/latest?from=USD&to=KRW",
  ]) {
    try {
      const data = await jsonFetch(url, 4000);
      const rate = Number(data?.rates?.KRW);
      if (rate > 0) {
        // Frankfurter is a DAILY reference rate: cache accordingly and do not imply live FX.
        fxCache = { rate, provider: "frankfurter", until: Date.now() + 60_000 };
        return { rate, provider: "frankfurter", warning: "환율은 일일 기준환율입니다(초당 실시간 아님)." };
      }
    } catch { /* Next provider. */ }
  }
  if (fxCache) return { rate: fxCache.rate, provider: fxCache.provider, warning: "환율 제공처 장애: 이전 값을 표시합니다." };
  return { rate: null, provider: "fallback", warning: "환율 제공처 연결 실패: 앱의 기존 환율을 사용합니다." };
}

async function searchSymbols(query: string) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`;
  const data = await jsonFetch(url);
  return (Array.isArray(data?.quotes) ? data.quotes : [])
    .filter((item: any) => typeof item?.symbol === "string")
    .map((item: any) => ({
      symbol: item.symbol,
      companyName: item.shortname || item.longname || item.symbol,
      exchange: item.exchange,
      quoteType: item.quoteType,
    }));
}

async function load(tickers: string[]) {
  const warnings: string[] = [];
  const prices: Record<string, Quote> = {};
  const token = process.env.FINNHUB_API_KEY?.trim();
  let finnhubSuccess = false;
  let yahooSuccess = false;
  // Per-symbol failover. Limit concurrency and use only the authorized Finnhub API.
  for (let i = 0; i < tickers.length; i += 6) {
    const chunk = tickers.slice(i, i + 6);
    await Promise.all(chunk.map(async symbol => {
      try {
        prices[symbol] = await yahooQuote(symbol);
        yahooSuccess = true;
        return;
      } catch (yahooError) {
        if (token) {
          try {
            prices[symbol] = await finnhubQuote(symbol, token);
            finnhubSuccess = true;
            return;
          } catch (finnhubError) {
            warnings.push(`${symbol}: Yahoo 및 Finnhub 조회 실패`);
          }
        } else {
          warnings.push(`${symbol}: Yahoo 조회 실패 (FINNHUB_API_KEY 미설정)`);
        }
      }
    }));
  }
  const fx = await fxRate();
  if (fx.warning) warnings.push(fx.warning);
  const stocks: Provider = finnhubSuccess ? "finnhub" : yahooSuccess ? "yahoo" : "fallback";
  return {
    prices, exchangeRate: fx.rate, updatedAt: new Date().toISOString(),
    source: { stocks, fx: fx.provider }, warnings,
  };
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  if (query) {
    try { return NextResponse.json({ results: await searchSymbols(query) }, { headers: { "Cache-Control": "no-store" } }); }
    catch (e) { return NextResponse.json({ results: [], error: e instanceof Error ? e.message : "Ticker search unavailable" }, { status: 502 }); }
  }
  const tickers = Array.from(new Set((request.nextUrl.searchParams.get("tickers") || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9.^=\-]{1,20}$/.test(s)))).slice(0, MAX_TICKERS);
  const key = tickers.slice().sort().join(",");
  const now = Date.now();
  if (cached?.key === key && cached.until > now) {
    return NextResponse.json(cached.value, { headers: { "Cache-Control": "no-store" } });
  }

  // Never hold up the 1-second UI poll while upstream providers are responding.
  // Keep showing the last successful response and refresh it in the background.
  if ((!pending || pending.key !== key) && now >= retryAfter && (cached?.key !== key || now - lastAttempt >= PROVIDER_REFRESH_MS)) {
    lastAttempt = now;
    const promise = load(tickers).then(value => {
      const old = cached?.key === key ? cached.value as any : null;
      const latest = value as any;
      // Preserve last valid prices during partial outages, without manufacturing ticks.
      const merged = { ...latest, prices: { ...(old?.prices ?? {}), ...latest.prices },
        exchangeRate: latest.exchangeRate ?? old?.exchangeRate ?? null };
      cached = { key, until: Date.now() + CACHE_MS, value: merged };
      retryAfter = 0;
      return cached.value;
    }).catch(error => {
      retryAfter = Date.now() + RETRY_MS;
      throw error;
    }).finally(() => { if (pending?.promise === promise) pending = null; });
    // The initial request below awaits the promise. On later polls the cached
    // response is served while it runs; prevent unhandled rejections on refresh.
    void promise.catch(() => undefined);
    pending = { key, promise };
  }
  if (cached?.key === key) {
    return NextResponse.json(cached.value, {
      headers: { "Cache-Control": "no-store", "X-Data-Stale": "true" },
    });
  }
  if (!pending || pending.key !== key) {
    return NextResponse.json({ error: "시세 제공처 재시도 중" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return NextResponse.json(await pending.promise, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Market data unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
