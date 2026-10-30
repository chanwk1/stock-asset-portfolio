import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type FinnhubQuote = {
  c?: number;
  d?: number;
  dp?: number;
  pc?: number;
  t?: number;
};

type YahooChartResult = {
  timestamp?: number[];
  meta?: {
    regularMarketPrice?: number;
    preMarketPrice?: number;
    postMarketPrice?: number;
    previousClose?: number;
    chartPreviousClose?: number;
    regularMarketTime?: number;
    marketState?: string;
  };
  indicators?: {
    quote?: Array<{
      close?: Array<number | null>;
    }>;
  };
};

type LiveQuote = {
  ticker: string;
  price: number | null;
  previousClose: number | null;
  return1Day: number | null;
  source: string | null;
  marketState: string | null;
  quoteTime: number | null;
  error?: string;
};

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentReturn(price: number, previousClose: number) {
  return (price / previousClose - 1) * 100;
}

async function fetchYahooExtended(symbol: string): Promise<LiveQuote | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url =
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
        "?range=5d&interval=1m&includePrePost=true&events=div%2Csplits";

      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 StockAssetPortfolio/3.0",
        },
      });

      if (!response.ok) continue;

      const payload = (await response.json()) as {
        chart?: {
          result?: YahooChartResult[];
          error?: unknown;
        };
      };

      const result = payload.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta;
      const timestamps = result.timestamp ?? [];
      const closes = result.indicators?.quote?.[0]?.close ?? [];

      let latestExtendedPrice: number | null = null;
      let latestExtendedTime: number | null = null;

      for (
        let index = Math.min(timestamps.length, closes.length) - 1;
        index >= 0;
        index -= 1
      ) {
        const timestamp = timestamps[index];
        const close = closes[index];

        if (finite(timestamp) && positive(close)) {
          latestExtendedPrice = close;
          latestExtendedTime = timestamp;
          break;
        }
      }

      const marketState = meta?.marketState?.toUpperCase() ?? null;
      const regularPrice = positive(meta?.regularMarketPrice)
        ? meta.regularMarketPrice
        : null;
      const preMarketPrice = positive(meta?.preMarketPrice)
        ? meta.preMarketPrice
        : null;
      const postMarketPrice = positive(meta?.postMarketPrice)
        ? meta.postMarketPrice
        : null;

      let price: number | null = null;
      let source = "yahoo-regular";

      if (marketState === "PRE" || marketState === "PREPRE") {
        price = preMarketPrice ?? latestExtendedPrice ?? regularPrice;
        source =
          preMarketPrice !== null || latestExtendedPrice !== null
            ? "yahoo-premarket"
            : "yahoo-regular-fallback";
      } else if (
        marketState === "POST" ||
        marketState === "POSTPOST"
      ) {
        price = postMarketPrice ?? latestExtendedPrice ?? regularPrice;
        source =
          postMarketPrice !== null || latestExtendedPrice !== null
            ? "yahoo-afterhours"
            : "yahoo-regular-fallback";
      } else if (marketState === "REGULAR") {
        price = regularPrice ?? latestExtendedPrice;
        source = "yahoo-regular";
      } else {
        // Yahoo가 CLOSED를 반환하더라도 당일 확장시간 1분봉이 더 최신이면 우선합니다.
        price =
          latestExtendedPrice ??
          postMarketPrice ??
          preMarketPrice ??
          regularPrice;
        source =
          latestExtendedPrice !== null
            ? "yahoo-latest-extended"
            : "yahoo-regular-fallback";
      }

      const previousClose = positive(meta?.previousClose)
        ? meta.previousClose
        : positive(meta?.chartPreviousClose)
          ? meta.chartPreviousClose
          : null;

      if (!positive(price) || !positive(previousClose)) continue;

      return {
        ticker: symbol,
        price,
        previousClose,
        return1Day: percentReturn(price, previousClose),
        source,
        marketState,
        quoteTime:
          latestExtendedTime ??
          (finite(meta?.regularMarketTime) ? meta.regularMarketTime : null),
      };
    } catch {
      // 다음 Yahoo 호스트로 재시도합니다.
    }
  }

  return null;
}

async function fetchFinnhub(
  symbol: string,
  token: string,
): Promise<LiveQuote | null> {
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "X-Finnhub-Token": token,
    },
  });

  if (!response.ok) {
    throw new Error(`Finnhub HTTP ${response.status}`);
  }

  const data = (await response.json()) as FinnhubQuote;
  if (!positive(data.c) || !positive(data.pc)) return null;

  return {
    ticker: symbol,
    price: data.c,
    previousClose: data.pc,
    return1Day:
      finite(data.dp) ? data.dp : percentReturn(data.c, data.pc),
    source: "finnhub-fallback",
    marketState: null,
    quoteTime: finite(data.t) ? data.t : null,
  };
}

async function fetchOne(
  symbol: string,
  token: string | undefined,
): Promise<LiveQuote> {
  const yahooQuote = await fetchYahooExtended(symbol);
  if (yahooQuote) return yahooQuote;

  let error = "Yahoo extended-hours quote unavailable";

  if (token) {
    try {
      const finnhubQuote = await fetchFinnhub(symbol, token);
      if (finnhubQuote) return finnhubQuote;
      error = "Yahoo and Finnhub returned empty quotes";
    } catch (caught) {
      error =
        caught instanceof Error
          ? `Yahoo unavailable; ${caught.message}`
          : "Yahoo and Finnhub requests failed";
    }
  } else {
    error =
      "Yahoo extended-hours quote unavailable and FINNHUB_API_KEY is not configured";
  }

  return {
    ticker: symbol,
    price: null,
    previousClose: null,
    return1Day: null,
    source: null,
    marketState: null,
    quoteTime: null,
    error,
  };
}

export async function GET(request: NextRequest) {
  const rawSymbols = request.nextUrl.searchParams.get("symbols") ?? "";

  const symbols = Array.from(
    new Set(
      rawSymbols
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => /^[A-Z0-9.^=-]{1,15}$/.test(symbol)),
    ),
  ).slice(0, 60);

  if (!symbols.length) {
    return NextResponse.json({ data: [] });
  }

  const token = process.env.FINNHUB_API_KEY?.trim();
  const data: LiveQuote[] = [];
  const concurrency = 6;

  for (let index = 0; index < symbols.length; index += concurrency) {
    const batch = symbols.slice(index, index + concurrency);
    data.push(
      ...(await Promise.all(
        batch.map((symbol) => fetchOne(symbol, token)),
      )),
    );
  }

  return NextResponse.json(
    {
      data,
      updatedAt: new Date().toISOString(),
      provider: token
        ? "Yahoo extended-hours + Finnhub fallback"
        : "Yahoo extended-hours",
      version: "3.0",
    },
    {
      headers: {
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
        Pragma: "no-cache",
        Expires: "0",
      },
    },
  );
}
