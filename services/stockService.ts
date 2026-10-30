import { portfolioHoldings, type PortfolioHolding } from "../data/portfolio-data";

export const stockCategories = ["Technology", "Financial", "Communication", "ETF", "Healthcare", "Industrial", "Defense", "Space", "Energy", "Consumer", "Utilities", "Materials", "Real Estate", "Other"] as const;

export type StockInput = Pick<PortfolioHolding, "ticker" | "companyName" | "category" | "shares" | "averageCost">;

export function createStock(input: StockInput): PortfolioHolding {
  const ticker = input.ticker.trim().toUpperCase();
  const knownStock = portfolioHoldings.find((stock) => stock.ticker === ticker);
  return { ticker, companyName: input.companyName.trim() || knownStock?.companyName || `${ticker} Corporation`, category: input.category, shares: Math.max(0, input.shares), averageCost: Math.max(0, input.averageCost), currentPrice: knownStock?.currentPrice ?? Math.max(0, input.averageCost), dailyChangePercent: knownStock?.dailyChangePercent ?? 0, logoUrl: knownStock?.logoUrl ?? `https://logo.clearbit.com/${ticker.toLowerCase()}.com` };
}
