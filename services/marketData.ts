import type { PortfolioHolding } from "../data/portfolio-data";

export type MarketQuote = {
  currentPrice: number;
  dailyChangePercent: number;
  previousClose?: number;
  companyName?: string;
};

export type SymbolSearchResult = {
  symbol: string;
  companyName: string;
  exchange?: string;
  quoteType?: string;
};

export type MarketDataResponse = {
  prices: Record<string, MarketQuote>;
  exchangeRate: number | null;
  updatedAt: string;
  source: {
    stocks: "finnhub" | "yahoo" | "fallback";
    fx: "yahoo" | "frankfurter" | "fallback";
  };
  warnings: string[];
};

export async function searchTicker(query: string): Promise<SymbolSearchResult[]> {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return [];

  const params = new URLSearchParams({ query: normalized });
  const response = await fetch(`/api/market-data?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Ticker search failed");
  const data = await response.json() as { results?: SymbolSearchResult[] };
  return data.results ?? [];
}

export async function fetchMarketData(tickers: string[]): Promise<MarketDataResponse> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const params = new URLSearchParams({ tickers: uniqueTickers.join(",") });
  const response = await fetch(`/api/market-data?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Market data request failed");
  return response.json() as Promise<MarketDataResponse>;
}

export function applyMarketPrices(
  holdings: PortfolioHolding[],
  prices: MarketDataResponse["prices"],
): PortfolioHolding[] {
  return holdings.map((holding) => {
    const quote = prices[holding.ticker.toUpperCase()];
    if (!quote) return holding;

    const existingName = holding.companyName?.trim();
    const shouldReplaceName = !existingName || existingName.toUpperCase() === holding.ticker.toUpperCase();

    return {
      ...holding,
      currentPrice: quote.currentPrice,
      dailyChangePercent: quote.dailyChangePercent,
      companyName: shouldReplaceName && quote.companyName ? quote.companyName : holding.companyName,
    };
  });
}
