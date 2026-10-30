export type PortfolioHolding = {
  ticker: string;
  companyName: string;
  logoUrl: string;
  category: string;
  shares: number;
  averageCost: number;
  currentPrice: number;
  dailyChangePercent: number;
};

export const portfolioHoldings: PortfolioHolding[] = [
  { ticker: "NVDA", companyName: "NVIDIA Corporation", logoUrl: "https://logo.clearbit.com/nvidia.com", category: "Technology", shares: 42, averageCost: 98.14, currentPrice: 146.28, dailyChangePercent: 2.84 },
  { ticker: "AAPL", companyName: "Apple Inc.", logoUrl: "https://logo.clearbit.com/apple.com", category: "Technology", shares: 58, averageCost: 181.25, currentPrice: 224.31, dailyChangePercent: 0.62 },
  { ticker: "META", companyName: "Meta Platforms", logoUrl: "https://logo.clearbit.com/meta.com", category: "Communication", shares: 28, averageCost: 416.20, currentPrice: 527.85, dailyChangePercent: 1.96 },
  { ticker: "AMZN", companyName: "Amazon.com, Inc.", logoUrl: "https://logo.clearbit.com/amazon.com", category: "Consumer", shares: 38, averageCost: 188.64, currentPrice: 226.12, dailyChangePercent: -0.41 },
  { ticker: "GOOGL", companyName: "Alphabet Inc.", logoUrl: "https://logo.clearbit.com/google.com", category: "Communication", shares: 55, averageCost: 149.87, currentPrice: 176.92, dailyChangePercent: 1.12 },
  { ticker: "MSFT", companyName: "Microsoft Corporation", logoUrl: "https://logo.clearbit.com/microsoft.com", category: "Technology", shares: 26, averageCost: 411.15, currentPrice: 507.89, dailyChangePercent: 0.74 },
  { ticker: "PLTR", companyName: "Palantir Technologies", logoUrl: "https://logo.clearbit.com/palantir.com", category: "Technology", shares: 110, averageCost: 31.02, currentPrice: 49.20, dailyChangePercent: 3.43 },
  { ticker: "JPM", companyName: "JPMorgan Chase & Co.", logoUrl: "https://logo.clearbit.com/jpmorganchase.com", category: "Financial", shares: 36, averageCost: 231.52, currentPrice: 274.36, dailyChangePercent: 0.38 },
  { ticker: "RTX", companyName: "RTX Corporation", logoUrl: "https://logo.clearbit.com/rtx.com", category: "Defense", shares: 31, averageCost: 133.40, currentPrice: 160.39, dailyChangePercent: 0.67 },
  { ticker: "RKLB", companyName: "Rocket Lab USA", logoUrl: "https://logo.clearbit.com/rocketlabusa.com", category: "Space", shares: 140, averageCost: 18.40, currentPrice: 27.65, dailyChangePercent: 4.82 },
  { ticker: "TSLA", companyName: "Tesla, Inc.", logoUrl: "https://logo.clearbit.com/tesla.com", category: "Consumer", shares: 34, averageCost: 291.36, currentPrice: 328.40, dailyChangePercent: -1.26 },
  { ticker: "QQQ", companyName: "Invesco QQQ Trust", logoUrl: "https://logo.clearbit.com/invesco.com", category: "ETF", shares: 22, averageCost: 468.66, currentPrice: 520.41, dailyChangePercent: 0.54 },
];
