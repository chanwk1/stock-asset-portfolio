import type { PortfolioHolding } from "../data/portfolio-data";
import { createStock } from "../services/stockService";

export function addHolding(holdings: PortfolioHolding[], holding: PortfolioHolding) { return [...holdings.filter((item) => item.ticker !== holding.ticker), holding]; }
export function updateHolding(holdings: PortfolioHolding[], ticker: string, patch: Partial<Pick<PortfolioHolding, "shares" | "category" | "averageCost">>) { return holdings.map((holding) => holding.ticker === ticker ? { ...holding, ...patch } : holding); }
export function deleteHolding(holdings: PortfolioHolding[], ticker: string) { return holdings.filter((holding) => holding.ticker !== ticker); }
export function importCsv(holdings: PortfolioHolding[], csv: string) {
  const rows = csv.split(/\r?\n/).slice(1).map((line) => line.split(",")).filter((row) => row[0]?.trim());
  return rows.reduce((current, [ticker, shares]) => { const existing = current.find((holding) => holding.ticker === ticker.trim().toUpperCase()); const stock = createStock({ ticker, companyName: existing?.companyName ?? "", category: existing?.category ?? "Other", shares: Number(shares) || 0, averageCost: existing?.averageCost ?? 0 }); return addHolding(current, stock); }, holdings);
}
export function exportCsv(holdings: PortfolioHolding[]) { return ["Ticker,Shares", ...holdings.map((holding) => `${holding.ticker},${holding.shares}`)].join("\n"); }
