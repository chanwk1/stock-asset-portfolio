import type { PortfolioHolding } from "../data/portfolio-data";

const PORTFOLIO_STORAGE_KEY = "stock-asset-portfolio-holdings";

export function loadPortfolio(): PortfolioHolding[] | null {
  if (typeof window === "undefined") return null;
  try { const saved = window.localStorage.getItem(PORTFOLIO_STORAGE_KEY); return saved ? JSON.parse(saved) as PortfolioHolding[] : null; } catch { return null; }
}

export function savePortfolio(holdings: PortfolioHolding[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(holdings));
}
