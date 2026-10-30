import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type FinnhubQuote = {
  c?: number;
  dp?: number;
  pc?: number;
  t?: number;
};

type YahooChartResult = {
  timestamp?: number[];
  meta?: {
    regularMarketPrice?: number;
    previousClose?: number;
    regularMarketTime?: number;
    marketState?: string;
  };
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
    adjclose?: Array<{ adjclose?: Array<number | null> }>;
  };
};

type LiveQuote = {
  ticker: string;
  price: number | null;
  previousClose: number | null;
  return1Day: number | null;
  regularMarketTime: number | null;
  marketState: string | null;
  quoteSource: string | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentReturn(current: number, previous: number | null | undefined) {
  if (!isFinitePositive(current) || !isFinitePositive(previous)) return null;
  return (current / previous - 1) * 100;
}

async function fetchJson(url: string, attempts = 2) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 StockAssetPortfolio/2.0", Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchFinnhubQuote(symbol: string, token: string): Promise<LiveQuote | null> {
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json", "X-Finnhub-Token": token } });
  if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
  const item = await response.json() as FinnhubQuote;
  if (!isFinitePositive(item.c) || !isFinitePositive(item.pc)) return null;
  return {
    ticker: symbol,
    price: item.c,
    previousClose: item.pc,
    return1Day: isFiniteNumber(item.dp) ? item.dp : percentReturn(item.c, item.pc),
    regularMarketTime: isFiniteNumber(item.t) ? item.t : null,
    marketState: null,
    quoteSource: "finnhub",
  };
}

async function fetchYahooQuote(symbol: string): Promise<LiveQuote> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const payload = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`, 1) as { chart?: { result?: YahooChartResult[] } };
      const result = payload.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      const latest = Array.from(closes).reverse().find(isFinitePositive);
      const price = isFinitePositive(result?.meta?.regularMarketPrice) ? result!.meta!.regularMarketPrice! : latest ?? null;
      const previousClose = isFinitePositive(result?.meta?.previousClose) ? result!.meta!.previousClose! : null;
      const return1Day = price !== null ? percentReturn(price, previousClose) : null;
      if (return1Day !== null) return { ticker: symbol, price, previousClose, return1Day, regularMarketTime: result?.meta?.regularMarketTime ?? null, marketState: result?.meta?.marketState ?? null, quoteSource: "yahoo-fallback" };
    } catch {}
  }
  return { ticker: symbol, price: null, previousClose: null, return1Day: null, regularMarketTime: null, marketState: null, quoteSource: null };
}

async function fetchLiveQuote(symbol: string, token: string | undefined) {
  if (token) {
    try {
      const quote = await fetchFinnhubQuote(symbol, token);
      if (quote) return quote;
    } catch {}
  }
  return fetchYahooQuote(symbol);
}

async function fetchHistoryMetric(symbol: string) {
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=history`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=history`,
  ];

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, 2) as {
        chart?: { result?: YahooChartResult[] };
      };

      const result = payload.chart?.result?.[0];
      if (!result) continue;

      const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
      const raw = result.indicators?.quote?.[0]?.close ?? [];
      const history = (adjusted.length ? adjusted : raw).filter(isFinitePositive);

      if (!history.length) continue;

      const historyPrice = history.at(-1)!;

      return {
        sma60: history.length >= 60 ? average(history.slice(-60)) : null,
        sma120: history.length >= 120 ? average(history.slice(-120)) : null,
        sma120Previous:
          history.length >= 140 ? average(history.slice(-140, -20)) : null,
        return3Month:
          history.length >= 64 ? percentReturn(historyPrice, history.at(-64)) : null,
        return1Year:
          history.length >= 253 ? percentReturn(historyPrice, history.at(-253)) : null,
        return3Year:
          history.length >= 757 ? percentReturn(historyPrice, history.at(-757)) : null,
        high52Week:
          history.length ? Math.max(...history.slice(-252)) : null,
        low52Week:
          history.length ? Math.min(...history.slice(-252)) : null,
      };
    } catch {
      // 다음 Yahoo 호스트로 재시도합니다.
    }
  }

  return {
    sma60: null,
    sma120: null,
    sma120Previous: null,
    return3Month: null,
    return1Year: null,
    return3Year: null,
    high52Week: null,
    low52Week: null,
  };
}

export async function GET(request: NextRequest) {
  const rawSymbols = request.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = Array.from(new Set(
    rawSymbols
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
  )).slice(0, 100);

  if (!symbols.length) return NextResponse.json({ data: [] });

  // Finnhub를 실시간 시세의 기본 공급자로 사용하고, 누락 종목만 Yahoo로 보완합니다.
  const token = process.env.FINNHUB_API_KEY?.trim();
  const quoteMap = new Map<string, LiveQuote>();
  const quoteConcurrency = 8;
  for (let index = 0; index < symbols.length; index += quoteConcurrency) {
    const batch = symbols.slice(index, index + quoteConcurrency);
    const quotes = await Promise.all(batch.map((symbol) => fetchLiveQuote(symbol, token)));
    for (const quote of quotes) {
      if (quote.return1Day !== null) quoteMap.set(quote.ticker, quote);
    }
  }

  // 장기 이동평균·수익률 데이터는 Yahoo 일봉을 계속 사용합니다. Finnhub 캔들은 유료 플랜일 수 있습니다.
  const historyMap = new Map<string, Awaited<ReturnType<typeof fetchHistoryMetric>>>();
  const historyConcurrency = 6;

  for (let index = 0; index < symbols.length; index += historyConcurrency) {
    const batch = symbols.slice(index, index + historyConcurrency);
    const results = await Promise.all(
      batch.map(async (symbol) => [symbol, await fetchHistoryMetric(symbol)] as const),
    );

    for (const [symbol, metric] of results) historyMap.set(symbol, metric);
  }

  const data = symbols.map((ticker) => {
    const quote = quoteMap.get(ticker);
    const history = historyMap.get(ticker);

    return {
      ticker,
      price: quote?.price ?? null,
      previousClose: quote?.previousClose ?? null,
      return1Day: quote?.return1Day ?? null,
      regularMarketTime: quote?.regularMarketTime ?? null,
      marketState: quote?.marketState ?? null,
      quoteSource: quote?.quoteSource ?? null,
      sma60: history?.sma60 ?? null,
      sma120: history?.sma120 ?? null,
      sma120Previous: history?.sma120Previous ?? null,
      return3Month: history?.return3Month ?? null,
      return1Year: history?.return1Year ?? null,
      return3Year: history?.return3Year ?? null,
      high52Week: history?.high52Week ?? null,
      low52Week: history?.low52Week ?? null,
      error: quote?.return1Day === null || quote === undefined
        ? "Live quote unavailable after batch and fallback retries"
        : undefined,
    };
  });

  return NextResponse.json(
    { data, updatedAt: new Date().toISOString(), provider: token ? "Finnhub + Yahoo history/fallback" : "Yahoo fallback", version: "2.0" },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    },
  );
}
