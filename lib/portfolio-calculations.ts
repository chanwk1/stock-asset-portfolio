import type { PortfolioHolding } from "../data/portfolio-data";

export type CalculatedHolding = PortfolioHolding & {
  valueUsd: number;
  valueKrw: number;
  allocation: number;
};

export function calculatePortfolio(holdings: PortfolioHolding[], exchangeRate: number) {
  const totalUsd = holdings.reduce((sum, holding) => sum + holding.shares * holding.currentPrice, 0);
  const calculatedHoldings: CalculatedHolding[] = holdings.map((holding) => {
    const valueUsd = holding.shares * holding.currentPrice;
    return { ...holding, valueUsd, valueKrw: valueUsd * exchangeRate, allocation: totalUsd ? (valueUsd / totalUsd) * 100 : 0 };
  });
  return { holdings: calculatedHoldings, totalUsd, totalKrw: totalUsd * exchangeRate };
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

export function formatKrw(value: number) {
  return `₩${Math.round(value).toLocaleString("ko-KR")}`;
}
