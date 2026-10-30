"use client";

import { ChangeEvent, FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { exchangeRate as fallbackExchangeRate } from "../data/exchange-rate";
import { portfolioHoldings, type PortfolioHolding } from "../data/portfolio-data";
import { calculatePortfolio, formatKrw, formatUsd, type CalculatedHolding } from "../lib/portfolio-calculations";
import { stockCategories, createStock, type StockInput } from "../services/stockService";
import { applyMarketPrices, fetchMarketData, searchTicker, type SymbolSearchResult } from "../services/marketData";
import { loadPortfolio, savePortfolio } from "../services/storage";
import { loadCloudPortfolio, saveCloudPortfolio } from "../services/cloudPortfolio";
import { getSupabaseBrowserClient } from "../lib/supabase";
import { addHolding, deleteHolding, exportCsv, importCsv, updateHolding } from "../store/portfolioStore";
import RebalancingTab from "./RebalancingTab";
import MarketMapTab from "./MarketMapTab";
import MarketIndexPulse from "./MarketIndexPulse";
import SettingsTab from "./SettingsTab";

function costReturnPercent(currentPrice: number, averageCost: number) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(averageCost) || averageCost <= 0) return null;
  return (currentPrice / averageCost - 1) * 100;
}


const categoryColors: Record<string, string> = {
  Technology: "#7c3aed", Financial: "#2563eb", Communication: "#f97316", ETF: "#eab308",
  Healthcare: "#ef4444", Industrial: "#64748b", Defense: "#14b8a6", Space: "#475569",
  Energy: "#c2410c", Consumer: "#ec4899", Utilities: "#06b6d4", Materials: "#84cc16",
  "Real Estate": "#a855f7", ETC: "#cbd5e1", Other: "#94a3b8",
};

// Compact labels for the narrow category composition bar. The detail list retains
// full names, so abbreviations must never replace the underlying category data.
const categoryBarLabels: Record<string, string> = {
  Technology: "Tech.", Financial: "Fin.", Communication: "Comm.", ETF: "ETF",
  Healthcare: "Health", Industrial: "Ind.", Defense: "Def.", Space: "Space",
  Energy: "Energy", Consumer: "Cons.", Utilities: "Util.", Materials: "Mat.",
  "Real Estate": "R.E.", RealEstate: "R.E.", ETC: "ETC", Other: "Other",
};
function categoryBarLabel(name: string): string {
  return categoryBarLabels[name] ?? (name.length > 6 ? `${name.slice(0, 4)}.` : name);
}

type SortKey = "allocation" | "ticker" | "valueUsd" | "category";
type ActiveTab = "portfolio" | "rebalancing" | "market-map" | "settings";
type ModalState = { mode: "add" | "edit"; holding?: PortfolioHolding } | null;
type FormErrors = Partial<Record<keyof StockInput | "form", string>>;

function initials(ticker: string) {
  return ticker.slice(0, 2).toUpperCase();
}

function CompanyMark({ ticker, size = 34 }: { ticker: string; size?: number }) {
  const symbol = ticker.trim().toUpperCase();
  const hue = symbol.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360;
  const logoDevToken = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN?.trim();

  const logoSources = useMemo(() => {
    const sources = [`/logos/${symbol.toLowerCase()}.svg`];

    if (logoDevToken) {
      sources.push(`https://img.logo.dev/ticker/${encodeURIComponent(symbol)}?token=${encodeURIComponent(logoDevToken)}&size=128&format=png`);
    }

    // API key 없이도 동작하는 보조 소스. 제공처에서 이미지를 주지 않으면 이니셜로 전환됩니다.
    sources.push(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`);
    return sources;
  }, [symbol, logoDevToken]);

  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [symbol]);

  const hasImageSource = sourceIndex < logoSources.length;

  return (
    <span
      className="company-mark"
      style={{
        width: size,
        height: size,
        background: hasImageSource ? "#ffffff" : `hsl(${hue} 70% 94%)`,
        color: `hsl(${hue} 55% 35%)`,
      }}
      aria-label={`${symbol} logo`}
      title={symbol}
    >
      {hasImageSource ? (
        <img
          key={`${symbol}-${sourceIndex}`}
          src={logoSources[sourceIndex]}
          alt={`${symbol} logo`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setSourceIndex((current) => current + 1)}
        />
      ) : initials(symbol)}
    </span>
  );
}

// Animate only the characters whose displayed value actually changes.
function RollingTotalValue({ value }: { value: string }) {
  const [frame, setFrame] = useState({ previous: value, current: value, sequence: 0 });
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (value === frame.current) return;
    setFrame((last) => ({ previous: last.current, current: value, sequence: last.sequence + 1 }));
    setMoving(true);
    const timer = window.setTimeout(() => setMoving(false), 480);
    return () => window.clearTimeout(timer);
  }, [value]);

  // Compare from the right so inserted/removed leading digits do not animate
  // every unchanged decimal place. Punctuation is always rendered as static text.
  const previousChars = Array.from(frame.previous);
  const currentChars = Array.from(frame.current);
  const offset = currentChars.length - previousChars.length;

  return (
    <strong className="portfolio-rolling-total" aria-label={value}>
      <span className="rolling-total-digits" aria-hidden="true">
        {currentChars.map((char, index) => {
          const previous = previousChars[index - offset];
          const changes = moving && /[0-9]/.test(char) && previous !== char;
          return /[0-9]/.test(char) ? (
            <span className={`rolling-digit-slot${changes ? " is-changing" : ""}`} key={`digit-${index}`}>
              <span className="rolling-digit-old">{changes && /[0-9]/.test(previous ?? "") ? previous : ""}</span>
              <span className="rolling-digit-new">{char}</span>
            </span>
          ) : (
            <span className="rolling-digit-static" key={`static-${index}`}>{char}</span>
          );
        })}
      </span>
    </strong>
  );
}

function SummaryCard({
  label,
  value,
  note,
  icon,
  onIconClick,
}: {
  label: string;
  value: string;
  note: string;
  icon?: string;
  onIconClick?: () => void;
}) {
  return (
    <article className={`summary-card${onIconClick ? " summary-card-clickable" : ""}${!icon ? " summary-card-no-icon" : ""}`}>
      <div className="summary-content">
        <span>{label}</span>
        {label === "TOTAL VALUE" ? <RollingTotalValue value={value} /> : <strong>{value}</strong>}
        <small>{note}</small>
      </div>

      {icon && <div className="summary-icon-slot">
        {onIconClick ? (
          <button
            type="button"
            className="summary-icon-button"
            onClick={onIconClick}
            aria-label={`${label} history`}
            title={`${label} history`}
          >
            {icon}
          </button>
        ) : (
          <i>{icon}</i>
        )}
      </div>}
    </article>
  );
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return { r: 148, g: 163, b: 184 };
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function mixWithWhite(hex: string, amount: number) {
  const { r, g, b } = hexToRgb(hex);
  const ratio = Math.max(0, Math.min(0.72, amount));
  const mix = (channel: number) => Math.round(channel + (255 - channel) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function DonutChart({ holdings }: { holdings: CalculatedHolding[] }) {
  const [allocationView, setAllocationView] = useState<"category" | "stock">("category");
  const chartData = useMemo(() => {
    const vividColors: Record<string, string> = {
      Technology: "#0057FF",
      Financial: "#00A3FF",
      Communication: "#FF6A00",
      ETF: "#FFC400",
      Healthcare: "#FF3158",
      Industrial: "#7C8DA6",
      Defense: "#00C2A8",
      Space: "#6C5CE7",
      Energy: "#FF7A00",
      Consumer: "#E83E8C",
      Utilities: "#00B8D9",
      Materials: "#8BCF00",
      "Real Estate": "#A855F7",
      ETC: "#D0D7E2",
      Other: "#94A3B8",
    };

    const grouped = new Map<string, number>();
    let totalValue = 0;

    holdings.forEach((holding) => {
      const value = Number.isFinite(holding.valueUsd) && holding.valueUsd > 0
        ? holding.valueUsd
        : 0;
      const category = holding.category?.trim() || "Other";
      grouped.set(category, (grouped.get(category) ?? 0) + value);
      totalValue += value;
    });

    let cursor = 0;
    const categories = Array.from(grouped.entries())
      .map(([name, value]) => ({
        name,
        rawValue: value,
        value: totalValue > 0 ? value / totalValue * 100 : 0,
        color: vividColors[name] ?? vividColors.Other,
      }))
      .sort((a, b) => b.rawValue - a.rawValue)
      .map((category) => {
        const start = cursor;
        const end = start + category.value;
        cursor = end;
        return { ...category, start, end };
      });

    const stockColors = ["#0057FF", "#E83E8C", "#00C2A8", "#FF6A00", "#6C5CE7", "#FF3158", "#00A3FF", "#FFC400", "#8BCF00", "#A855F7"];
    const rankedStocks = holdings.filter(h => Number.isFinite(h.valueUsd) && h.valueUsd > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 10);
    let stockCursor = 0;
    const stocks = rankedStocks.map((holding, index) => {
      const start = stockCursor;
      const value = totalValue > 0 ? holding.valueUsd / totalValue * 100 : 0;
      stockCursor += value;
      return { name: holding.ticker, rawValue: holding.valueUsd, value,
        color: stockColors[index], start, end: stockCursor };
    });
    // Stock mode lists only the ten largest holdings. Preserve their true
    // portfolio percentages; any unlisted allocation is a neutral chart segment.
    return { categories, stocks, totalValue };
  }, [holdings]);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const selectedHoldings = useMemo(() => {
    const items = holdings
      .filter((holding) => allocationView === "stock" ? chartData.stocks.slice(0,10).some(s => s.name === holding.ticker) : (selectedCategory ? holding.category === selectedCategory : false))
      .sort((a, b) => b.valueUsd - a.valueUsd);
    const categoryTotal = items.reduce((sum, holding) => sum + Math.max(0, holding.valueUsd), 0) || 1;
    return items.map((holding) => ({
      ...holding,
      categoryAllocation: Math.max(0, holding.valueUsd) / categoryTotal * 100,
    }));
  }, [holdings, selectedCategory, allocationView, chartData.stocks]);

  // Use the same color identity in the donut, detail bar and detail legend.
  // Stock colors are keyed by ticker (not by a separately sorted detail index).
  const detailColorByTicker = new Map(chartData.stocks.map((stock) => [stock.name, stock.color]));
  const selectedCategoryColor = chartData.categories.find((category) => category.name === selectedCategory)?.color ?? "#94A3B8";
  const detailColorFor = (ticker: string) =>
    allocationView === "stock" ? (detailColorByTicker.get(ticker) ?? "#94A3B8") : selectedCategoryColor;

  // Details must follow the currently selected donut mode. Category mode
  // breaks down the entire portfolio by category, never by constituent tickers.
  const detailEntries = allocationView === "category"
    ? chartData.categories.map((category) => ({
        name: category.name,
        subtitle: "",
        percentage: category.value,
        color: category.color,
      }))
    : selectedHoldings.map((holding) => ({
        name: holding.ticker,
        subtitle: holding.companyName,
        percentage: holding.categoryAllocation,
        color: detailColorFor(holding.ticker),
      }));

  const activeAllocation = allocationView === "category" ? chartData.categories : chartData.stocks;
  const gradient = [
    ...activeAllocation.map((item) => `${item.color} ${item.start}% ${item.end}%`),
    ...(allocationView === "stock" && activeAllocation.length > 0 && activeAllocation[activeAllocation.length - 1].end < 99.999
      ? [`#E5E7EB ${activeAllocation[activeAllocation.length - 1].end}% 100%`]
      : []),
  ].join(", ");

  if (!holdings.length) {
    return (
      <section className={`allocation-card card allocation-category-card${panelOpen ? "" : " portfolio-panel-collapsed"}`}>
        <div className="section-heading">
          <div>
            <span>PORTFOLIO ALLOCATION</span>
            <h2>Allocation by<span className={`allocation-category-title-word${panelOpen ? " allocation-category-title-word-expanded" : ""}`}> {allocationView === "category" ? "Category" : "Stock"}</span></h2>
          </div>
          <button type="button" className="portfolio-fold-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}>
            {panelOpen ? "접기 ▲" : "펼쳐보기 ▼"}
          </button>
        </div>
        {panelOpen && <div className="empty-chart">Add a stock to display portfolio allocation.</div>}
      </section>
    );
  }

  return (
    <section className={`allocation-card card allocation-category-card${panelOpen ? "" : " portfolio-panel-collapsed"}${panelOpen && detailsOpen ? " allocation-detail-expanded" : ""}${panelOpen && detailsOpen && allocationView === "stock" ? " allocation-stock-detail" : ""}`}>
      <div className="section-heading">
        <div>
          <span>PORTFOLIO ALLOCATION</span>
          <h2>Allocation by<span className={`allocation-category-title-word${panelOpen ? " allocation-category-title-word-expanded" : ""}`}> {allocationView === "category" ? "Category" : "Stock"}</span></h2>
        </div>
        <div className="allocation-heading-controls">
          <div className="portfolio-fold-actions">
            {panelOpen && <button
              className="ghost-button"
              onClick={() => {
                setDetailsOpen((open) => !open);
              }}
            >{detailsOpen ? "Back to chart" : "View details"}</button>}
            <button type="button" className="portfolio-fold-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}>
              {panelOpen ? "접기 ▲" : "펼쳐보기 ▼"}
            </button>
          </div>
          {panelOpen && <button type="button" className="allocation-view-switch"
            onClick={() => { setAllocationView(view => view === "category" ? "stock" : "category"); setDetailsOpen(false); }}
            aria-label={allocationView === "category" ? "Switch to top 10 stocks" : "Switch to categories"}
            title={allocationView === "category" ? "View top 10 stocks" : "View categories"}>
            {allocationView === "category" ? "종목별" : "카테고리별"}<span aria-hidden="true">⇄</span>
          </button>}
        </div>
      </div>

      {panelOpen && <>
      <div className="category-allocation-layout" style={detailsOpen ? { visibility: "hidden", pointerEvents: "none" } : undefined}>
        <div className="category-donut-zone">
          <div
            className="category-donut"
            style={{ background: `conic-gradient(${gradient})` }}
            aria-label={allocationView === "category" ? "Portfolio category allocation chart" : "Top 10 stock allocation chart"}
          >
            <div className="category-donut-center">
              <span>Total</span>
              <strong>{formatUsd(chartData.totalValue)}</strong>
            </div>
          </div>
        </div>

        <div className="category-allocation-list" aria-label="Category allocation list">
          {activeAllocation.map((category) => (
            <button type="button" className="category-allocation-row" key={category.name} onClick={() => {
                if (allocationView === "stock") { setDetailsOpen(true); return; }
                if (selectedCategory === category.name) {
                  setDetailsOpen((open) => !open);
                } else {
                  setSelectedCategory(category.name);
                  setDetailsOpen(true);
                }
              }}>
              <span className="category-allocation-name">
                <i style={{ background: category.color }} />
                {category.name}
              </span>
              <strong>{category.value.toFixed(2)}%</strong>
            </button>
          ))}
        </div>
      </div>

      
      {detailsOpen && (
        <section className="category-detail-overlay" aria-label={allocationView === "stock" ? "Top 10 stock holdings detail" : "Portfolio category allocation detail"}>
          <div className="category-detail-header">
            <div>
              <span>{allocationView === "stock" ? "TOP 10 HOLDINGS" : "ALL CATEGORIES"}</span>
              <h3>{allocationView === "stock" ? "Stock Composition" : "Category Composition"}</h3>
            </div>
            <button type="button" onClick={() => setDetailsOpen(false)}>Back</button>
          </div>

          <div className="category-detail-body">
            <div className="stacked-bar-wrap">
              <div className="stacked-bar" aria-label={`${allocationView} stacked allocation bar`}>
                {detailEntries.map((entry) => (
                    <div
                      className="stacked-segment"
                      key={entry.name}
                      style={{ height: `${entry.percentage}%`, background: entry.color }}
                      title={`${entry.name} ${entry.percentage.toFixed(2)}%`}
                    >
                      {(allocationView === "stock" ? entry.percentage >= 3 : entry.percentage >= 6) && (
                        <span title={entry.name}>
                          {allocationView === "category"
                            ? categoryBarLabel(entry.name)
                            : entry.name}
                        </span>
                      )}
                    </div>
                ))}
              </div>
            </div>

            <div className="category-detail-list">
              {detailEntries.map((entry) => (
                  <div className="category-detail-row" key={entry.name}>
                    <span className="category-detail-name">
                      <i style={{ background: entry.color }} />
                      <b>{entry.name}</b>
                      {entry.subtitle && <small>{entry.subtitle}</small>}
                    </span>
                    <strong>{entry.percentage.toFixed(2)}%</strong>
                  </div>
              ))}
            </div>
          </div>
        </section>
      )}
      </>}

<style jsx>{`
        .allocation-view-switch { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:30px; border:1px solid #bfc7d1; background:#fff; color:#303846; border-radius:7px; font-size:11px; font-weight:800; padding:0 9px; white-space:nowrap; cursor:pointer; }
        .allocation-view-switch span { font-size:13px; color:#861f41; }
        .allocation-view-switch:hover { border-color:#861f41; }
        @media(max-width:560px) { .allocation-view-switch { padding:0 5px; font-size:10px; height:28px; gap:3px; } }
        .allocation-category-card {
          position: relative;
          display: flex;
          min-width: 0;
          height: 650px;
          flex-direction: column;
          overflow: hidden;
          background: #fff;
        }

        .category-allocation-layout {
          display: grid;
          min-height: 0;
          flex: 1;
          grid-template-columns: minmax(300px, 1.08fr) minmax(220px, .92fr);
          align-items: center;
          gap: 28px;
          padding: 30px 34px 34px;
        }

        .category-donut-zone {
          display: grid;
          min-width: 0;
          place-items: center;
        }

        .category-donut {
          position: relative;
          width: min(100%, 390px);
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          box-shadow:
            0 20px 45px rgba(75, 16, 38, .13),
            inset 0 0 0 2px rgba(255, 255, 255, .85);
        }

        .category-donut::after {
          content: "";
          position: absolute;
          inset: 26%;
          border-radius: 50%;
          background: #fff;
          box-shadow:
            0 0 0 1px rgba(134, 31, 65, .10),
            0 10px 24px rgba(75, 16, 38, .08);
        }

        .category-donut-center {
          position: absolute;
          inset: 29%;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          border-radius: 50%;
          text-align: center;
        }

        .category-donut-center span {
          color: #303846;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: .03em;
        }

        .category-donut-center strong {
          margin-top: 8px;
          color: #210a13;
          font-size: clamp(19px, 2vw, 27px);
          font-weight: 950;
          letter-spacing: -.04em;
          white-space: nowrap;
        }

        .category-allocation-list {
          display: flex;
          min-width: 0;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
        }

        .category-allocation-row {
          display: flex;
          min-height: 42px;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          padding: 0 2px;
          border-bottom: 1px solid rgba(134, 31, 65, .09);
        }

        .category-allocation-row:last-child {
          border-bottom: 0;
        }

        .category-allocation-name {
          display: flex;
          min-width: 0;
          align-items: center;
          gap: 11px;
          overflow: hidden;
          color: #344054;
          font-size: 12px;
          font-weight: 750;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .category-allocation-name i {
          width: 11px;
          height: 11px;
          flex: 0 0 11px;
          border-radius: 50%;
          box-shadow: 0 0 0 4px rgba(134, 31, 65, .035);
        }

        .category-allocation-row strong {
          color: #210a13;
          font-size: 12px;
          font-weight: 900;
          white-space: nowrap;
        }


        .category-detail-overlay {
          position: absolute;
          inset: 76px 16px 16px;
          z-index: 20;
          display: flex;
          min-height: 0;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(134,31,65,.14);
          border-radius: 18px;
          background: rgba(255,255,255,.98);
          box-shadow: 0 18px 44px rgba(75,16,38,.16);
          backdrop-filter: blur(10px);
        }

        .category-detail-header {
          display: flex;
          min-height: 64px;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 18px;
          border-bottom: 1px solid #edf0f4;
        }

        .category-detail-header span {
          color: #861f41;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: .12em;
        }

        .category-detail-header h3 {
          margin: 4px 0 0;
          color: #210a13;
          font-size: 17px;
          font-weight: 950;
        }

        .category-detail-header button {
          border: 1px solid rgba(134,31,65,.16);
          border-radius: 10px;
          padding: 8px 12px;
          background: #fff7ed;
          color: #861f41;
          font-size: 10px;
          font-weight: 900;
          cursor: pointer;
        }

        .category-detail-body {
          display: grid;
          min-height: 0;
          flex: 1;
          grid-template-columns: 118px minmax(0,1fr);
          gap: 22px;
          padding: 18px;
          overflow: hidden;
        }

        .stacked-bar-wrap {
          display: flex;
          min-height: 0;
          align-items: stretch;
          justify-content: center;
        }

        .stacked-bar {
          display: flex;
          width: 68px;
          min-height: 100%;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(15,23,42,.10);
          border-radius: 18px;
          background: #f1f5f9;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.7);
        }

        .stacked-segment {
          display: grid;
          min-height: 3px;
          place-items: center;
          border-top: 1px solid rgba(255,255,255,.85);
          color: #fff;
          font-size: 9px;
          font-weight: 950;
          text-shadow: 0 1px 3px rgba(15,23,42,.45);
        }

        .stacked-segment span {
          display: block;
          max-width: calc(100% - 4px);
          overflow: hidden;
          white-space: nowrap;
          text-overflow: clip;
          font-size: 8px;
          line-height: 1.2;
          text-align: center;
        }

        .category-detail-list {
          min-width: 0;
          overflow-y: auto;
          padding-right: 4px;
        }

        .category-detail-row {
          display: flex;
          min-height: 44px;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          border-bottom: 1px solid #edf0f4;
        }

        .category-detail-row:last-child {
          border-bottom: 0;
        }

        .category-detail-name {
          display: grid;
          min-width: 0;
          grid-template-columns: 10px 58px minmax(0,1fr);
          align-items: center;
          gap: 9px;
        }

        .category-detail-name i {
          width: 10px;
          height: 10px;
          border-radius: 3px;
        }

        .category-detail-name b {
          color: #210a13;
          font-size: 12px;
          font-weight: 950;
        }

        .category-detail-name small {
          overflow: hidden;
          color: #303846;
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .category-detail-row strong {
          color: #4b1026;
          font-size: 12px;
          font-weight: 950;
          white-space: nowrap;
        }

        .category-allocation-row {
          background: none;
          border-left: 0;
          border-right: 0;
          border-top: 0;
          width: 100%;
          cursor: pointer;
        }

        .category-allocation-row:hover {
          background: #f8fafc;
          border-radius: 8px;
        }

        @media (max-width: 1180px) {
          .category-allocation-layout {
            grid-template-columns: minmax(280px, 1fr) minmax(210px, .8fr);
            gap: 20px;
            padding: 26px 24px 30px;
          }

          .category-donut {
            width: min(100%, 360px);
          }
        }

        @media (max-width: 760px) {
          .category-detail-overlay {
            inset: 70px 10px 10px;
          }

          .category-detail-body {
            grid-template-columns: 84px minmax(0,1fr);
            gap: 12px;
            padding: 14px;
          }

          .stacked-bar {
            width: 52px;
          }

          .category-detail-name {
            grid-template-columns: 9px 48px minmax(0,1fr);
            gap: 7px;
          }

          .allocation-category-card {
            height: auto;
            min-height: 620px;
          }

          .category-allocation-layout {
            grid-template-columns: 1fr;
            gap: 18px;
            padding: 22px 18px 26px;
          }

          .category-donut {
            width: min(82vw, 350px);
          }

          .category-allocation-list {
            width: 100%;
          }

          .category-allocation-row {
            min-height: 38px;
          }
        }
      

`}</style>
    </section>
  );
}

function TopHoldings({ holdings }: { holdings: CalculatedHolding[] }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const topFive = useMemo(
    () => [...holdings].sort((a, b) => b.allocation - a.allocation).slice(0, 5),
    [holdings],
  );

  return (
    <section className={`top-holdings-card card${panelOpen ? "" : " portfolio-panel-collapsed"}`}>
      <div className="section-heading top-holdings-heading">
        <div>
          <span>PORTFOLIO LEADERS</span>
          <h2>Top Holdings</h2>
        </div>
        <button type="button" className="portfolio-fold-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}>
          {panelOpen ? "접기 ▲" : "펼쳐보기 ▼"}
        </button>
      </div>

      {panelOpen && <>
      <div className="top-holdings-columns" aria-hidden="true">
        <span>Position</span>
        <span>Holding</span>
        <span>Value</span>
        <span>Avg Cost / P&amp;L</span>
        <span>Weight</span>
        <span>Shares</span>
      </div>

      <div className="top-holdings-list">
        {topFive.map((holding, index) => (
          <article className="top-holding-row" key={holding.ticker}>
            <div className="top-holding-position">
              <span>{index + 1}</span>
              <div className="top-holding-logo">
                <CompanyMark ticker={holding.ticker} size={46} />
              </div>
            </div>

            <div className="top-holding-identity">
              <strong>{holding.ticker}</strong>
              <span>{holding.companyName}</span>
            </div>

            <div className="top-holding-stat value">
              <span>Total value</span>
              <strong>{formatUsd(holding.valueUsd)}</strong>
            </div>

            <div className="top-holding-stat cost">
              <span>Average Cost</span>
              <strong>{holding.averageCost > 0 ? formatUsd(holding.averageCost) : "—"}</strong>
              {(() => {
                const costReturn = costReturnPercent(holding.currentPrice, holding.averageCost);
                return (
                  <small className={costReturn === null ? "cost-return neutral" : costReturn >= 0 ? "cost-return up" : "cost-return down"}>
                    {costReturn === null ? "No cost basis" : `${costReturn >= 0 ? "+" : ""}${costReturn.toFixed(2)}%`}
                  </small>
                );
              })()}
            </div>

            <div className="top-holding-stat top-holding-return">
              <span>P/L</span>
              {(() => {
                const percentage = costReturnPercent(holding.currentPrice, holding.averageCost);
                return <strong className={percentage === null ? "neutral" : percentage >= 0 ? "up" : "down"}>
                  {percentage === null ? "—" : `${percentage >= 0 ? "+" : ""}${percentage.toFixed(2)}%`}
                </strong>;
              })()}
            </div>

            <div className="top-holding-stat allocation">
              <span>Allocation</span>
              <strong>{holding.allocation.toFixed(2)}%</strong>
              <i><b style={{ width: `${Math.max(0, Math.min(100, holding.allocation))}%` }} /></i>
            </div>

            <div className="top-holding-stat shares">
              <span>Shares</span>
              <strong>{holding.shares.toLocaleString(undefined, { maximumFractionDigits: 3 })}</strong>
            </div>
          </article>
        ))}

        {!topFive.length && (
          <div className="top-holdings-empty">Add holdings to display the top five positions.</div>
        )}
      </div>
      </>}
    </section>
  );
}


type PortfolioHistoryPoint = {
  date: string;
  totalKrw: number;
  changeKrw: number;
  changePercent: number;
};

function createPreviewHistory(currentTotalKrw: number): PortfolioHistoryPoint[] {
  const start = new Date("2026-07-23T00:00:00");
  const end = new Date();
  const dailyRates = [
    0.0042, -0.0061, 0.0034, 0.0078, -0.0027,
    0.0056, -0.0082, 0.0091, 0.0028, -0.0044,
    0.0067, 0.0019, -0.0053, 0.0084, -0.0031,
  ];

  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!dates.length || !currentTotalKrw) return [];

  const multipliers: number[] = [1];
  for (let index = 1; index < dates.length; index += 1) {
    multipliers.push(multipliers[index - 1] * (1 + dailyRates[(index - 1) % dailyRates.length]));
  }

  const finalMultiplier = multipliers[multipliers.length - 1] || 1;
  const startingValue = currentTotalKrw / finalMultiplier;

  return dates.map((historyDate, index) => {
    const totalKrw = startingValue * multipliers[index];
    const previousTotal = index === 0 ? totalKrw : startingValue * multipliers[index - 1];
    const changeKrw = index === 0 ? 0 : totalKrw - previousTotal;
    const changePercent = previousTotal ? changeKrw / previousTotal * 100 : 0;
    return { date: historyDate, totalKrw, changeKrw, changePercent };
  });
}

function TotalChangeHistoryModal({
  points,
  onClose,
}: {
  points: PortfolioHistoryPoint[];
  onClose: () => void;
}) {
  const width = 760;
  const height = 300;
  const padding = { top: 28, right: 24, bottom: 42, left: 72 };
  const values = points.map((point) => point.changeKrw);
  const maxAbs = Math.max(1, ...values.map((value) => Math.abs(value)));
  const minY = -maxAbs;
  const maxY = maxAbs;
  const xFor = (index: number) =>
    padding.left + (points.length <= 1 ? 0 : index / (points.length - 1) * (width - padding.left - padding.right));
  const yFor = (value: number) =>
    padding.top + (maxY - value) / (maxY - minY) * (height - padding.top - padding.bottom);
  const path = points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)} ${yFor(point.changeKrw).toFixed(2)}`
  ).join(" ");
  const zeroY = yFor(0);

  return (
    <div className="change-history-backdrop" onMouseDown={onClose}>
      <section className="change-history-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="change-history-header">
          <div>
            <span>DAILY CLOSE HISTORY · PREVIEW FROM 2026-07-23</span>
            <h2>Total Change</h2>
            <p>Preview history begins on July 23, 2026. New dates continue from saved daily snapshots.</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>

        {points.length >= 2 ? (
          <>
            <div className="change-chart-wrap">
              <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily portfolio change line chart">
                <defs>
                  <linearGradient id="changeAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#861f41" stopOpacity=".20" />
                    <stop offset="100%" stopColor="#861f41" stopOpacity="0" />
                  </linearGradient>
                </defs>

                <line x1={padding.left} x2={width - padding.right} y1={zeroY} y2={zeroY} className="change-zero-line" />
                <text x={padding.left - 10} y={padding.top + 4} textAnchor="end" className="change-axis-label">{formatKrw(maxY)}</text>
                <text x={padding.left - 10} y={zeroY + 4} textAnchor="end" className="change-axis-label">₩0</text>
                <text x={padding.left - 10} y={height - padding.bottom + 4} textAnchor="end" className="change-axis-label">{formatKrw(minY)}</text>

                <path
                  d={`${path} L ${xFor(points.length - 1)} ${zeroY} L ${xFor(0)} ${zeroY} Z`}
                  className="change-area"
                />
                <path d={path} className="change-line" />

                {points.map((point, index) => (
                  <g key={point.date}>
                    <circle
                      cx={xFor(index)}
                      cy={yFor(point.changeKrw)}
                      r="4.5"
                      className={point.changeKrw >= 0 ? "change-point positive" : "change-point negative"}
                    />
                    {(index === 0 || index === points.length - 1 || index % Math.max(1, Math.floor(points.length / 5)) === 0) && (
                      <text
                        x={xFor(index)}
                        y={height - 14}
                        textAnchor="middle"
                        className="change-date-label"
                      >
                        {point.date.slice(5)}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            </div>

            <div className="change-history-list">
              {[...points].reverse().slice(0, 10).map((point) => (
                <div className="change-history-row" key={point.date}>
                  <span>{point.date}</span>
                  <strong className={point.changeKrw >= 0 ? "positive" : "negative"}>
                    {point.changeKrw >= 0 ? "+" : ""}{formatKrw(point.changeKrw)}
                  </strong>
                  <small className={point.changePercent >= 0 ? "positive" : "negative"}>
                    {point.changePercent >= 0 ? "+" : ""}{point.changePercent.toFixed(2)}%
                  </small>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="change-history-empty">
            <strong>History starts after two daily snapshots.</strong>
            <span>Keep using the app and the chart will build automatically day by day.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Modal({
  state,
  existingTickers,
  exchangeRate,
  onClose,
  onSave,
}: {
  state: ModalState;
  existingTickers: string[];
  exchangeRate: number;
  onClose: () => void;
  onSave: (input: StockInput) => void;
}) {
  const holding = state?.holding;
  const [form, setForm] = useState<StockInput>({
    ticker: holding?.ticker ?? "",
    companyName: holding?.companyName ?? "",
    category: holding?.category ?? "Technology",
    shares: holding?.shares ?? 0,
    averageCost: holding?.averageCost ? Math.round(holding.averageCost * exchangeRate) : 0,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [verifiedTicker, setVerifiedTicker] = useState(holding?.ticker ?? "");

  useEffect(() => {
    setForm({
      ticker: holding?.ticker ?? "",
      companyName: holding?.companyName ?? "",
      category: holding?.category ?? "Technology",
      shares: holding?.shares ?? 0,
      averageCost: holding?.averageCost ? Math.round(holding.averageCost * exchangeRate) : 0,
    });
    setErrors({});
    setResults([]);
    setVerifiedTicker(holding?.ticker ?? "");
  }, [holding, state?.mode, exchangeRate]);

  useEffect(() => {
    if (!state || state.mode !== "add") return;
    const query = form.ticker.trim().toUpperCase();
    setVerifiedTicker((current) => current === query ? current : "");

    if (query.length < 1) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      try {
        const matches = await searchTicker(query);
        if (!cancelled) setResults(matches);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [form.ticker, state]);

  if (!state) return null;

  const set = (key: keyof StockInput, value: string) => {
    setForm((current) => ({
      ...current,
      [key]: key === "shares" || key === "averageCost" ? Number(value) : value,
    }));
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
  };

  const selectSymbol = (result: SymbolSearchResult) => {
    setForm((current) => ({
      ...current,
      ticker: result.symbol,
      companyName: result.companyName,
      category: result.quoteType?.toUpperCase() === "ETF" ? "ETF" : current.category,
    }));
    setVerifiedTicker(result.symbol);
    setResults([]);
    setErrors((current) => ({ ...current, ticker: undefined, companyName: undefined, form: undefined }));
  };

  const validateBase = () => {
    const next: FormErrors = {};
    const ticker = form.ticker.trim().toUpperCase();

    if (!ticker) next.ticker = "Ticker is required.";
    else if (!/^[A-Z0-9.^=-]{1,15}$/.test(ticker)) next.ticker = "Use a valid ticker symbol.";
    else if (state.mode === "add" && existingTickers.includes(ticker)) next.ticker = "This ticker already exists.";

    if (!stockCategories.some((category) => category === form.category)) next.category = "Select a valid category.";
    if (!Number.isFinite(form.shares) || form.shares < 0) next.shares = "Shares must be zero or greater.";
    if (!Number.isFinite(form.averageCost) || form.averageCost < 0) next.averageCost = "Average cost (KRW) must be zero or greater.";

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validateBase()) return;

    const ticker = form.ticker.trim().toUpperCase();
    let companyName = form.companyName.trim();

    if (state.mode === "add" && verifiedTicker !== ticker) {
      setIsSearching(true);
      try {
        const matches = await searchTicker(ticker);
        const exact = matches.find((item) => item.symbol === ticker);
        if (!exact) {
          setErrors((current) => ({ ...current, ticker: "Ticker not found. Select a result from the search list." }));
          return;
        }
        companyName = companyName || exact.companyName;
        setVerifiedTicker(ticker);
      } catch {
        setErrors((current) => ({ ...current, form: "Ticker lookup failed. Try again." }));
        return;
      } finally {
        setIsSearching(false);
      }
    }

    onSave({
      ...form,
      ticker,
      companyName: companyName || ticker,
      shares: Number(form.shares),
      // The modal accepts average cost in KRW, while the portfolio data model
      // continues to store USD so all existing valuation/P&L logic stays intact.
      averageCost: exchangeRate > 0 ? Number(form.averageCost) / exchangeRate : 0,
    });
  };

  return <div className="modal-backdrop" onMouseDown={onClose}><form className="stock-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()} noValidate>
    <div className="modal-title"><div><span>{state.mode === "add" ? "NEW POSITION" : "EDIT POSITION"}</span><h2>{state.mode === "add" ? "Add stock" : form.ticker}</h2></div><button type="button" onClick={onClose}>×</button></div>
    <label className="ticker-search-label">Ticker
      <div className="ticker-search-box">
        <input autoFocus disabled={state.mode === "edit"} value={form.ticker} onChange={(e) => set("ticker", e.target.value.toUpperCase())} placeholder="e.g. TSLL" autoComplete="off" aria-invalid={Boolean(errors.ticker)} />
        {state.mode === "add" && <span className={`ticker-search-status ${verifiedTicker === form.ticker.trim().toUpperCase() ? "verified" : ""}`}>{isSearching ? "Searching…" : verifiedTicker === form.ticker.trim().toUpperCase() && verifiedTicker ? "Found" : "Search"}</span>}
        {state.mode === "add" && form.ticker.trim() && (results.length > 0 || (!isSearching && !verifiedTicker)) && <div className="ticker-results">
          {results.map((result) => <button key={result.symbol} type="button" onClick={() => selectSymbol(result)}>
            <strong>{result.symbol}</strong><span>{result.companyName}</span><small>{[result.exchange, result.quoteType].filter(Boolean).join(" · ")}</small>
          </button>)}
          {!isSearching && results.length === 0 && <p>No matching ticker found.</p>}
        </div>}
      </div>
      {errors.ticker && <small role="alert">{errors.ticker}</small>}
    </label>
    <label>Company name <em>(automatic)</em><input value={form.companyName} onChange={(e) => set("companyName", e.target.value)} placeholder="Filled after ticker selection" aria-invalid={Boolean(errors.companyName)} />{errors.companyName && <small role="alert">{errors.companyName}</small>}</label>
    <label>Category<select value={form.category} onChange={(e) => set("category", e.target.value)} aria-invalid={Boolean(errors.category)}>{stockCategories.map((c) => <option key={c}>{c}</option>)}</select>{errors.category && <small role="alert">{errors.category}</small>}</label>
    <div className="modal-grid"><label>Shares<input type="number" min="0" step="0.001" value={Number.isFinite(form.shares) ? form.shares : ""} onChange={(e) => set("shares", e.target.value)} aria-invalid={Boolean(errors.shares)} />{errors.shares && <small role="alert">{errors.shares}</small>}</label><label>Average cost <em>(KRW)</em>
      <div className="krw-cost-input">
        <span>₩</span>
        <input type="number" min="0" step="1" inputMode="numeric" value={Number.isFinite(form.averageCost) ? form.averageCost : ""} onChange={(e) => set("averageCost", e.target.value)} aria-invalid={Boolean(errors.averageCost)} />
      </div>
      <small className="cost-conversion-preview">
        {Number.isFinite(form.averageCost) && form.averageCost > 0 && exchangeRate > 0
          ? `Saved as ${formatUsd(form.averageCost / exchangeRate)} at ₩${exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}/USD`
          : `Enter your average cost in Korean won`}
      </small>
      {errors.averageCost && <small role="alert">{errors.averageCost}</small>}
    </label></div>
    {errors.form && <p role="alert">{errors.form}</p>}
    <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={isSearching}>{isSearching ? "Checking…" : state.mode === "add" ? "Add to portfolio" : "Save changes"}</button></div>
  </form></div>;
}
function previousNyTradingSession(now: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const nyDate = `${parts.year}-${parts.month}-${parts.day}`;
  // Calendar dates use UTC arithmetic; the clock hour is read in New York time.
  const date = new Date(`${nyDate}T12:00:00Z`);
  if (Number(parts.hour) < 16 || ["Sat", "Sun"].includes(parts.weekday)) date.setUTCDate(date.getUTCDate() - 1);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// Format the 16:00 New York regular-session close in Korean local time.
// 20:00 UTC during US daylight saving, 21:00 UTC otherwise.
function formatPreviousMarketCloseKst(session: string): string {
  const daylightCandidate = new Date(`${session}T20:00:00Z`);
  const nyHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
  }).format(daylightCandidate);
  const close = nyHour === "16" ? daylightCandidate : new Date(`${session}T21:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(close).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  return `${parts.year}.${parts.month}.${parts.day} ${hour < 12 ? "오전" : "오후"} ${hour % 12 || 12}:${parts.minute}:${parts.second} 기준 (KST)`;
}

export default function Dashboard({ user }: { user: User }) {
  // Keep the +/- Market Pulse duration readout legible regardless of the
  // time-selector component's wrapper/classes. The label is visually above Pulse.
  useEffect(() => {
    const updateDurationLabel = () => {
      const pulse = document.querySelector<HTMLElement>(".portfolio-index-pulse");
      if (!pulse) return;
      const pulseRect = pulse.getBoundingClientRect();
      const elements = document.querySelectorAll<HTMLElement>("span, output, strong, label, div, button");
      elements.forEach((element) => {
        if (element.closest(".portfolio-index-pulse")) return;
        const ownText = Array.from(element.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent ?? "").join("").trim();
        if (!/^(?:\d+\s*(?:분|시간|초|m|min|h|hr)|\d{1,2}:\d{2})$/i.test(ownText)) return;
        const rect = element.getBoundingClientRect();
        // Only the time control directly above the chart; not arbitrary timestamps elsewhere.
        if (rect.width === 0 || rect.height === 0 || rect.bottom < pulseRect.top - 260 || rect.top > pulseRect.top + 8) return;
        element.style.setProperty("color", "#303846", "important");
        element.style.setProperty("font-weight", "800", "important");
        element.classList.add("market-pulse-duration-value");
      });
    };
    updateDurationLabel();
    const timer = window.setInterval(updateDurationLabel, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [rawHoldings, setRawHoldings] = useState<PortfolioHolding[]>(portfolioHoldings);
  // Preserve the user's raw input while editing; "" must not become 0 mid-keystroke.
  const [sharesDrafts, setSharesDrafts] = useState<Record<string, string>>({});
  // Match the working Rebalancing input fix: prevent iOS focus-triggered page zoom.
  const sharesViewportRef = useRef<{ element: HTMLMetaElement; content: string; created: boolean } | null>(null);
  const lockSharesViewport = () => {
    if (typeof document === "undefined" || sharesViewportRef.current) return;
    let element = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const created = !element;
    if (!element) {
      element = document.createElement("meta");
      element.name = "viewport";
      document.head.appendChild(element);
    }
    sharesViewportRef.current = { element, content: element.content, created };
    const parts = element.content.split(",").map((part) => part.trim()).filter(Boolean)
      .filter((part) => !/^(maximum-scale|user-scalable)\s*=/i.test(part));
    if (!parts.some((part) => /^width\s*=/i.test(part))) parts.unshift("width=device-width");
    if (!parts.some((part) => /^initial-scale\s*=/i.test(part))) parts.push("initial-scale=1");
    parts.push("maximum-scale=1", "user-scalable=no");
    element.content = parts.join(", ");
  };
  const unlockSharesViewport = () => {
    const saved = sharesViewportRef.current;
    if (!saved) return;
    if (saved.created) saved.element.remove();
    else saved.element.content = saved.content;
    sharesViewportRef.current = null;
  };
  useEffect(() => () => {
    const saved = sharesViewportRef.current;
    if (!saved) return;
    if (saved.created) saved.element.remove();
    else saved.element.content = saved.content;
    sharesViewportRef.current = null;
  }, []);

  const [activeTab, setActiveTab] = useState<ActiveTab>("portfolio");
  // Keep the viewport stable for the entire Portfolio tab session on phones.
  // Locking only on touch/focus and restoring on blur intermittently races with
  // Safari's keyboard animation and can trigger page-level input auto-zoom.
  // Restore the original viewport as soon as the user leaves this tab.
  useLayoutEffect(() => {
    if (activeTab !== "portfolio" || !window.matchMedia("(max-width: 760px)").matches) {
      unlockSharesViewport();
      return;
    }
    lockSharesViewport();
    return () => unlockSharesViewport();
  }, [activeTab]);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("allocation");
  const [modal, setModal] = useState<ModalState>(null);
  const [liveExchangeRate, setLiveExchangeRate] = useState(fallbackExchangeRate);
  const [marketStatus, setMarketStatus] = useState<"loading" | "live" | "fallback" | "error">("loading");
  const [lastUpdated, setLastUpdated] = useState("Not refreshed yet");
  const [isHydrated, setIsHydrated] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"loading" | "saved" | "saving" | "error">("loading");
  const [changeHistoryOpen, setChangeHistoryOpen] = useState(false);
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioHistoryPoint[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Touch slider preview follows the finger continuously; selection commits on release.
  const bottomTabDrag = useRef<{ x: number; y: number; pointerId: number; moved: boolean } | null>(null);
  const suppressBottomTabClick = useRef(false);
  const [bottomTabSlide, setBottomTabSlide] = useState<number | null>(null);
  const bottomTabNames: ActiveTab[] = ["portfolio", "rebalancing", "market-map", "settings"];
  const getBottomTabPosition = (nav: HTMLElement, clientX: number) => {
    const bounds = nav.getBoundingClientRect();
    const styles = window.getComputedStyle(nav);
    const insetLeft = parseFloat(styles.paddingLeft) || 0;
    const insetRight = parseFloat(styles.paddingRight) || 0;
    const usableWidth = Math.max(1, bounds.width - insetLeft - insetRight);
    return Math.max(0, Math.min(3, ((clientX - bounds.left - insetLeft) / usableWidth) * 4 - 0.5));
  };
  const finishBottomTabDrag = (event: React.PointerEvent<HTMLElement>) => {
    const started = bottomTabDrag.current;
    if (!started || event.pointerId !== started.pointerId) return;
    bottomTabDrag.current = null;
    const target = Math.round(getBottomTabPosition(event.currentTarget, event.clientX));
    // Pointer capture keeps the gesture continuous, even across button boundaries.
    // Commit both taps and drags here because captured taps may not click the child button.
    setActiveTab(bottomTabNames[target]);
    if (started.moved) suppressBottomTabClick.current = true;
    setBottomTabSlide(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      setSyncStatus("loading");
      const local = loadPortfolio();
      try {
        const cloud = await loadCloudPortfolio(user.id);
        if (cancelled) return;
        if (cloud) setRawHoldings(cloud);
        else {
          const initial = local ?? portfolioHoldings;
          setRawHoldings(initial);
          await saveCloudPortfolio(user.id, initial);
        }
        setSyncStatus("saved");
      } catch {
        if (!cancelled) { setRawHoldings(local ?? portfolioHoldings); setSyncStatus("error"); }
      } finally { if (!cancelled) setIsHydrated(true); }
    };
    hydrate();
    return () => { cancelled = true; };
  }, [user.id]);

  // Prices update every second, but only user-edited holdings should initiate cloud saves.
  // Quote fields are intentionally excluded from this persistence dependency.
  const portfolioPersistenceKey = JSON.stringify(rawHoldings.map(({ currentPrice, dailyChangePercent, ...holding }) => holding));

  useEffect(() => {
    if (!isHydrated) return;
    savePortfolio(rawHoldings);
    setSyncStatus("saving");
    const timer = window.setTimeout(async () => {
      try { await saveCloudPortfolio(user.id, rawHoldings); setSyncStatus("saved"); }
      catch { setSyncStatus("error"); }
    }, 700);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioPersistenceKey, isHydrated, user.id]);

  const [previousCloseQuotes, setPreviousCloseQuotes] = useState<Record<string, { currentPrice: number; previousClose: number }>>({});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const data = await fetchMarketData(rawHoldings.map((holding) => holding.ticker));
        if (cancelled) return;
        if (Object.keys(data.prices).length) {
          setRawHoldings((current) => applyMarketPrices(current, data.prices));
          setPreviousCloseQuotes((prior) => {
            const next = { ...prior };
            for (const [ticker, q] of Object.entries(data.prices)) {
              if (typeof q.previousClose === "number" && Number.isFinite(q.previousClose) && q.previousClose > 0 &&
                  Number.isFinite(q.currentPrice) && q.currentPrice > 0) {
                next[ticker] = { currentPrice: q.currentPrice, previousClose: q.previousClose };
              }
            }
            return next;
          });
        }
        if (data.exchangeRate) setLiveExchangeRate(data.exchangeRate);
        setLastUpdated(new Date(data.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        setMarketStatus(data.source.stocks !== "fallback" || data.source.fx !== "fallback" ? "live" : "fallback");
      } catch {
        if (!cancelled) setMarketStatus("error");
      } finally {
        inFlight = false;
      }
    };
    refresh();
    // Requests every second while this browser tab is visible. Provider/API caches
    // and upstream quote frequency may make the actual data less frequent.
    const timer = window.setInterval(refresh, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [rawHoldings.map((holding) => holding.ticker).join(",")]);

  // A completed NY regular session is the immutable comparison anchor.
  // NY timezone logic handles the US daylight-saving change (16:00 NY = 05:00/06:00 KST).
  const [closeSession, setCloseSession] = useState(() => previousNyTradingSession(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => {
      const session = previousNyTradingSession(new Date());
      setCloseSession(current => current === session ? current : session);
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const positionsKey = useMemo(() => JSON.stringify(rawHoldings
    .filter(h => Number.isFinite(h.shares) && h.shares > 0)
    .map(h => [h.ticker.trim().toUpperCase(), h.shares]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))), [rawHoldings]);
  const [frozenClose, setFrozenClose] = useState<{ key: string; previousUsd: number; closeFx: number } | null>(null);
  const closeKey = `${user.id}:${closeSession}:${positionsKey}`;
  useEffect(() => {
    setFrozenClose(current => current?.key === closeKey ? current : null);
    if (!isHydrated || positionsKey === "[]") return;
    if (frozenClose?.key === closeKey) return;
    const storageKey = `portfolio-ny-close-v1:${closeKey}`;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.key === closeKey && parsed.previousUsd > 0 && parsed.closeFx > 0) {
          setFrozenClose(parsed);
          return;
        }
      }
    } catch { /* Invalid snapshot should never be used. */ }
    // An exact NY-close FX sample is required. Do not substitute the live exchange rate.
    let cancelled = false;
    let pending = false;
    const capture = async () => {
      if (pending || cancelled) return;
      const positions = rawHoldings.filter(h => Number.isFinite(h.shares) && h.shares > 0);
      if (!positions.length) return;
      let previousUsd = 0;
      for (const h of positions) {
        const q = previousCloseQuotes[h.ticker.trim().toUpperCase()];
        if (!q || !Number.isFinite(q.previousClose) || q.previousClose <= 0) return;
        previousUsd += h.shares * q.previousClose;
      }
      pending = true;
      try {
        const response = await fetch(`/api/market-close-fx?session=${encodeURIComponent(closeSession)}`, { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { rate?: number };
        if (cancelled || !Number.isFinite(result.rate) || !(result.rate! > 0)) return;
        const snapshot = { key: closeKey, previousUsd, closeFx: result.rate! };
        try { localStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch { /* in-memory only */ }
        setFrozenClose(snapshot);
      } catch { /* Retry; never invent a closing FX quote. */ }
      finally { pending = false; }
    };
    void capture();
    const timer = window.setInterval(capture, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeKey, closeSession, isHydrated, previousCloseQuotes, frozenClose]);

  const portfolio = useMemo(() => calculatePortfolio(rawHoldings, liveExchangeRate), [rawHoldings, liveExchangeRate]);
  const investedUsd = rawHoldings.reduce((sum, h) => sum + h.shares * h.averageCost, 0);
  const gain = portfolio.totalUsd - investedUsd;
  const gainPct = investedUsd ? gain / investedUsd * 100 : 0;
  // The reference KRW asset value is frozen at the previous regular-session close.
  // Only the current asset value moves between regular-session closes.
  const previousCloseSummary = frozenClose?.key === closeKey ? {
    previousUsd: frozenClose.previousUsd,
    previousKrw: frozenClose.previousUsd * frozenClose.closeFx,
  } : null;
  const dayChangeKrw = previousCloseSummary ? portfolio.totalKrw - previousCloseSummary.previousKrw : null;
  const dayChange = dayChangeKrw ?? 0;

  const [showTotalReturnDetail, setShowTotalReturnDetail] = useState(false);
  const [showPreviousClose, setShowPreviousClose] = useState(false);
  const [previousClosePosition, setPreviousClosePosition] = useState({ top: 70, left: 12 });
  const [totalReturnPosition, setTotalReturnPosition] = useState({ top: 70, left: 12 });
  // Both detail popovers use the same viewport-relative anchor and overflow handling.
  const getSummaryPopoverPosition = (button: HTMLButtonElement) => {
    const r = button.getBoundingClientRect();
    return {
      top: r.bottom + 9 + 145 > window.innerHeight ? Math.max(8, r.top - 145) : r.bottom + 9,
      left: Math.max(8, Math.min(r.left - 75, window.innerWidth - 260)),
    };
  };

  // Aggregate unrealized return from positions that have an entered average cost.
  const costBasisSummary = useMemo(() => {
    const covered = portfolio.holdings.filter(
      (holding) =>
        Number.isFinite(holding.averageCost) &&
        holding.averageCost > 0 &&
        Number.isFinite(holding.shares) &&
        holding.shares > 0,
    );

    const totalCostUsd = covered.reduce(
      (sum, holding) => sum + holding.averageCost * holding.shares,
      0,
    );
    const currentValueUsd = covered.reduce(
      (sum, holding) => sum + holding.currentPrice * holding.shares,
      0,
    );
    const profitUsd = currentValueUsd - totalCostUsd;
    const returnPercent =
      totalCostUsd > 0 ? (profitUsd / totalCostUsd) * 100 : null;

    return {
      profitUsd,
      profitKrw: profitUsd * liveExchangeRate,
      returnPercent,
    };
  }, [portfolio.holdings, liveExchangeRate]);

  useEffect(() => {
    if (!isHydrated || !portfolio.totalKrw) return;

    const storageKey = `sap-portfolio-close-history-${user.id}`;
    const today = new Date().toLocaleDateString("en-CA");
    let existing: PortfolioHistoryPoint[] = [];

    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }

    if (!existing.length) {
      existing = createPreviewHistory(portfolio.totalKrw);
    }

    const previous = [...existing].reverse().find((point) => point.date !== today);
    const changeKrw = previous ? portfolio.totalKrw - previous.totalKrw : 0;
    const changePercent = previous?.totalKrw
      ? changeKrw / previous.totalKrw * 100
      : 0;

    const todayPoint: PortfolioHistoryPoint = {
      date: today,
      totalKrw: portfolio.totalKrw,
      changeKrw,
      changePercent,
    };

    const next = [
      ...existing.filter((point) => point.date !== today),
      todayPoint,
    ]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-120);

    window.localStorage.setItem(storageKey, JSON.stringify(next));
    setPortfolioHistory(next);
  }, [isHydrated, portfolio.totalKrw, user.id]);

  const shown = useMemo(() => portfolio.holdings
    .filter((h) => `${h.ticker} ${h.companyName} ${h.category}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortKey === "ticker" || sortKey === "category" ? a[sortKey].localeCompare(b[sortKey]) : b[sortKey] - a[sortKey]), [portfolio.holdings, search, sortKey]);

  const updateShares = (ticker: string, shares: number) => {
    if (!Number.isFinite(shares) || shares < 0) return;
    setRawHoldings((current) => updateHolding(current, ticker, { shares }));
  };

  const editShares = (ticker: string, raw: string) => {
    setSharesDrafts((current) => ({ ...current, [ticker]: raw }));
    if (raw.trim() !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
      updateShares(ticker, Number(raw));
    }
  };
  const finishSharesEdit = (ticker: string) => {
    const raw = sharesDrafts[ticker];
    if (raw !== undefined && raw.trim() === "") updateShares(ticker, 0);
    setSharesDrafts((current) => {
      if (!(ticker in current)) return current;
      const next = { ...current };
      delete next[ticker];
      return next;
    });
    // Do not release the viewport on blur: Safari may still be closing the keyboard.
    // The Portfolio tab effect restores the original setting when leaving this tab.
  };

  const saveStock = (input: StockInput) => {
    setRawHoldings((current) => {
      if (modal?.mode === "edit" && modal.holding) {
        return current.map((holding) => holding.ticker === modal.holding?.ticker
          ? { ...holding, companyName: input.companyName, category: input.category, shares: input.shares, averageCost: input.averageCost }
          : holding);
      }
      if (current.some((holding) => holding.ticker.toUpperCase() === input.ticker.toUpperCase())) return current;
      return addHolding(current, createStock(input));
    });
    setModal(null);
  };

  const removeStock = (ticker: string) => {
    if (!window.confirm(`Delete ${ticker} from the portfolio?`)) return;
    setRawHoldings((current) => deleteHolding(current, ticker));
  };

  const clearPortfolio = () => {
    if (!rawHoldings.length) return;
    if (!window.confirm("Delete every stock from the portfolio? This cannot be undone.")) return;
    setRawHoldings([]);
    setSearch("");
  };
  const downloadCsv = () => { const blob = new Blob([exportCsv(rawHoldings)], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "portfolio.csv"; a.click(); URL.revokeObjectURL(url); };
  const uploadCsv = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; file.text().then((text) => setRawHoldings((current) => importCsv(current, text))); event.target.value = ""; };

  const visiblePortfolioHistory = portfolioHistory.length >= 2
    ? portfolioHistory
    : createPreviewHistory(portfolio.totalKrw);

  return <main className={`app-shell${activeTab === "rebalancing" ? " app-rebalancing-active" : activeTab === "portfolio" ? " app-portfolio-active" : activeTab === "market-map" ? " app-market-map-active" : activeTab === "settings" ? " app-settings-active" : ""}`}>
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-mark" aria-label="SAP logo">
          <span className="brand-mark-main">SAP</span>
          <svg className="brand-trend" viewBox="0 0 100 44" aria-hidden="true">
            <defs>
              <linearGradient id="sapTrendGradient" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#861F41" />
                <stop offset="100%" stopColor="#E87722" />
              </linearGradient>
            </defs>
            <path
              className="brand-trend-fill"
              d="M5 34 C19 34 28 31 39 26 C49 22 58 24 67 18 C75 13 82 8 94 5 C88 13 81 20 71 26 C61 32 49 36 35 38 C23 40 13 39 5 37 Z"
            />
            <path
              className="brand-trend-line"
              d="M7 33 C20 33 29 29 39 25 C50 20 58 23 67 17 C76 11 84 7 94 5"
            />
            <path className="brand-trend-arrow" d="M84 4 L96 4 L92 15" />
          </svg>
        </div>
        <div className="brand-copy">
          <strong>Stock Asset Portfolio</strong>
          <div className="brand-meta">
            <span className="brand-subtitle">Created by Steven.H.Koo</span>
            <span className="brand-meta-divider">·</span>
            <span className="brand-credit">Portfolio Allocation</span>
          </div>
        </div>
      </div>
      <div className="exchange-summary" aria-label="Exchange rate">
        <span>Exchange Rate (USD/KRW)</span>
        <strong>₩{liveExchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
        <small>{marketStatus === "live" ? `Updated ${lastUpdated}` : "Using saved rate"}</small>
      </div>
      <div className="top-actions"><span className={`cloud-state ${syncStatus}`}>{syncStatus === "loading" ? "Loading cloud" : syncStatus === "saving" ? "Saving…" : syncStatus === "saved" ? "Cloud saved" : "Sync error"}</span><button className="icon-button" onClick={downloadCsv}>⇩</button><button className="icon-button" onClick={() => fileRef.current?.click()}>⇧</button><button className="primary-button" onClick={() => setModal({ mode: "add" })}>＋ Add Stock</button><button className="logout-button" onClick={() => getSupabaseBrowserClient().auth.signOut()}>Log out</button><input ref={fileRef} hidden type="file" accept=".csv" onChange={uploadCsv}/></div>
      <nav className="main-navigation desktop-navigation">
        <button className={activeTab === "portfolio" ? "active" : ""} onClick={() => setActiveTab("portfolio")}>Portfolio</button>
        <button className={activeTab === "rebalancing" ? "active" : ""} onClick={() => setActiveTab("rebalancing")}>Rebalancing</button>
        <button className={activeTab === "market-map" ? "active" : ""} onClick={() => setActiveTab("market-map")}>Market Map</button>
        <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>Settings</button>
      </nav>
    </header>

    <nav
      className={`mobile-bottom-navigation${bottomTabSlide !== null ? " is-sliding" : ""}`}
      aria-label="Mobile primary navigation"
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        suppressBottomTabClick.current = false;
        bottomTabDrag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        setBottomTabSlide(getBottomTabPosition(event.currentTarget, event.clientX));
      }}
      onPointerMove={(event) => {
        const started = bottomTabDrag.current;
        if (!started || event.pointerId !== started.pointerId) return;
        if (Math.abs(event.clientX - started.x) > 6 || Math.abs(event.clientY - started.y) > 6) {
          started.moved = true;
        }
        setBottomTabSlide(getBottomTabPosition(event.currentTarget, event.clientX));
      }}
      onPointerUp={finishBottomTabDrag}
      onPointerCancel={() => { bottomTabDrag.current = null; setBottomTabSlide(null); }}
      onClickCapture={(event) => {
        if (suppressBottomTabClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressBottomTabClick.current = false;
        }
      }}
    >
      {bottomTabSlide !== null && (
        <span
          className="bottom-tab-slide-highlight"
          aria-hidden="true"
          style={{ left: `calc(8px + (100% - 16px) * ${bottomTabSlide} / 4)` }}
        />
      )}
      <button className={activeTab === "portfolio" ? "active" : ""} data-slide-selected={bottomTabSlide !== null && Math.round(bottomTabSlide) === 0} onClick={() => setActiveTab("portfolio")}>Portfolio</button>
      <button className={activeTab === "rebalancing" ? "active" : ""} data-slide-selected={bottomTabSlide !== null && Math.round(bottomTabSlide) === 1} onClick={() => setActiveTab("rebalancing")}>Rebalancing</button>
      <button className={activeTab === "market-map" ? "active" : ""} data-slide-selected={bottomTabSlide !== null && Math.round(bottomTabSlide) === 2} onClick={() => setActiveTab("market-map")}>Market Map</button>
      <button className={activeTab === "settings" ? "active" : ""} data-slide-selected={bottomTabSlide !== null && Math.round(bottomTabSlide) === 3} onClick={() => setActiveTab("settings")}>Settings</button>
    </nav>

    {activeTab === "portfolio" ? (
      <div className="page-wrap">
      <section className="hero"><div><span>PORTFOLIO OVERVIEW</span><h1>Your Portfolio</h1><p>Manage allocation, monitor concentration, and keep every position in balance.</p></div><div className={`market-pill ${marketStatus}`}><i/> {marketStatus === "live" ? "Live market data" : marketStatus === "loading" ? "Refreshing market data" : "Saved market data"}</div></section>

      <section className="summary-grid">
        <div className={`portfolio-combined-summary ${costBasisSummary.returnPercent === null ? "performance-neutral" : costBasisSummary.returnPercent > 0 ? "performance-positive" : costBasisSummary.returnPercent < 0 ? "performance-negative" : "performance-neutral"} ${dayChange > 0 ? "daily-positive" : dayChange < 0 ? "daily-negative" : "daily-neutral"}`}>
          <SummaryCard label="TOTAL VALUE" value={formatKrw(portfolio.totalKrw)} note={formatUsd(portfolio.totalUsd)} icon="₩"/>
        <article className="summary-card overview-stat-card total-return-card">
          <div className="overview-stat-heading">
            <span>TOTAL RETURN</span>
            <div className="overview-stat-action">
              <button type="button" className="summary-icon-button total-return-trigger"
                onClick={(event) => { setTotalReturnPosition(getSummaryPopoverPosition(event.currentTarget)); setShowTotalReturnDetail((open) => !open); }}
                aria-expanded={showTotalReturnDetail} aria-label="Show total return profit">
                {costBasisSummary.profitKrw >= 0 ? "↗" : "↘"}
              </button>
              {showTotalReturnDetail && typeof document !== "undefined" && createPortal((
                <div className="total-return-popover" style={{ position: "fixed", top: totalReturnPosition.top, left: totalReturnPosition.left, zIndex: 2147483647, transform: "none", display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", gap: 5, width: "max-content", minWidth: 225, maxWidth: "calc(100vw - 16px)", padding: "12px 14px", border: "1px solid rgba(134,31,65,.16)", borderRadius: 13, background: "#f4efe7", boxShadow: "0 15px 35px rgba(42,24,32,.25)", boxSizing: "border-box" }}>
                  <span style={{ color: "#861f41", fontSize: 10, fontWeight: 900, letterSpacing: ".1em" }}>PROFIT</span>
                  <strong className={costBasisSummary.profitUsd >= 0 ? "profit-positive" : "profit-negative"}>
                    {costBasisSummary.profitUsd >= 0 ? "+" : "-"}{formatUsd(Math.abs(costBasisSummary.profitUsd))}
                  </strong>
                  <strong className={costBasisSummary.profitKrw >= 0 ? "profit-positive" : "profit-negative"}>
                    {costBasisSummary.profitKrw >= 0 ? "+" : "-"}{formatKrw(Math.abs(costBasisSummary.profitKrw))}
                  </strong>
                </div>
              ), document.body)}
            </div>
          </div>
          <strong className="overview-stat-value">{costBasisSummary.returnPercent === null ? "—" : `${costBasisSummary.returnPercent >= 0 ? "+" : ""}${costBasisSummary.returnPercent.toFixed(2)}%`}</strong>
        </article>
        <article className="summary-card overview-stat-card">
          <div className="overview-stat-heading">
            <span>TOTAL CHANGE</span>
            <div className="overview-stat-action">
              <button type="button" className="summary-icon-button" onClick={(event) => { setPreviousClosePosition(getSummaryPopoverPosition(event.currentTarget)); setShowPreviousClose((open) => !open); }}
                aria-expanded={showPreviousClose} aria-label="Show previous US market close portfolio value" title="Previous close portfolio value">⌁</button>
              {showPreviousClose && typeof document !== "undefined" && createPortal((
                <div className="previous-close-fixed-popover" role="status" style={{ position: "fixed", top: previousClosePosition.top, left: previousClosePosition.left, zIndex: 2147483647, display: "flex", flexDirection: "column", gap: 5, width: "max-content", maxWidth: "calc(100vw - 16px)", minWidth: 225, padding: "12px 14px", border: "1px solid rgba(134,31,65,.16)", borderRadius: 13, background: "#f4efe7", boxShadow: "0 15px 35px rgba(42,24,32,.25)", boxSizing: "border-box" }}>
                  <span style={{ color: "#861f41", fontSize: 10, fontWeight: 900, letterSpacing: ".1em" }}>PREVIOUS MARKET CLOSE</span>
                  <span style={{ color: "#64748b", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{formatPreviousMarketCloseKst(closeSession)}</span>
                  {previousCloseSummary ? (
                    <>
                      <strong style={{ fontSize: 13, color: "#210a13", whiteSpace: "nowrap" }}>{formatUsd(previousCloseSummary.previousUsd)}</strong>
                      <strong style={{ fontSize: 13, color: "#210a13", whiteSpace: "nowrap" }}>{formatKrw(previousCloseSummary.previousKrw)}</strong>
                    </>
                  ) : <strong>Waiting for valid closing prices</strong>}
                </div>
              ), document.body)}
            </div>
          </div>
          <strong className="overview-stat-value">{dayChangeKrw === null ? "—" : `${dayChangeKrw >= 0 ? "+" : ""}${formatKrw(dayChangeKrw)}`}</strong>
        </article>
        <article className="summary-card overview-stat-card overview-holdings-stat">
          <div className="overview-stat-heading"><span>HOLDINGS</span></div>
          <strong className="overview-stat-value">{rawHoldings.length}</strong>
        </article>
          <MarketIndexPulse />
        </div>
      </section>

      <section className="main-grid">
        <DonutChart holdings={portfolio.holdings}/>
        <TopHoldings holdings={portfolio.holdings}/>
      </section>

      <section className="holdings-card card holdings-card-full">
        <div className="section-heading holdings-heading"><div><span>PORTFOLIO HOLDINGS</span><h2>Holdings</h2></div><div className="table-tools"><button className="ghost-button clear-button" onClick={clearPortfolio} disabled={!rawHoldings.length}>Clear all</button><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search stocks"/><select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}><option value="allocation">Allocation</option><option value="valueUsd">Value</option><option value="ticker">Ticker</option><option value="category">Category</option></select></div></div>
        <div className="table-scroll"><table><thead><tr><th>Asset</th><th>Category</th><th>Price</th><th>Avg Cost</th><th>P/L vs Avg</th><th>Shares</th><th>Value</th><th>Allocation</th><th></th></tr></thead><tbody>
          {shown.map((h) => <tr key={h.ticker}>
            <td className="asset-column">
              <div className="asset-cell">
                <CompanyMark ticker={h.ticker}/>
                <div className="asset-copy">
                  <div className="asset-name-line">
                    <b>{h.ticker}</b>
                    <span className="company-name">{h.companyName}</span>
                  </div>
                  <span className="mobile-category"><i style={{ background: categoryColors[h.category] ?? "#94a3b8" }}/>{h.category}</span>
                </div>
              </div>
            </td>
            <td className="category-column"><span className="category-pill"><i style={{ background: categoryColors[h.category] ?? "#94a3b8" }}/>{h.category}</span></td>
            <td className="price-column">
              <span className="mobile-field-label">Price</span>
              <b>{formatUsd(h.currentPrice)}</b>
              <span className="holding-krw-amount">{formatKrw(h.currentPrice * liveExchangeRate)}</span>
            </td>
            <td className="avg-cost-column">
              <span className="mobile-field-label">Avg Cost</span>
              <b>{h.averageCost > 0 ? formatUsd(h.averageCost) : "—"}</b>
              <span className="holding-krw-amount">{h.averageCost > 0 ? formatKrw(h.averageCost * liveExchangeRate) : "—"}</span>
            </td>
            <td className="cost-return-column">
              <span className="mobile-field-label">P/L vs Avg</span>
              {(() => {
                const costReturn = costReturnPercent(h.currentPrice, h.averageCost);
                return (
                  <>
                    <b className={costReturn === null ? "cost-return neutral" : costReturn >= 0 ? "cost-return up" : "cost-return down"}>
                      {costReturn === null ? "—" : `${costReturn >= 0 ? "+" : ""}${costReturn.toFixed(2)}%`}
                    </b>
                    <span className="pl-krw holding-krw-amount">
                      {costReturn === null
                        ? "—"
                        : `${(h.currentPrice - h.averageCost) * h.shares >= 0 ? "+" : "-"}${formatKrw(
                            Math.abs((h.currentPrice - h.averageCost) * h.shares * liveExchangeRate),
                          )}`}
                    </span>
                  </>
                );
              })()}
            </td>
            <td className="shares-column">
              <span className="mobile-field-label">Shares</span>
              <input className="shares-input" type="number" min="0" step="0.001"
                value={sharesDrafts[h.ticker] ?? h.shares}
                onTouchStart={lockSharesViewport}
                onPointerDown={lockSharesViewport}
                onFocus={lockSharesViewport}
                onBlur={() => finishSharesEdit(h.ticker)}
                onChange={(e) => editShares(h.ticker, e.target.value)}/>
            </td>
            <td className="value-column">
              <span className="mobile-field-label">Value</span>
              <b>{formatUsd(h.valueUsd)}</b>
              <span className="holding-krw-amount">{formatKrw(h.valueUsd * liveExchangeRate)}</span>
            </td>
            <td className="allocation-column">
              <span className="mobile-field-label">Allocation</span>
              <div className="allocation-cell"><div><i style={{ width: `${Math.max(0, Math.min(100, h.allocation))}%` }}/></div><b>{h.allocation.toFixed(2)}%</b></div>
            </td>
            <td className="actions-column"><div className="row-actions"><button onClick={() => setModal({ mode: "edit", holding: h })}>Edit</button><button onClick={() => removeStock(h.ticker)}>×</button></div></td>
          </tr>)}
          {!shown.length && <tr><td colSpan={9}><div className="empty-holdings"><strong>{rawHoldings.length ? "No stocks match your search." : "Your portfolio is empty."}</strong><span>{rawHoldings.length ? "Try another ticker or company name." : "Click + Add Stock and enter your first ticker."}</span>{!rawHoldings.length && <button className="primary-button" onClick={() => setModal({ mode: "add" })}>＋ Add Stock</button>}</div></td></tr>}
        </tbody></table></div>
      </section>

      <footer className="statusbar"><span><i/> {syncStatus === "saved" ? "Portfolio synced to cloud" : syncStatus === "saving" ? "Saving portfolio to cloud" : syncStatus === "error" ? "Cloud sync failed — local copy kept" : "Loading cloud portfolio"}</span><span>USD/KRW {liveExchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>Last update {lastUpdated}</span><span>Auto refresh: 60s</span></footer>
      </div>
    ) : activeTab === "rebalancing" ? (
      <div className="page-wrap">
        <RebalancingTab holdings={portfolio.holdings} />
      </div>
    ) : activeTab === "market-map" ? (
      <div className="page-wrap market-map-page-wrap">
        <MarketMapTab holdings={portfolio.holdings} />
      </div>
    ) : (
      <div className="page-wrap settings-page-wrap">
        <SettingsTab
          holdingsCount={portfolio.holdings.length}
          onNavigate={(tab) => setActiveTab(tab)}
        />
      </div>
    )}
    {changeHistoryOpen && (
      <TotalChangeHistoryModal
        points={visiblePortfolioHistory}
        onClose={() => setChangeHistoryOpen(false)}
      />
    )}
    <Modal state={modal} existingTickers={rawHoldings.map((holding) => holding.ticker.toUpperCase())} exchangeRate={liveExchangeRate} onClose={() => setModal(null)} onSave={saveStock}/>
    <style jsx global>{`
      .summary-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      }

      .summary-card-clickable {
        position: relative;
      }

      .summary-card-clickable .summary-icon-button {
        position: relative;
        z-index: 5;
        pointer-events: auto;
        display: grid;
        width: 42px;
        height: 42px;
        flex: 0 0 42px;
        place-items: center;
        border: 1px solid rgba(134,31,65,.14);
        border-radius: 14px;
        background: linear-gradient(145deg, #fff7ed, #ffffff);
        color: #861f41;
        font-size: 18px;
        font-weight: 950;
        cursor: pointer;
        box-shadow: 0 7px 16px rgba(75,16,38,.09);
        transition: transform 150ms ease, box-shadow 150ms ease;
      }

      .summary-card-clickable .summary-icon-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 11px 22px rgba(75,16,38,.14);
      }

      .change-history-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(15,23,42,.46);
        backdrop-filter: blur(8px);
      }

      .change-history-modal {
        width: min(920px, 100%);
        max-height: min(760px, calc(100vh - 40px));
        overflow: auto;
        border: 1px solid rgba(134,31,65,.14);
        border-radius: 22px;
        background: #fff;
        box-shadow: 0 28px 80px rgba(15,23,42,.28);
      }

      .change-history-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        padding: 22px 24px 18px;
        border-bottom: 1px solid #edf0f4;
      }

      .change-history-header span {
        color: #861f41;
        font-size: 9px;
        font-weight: 950;
        letter-spacing: .13em;
      }

      .change-history-header h2 {
        margin: 5px 0 0;
        color: #210a13;
        font-size: 23px;
        font-weight: 950;
      }

      .change-history-header p {
        margin: 7px 0 0;
        color: #303846;
        font-size: 11px;
      }

      .change-history-header > button {
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        background: #fff;
        color: #303846;
        font-size: 20px;
        cursor: pointer;
      }

      .change-chart-wrap {
        padding: 20px 22px 4px;
      }

      .change-chart-wrap svg {
        display: block;
        width: 100%;
        height: auto;
        overflow: visible;
      }

      .change-zero-line {
        stroke: #cbd5e1;
        stroke-width: 1;
        stroke-dasharray: 5 5;
      }

      .change-area {
        fill: url(#changeAreaGradient);
      }

      .change-line {
        fill: none;
        stroke: #861f41;
        stroke-width: 3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .change-point {
        stroke: #fff;
        stroke-width: 2.5;
      }

      .change-point.positive {
        fill: #dc2626;
      }

      .change-point.negative {
        fill: #2563eb;
      }

      .change-axis-label,
      .change-date-label {
        fill: #7c8797;
        font-size: 10px;
        font-weight: 700;
      }

      .change-history-list {
        display: grid;
        gap: 0;
        margin: 0 24px 24px;
        border: 1px solid #edf0f4;
        border-radius: 14px;
        overflow: hidden;
      }

      .change-history-row {
        display: grid;
        grid-template-columns: 1fr auto auto;
        align-items: center;
        gap: 18px;
        min-height: 44px;
        padding: 0 14px;
        border-bottom: 1px solid #edf0f4;
      }

      .change-history-row:last-child {
        border-bottom: 0;
      }

      .change-history-row span {
        color: #536075;
        font-size: 11px;
        font-weight: 800;
      }

      .change-history-row strong {
        font-size: 12px;
        font-weight: 950;
      }

      .change-history-row small {
        min-width: 68px;
        font-size: 11px;
        font-weight: 900;
        text-align: right;
      }

      .change-history-row .positive {
        color: #dc2626;
      }

      .change-history-row .negative {
        color: #2563eb;
      }

      .change-history-empty {
        display: flex;
        min-height: 320px;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        padding: 30px;
        color: #303846;
        text-align: center;
      }

      .change-history-empty strong {
        color: #210a13;
        font-size: 16px;
      }

      .change-history-empty span {
        font-size: 11px;
      }

      @media (max-width: 760px) {
        .change-history-backdrop {
          padding: 10px;
        }

        .change-history-modal {
          max-height: calc(100vh - 20px);
          border-radius: 17px;
        }

        .change-history-header {
          padding: 18px 16px 14px;
        }

        .change-chart-wrap {
          padding: 14px 8px 0;
          overflow-x: auto;
        }

        .change-chart-wrap svg {
          min-width: 690px;
        }

        .change-history-list {
          margin: 0 14px 16px;
        }

        .change-history-row {
          grid-template-columns: 1fr auto;
          gap: 8px 12px;
          padding: 8px 12px;
        }

        .change-history-row small {
          grid-column: 2;
        }
      }

      .topbar .brand-block {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
      }
      .topbar .brand-mark {
        position: relative;
        display: flex;
        width: 52px;
        height: 52px;
        flex: 0 0 52px;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.45);
        border-radius: 16px;
        background:
          radial-gradient(circle at 22% 18%, rgba(255,255,255,.34), transparent 34%),
          linear-gradient(145deg, #172554 0%, #3156d9 52%, #5b7cff 100%);
        box-shadow:
          0 10px 24px rgba(49, 86, 217, .22),
          inset 0 1px 0 rgba(255,255,255,.24);
        color: #fff;
      }
      .topbar .brand-mark::before {
        content: "";
        position: absolute;
        width: 34px;
        height: 34px;
        right: -15px;
        bottom: -17px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 50%;
      }
      .topbar .brand-mark::after {
        content: "";
        position: absolute;
        width: 5px;
        height: 5px;
        top: 8px;
        right: 8px;
        border-radius: 50%;
        background: rgba(255,255,255,.92);
        box-shadow: 0 0 0 4px rgba(255,255,255,.10);
      }
      .topbar .brand-mark-main {
        position: absolute;
        z-index: 3;
        top: 8px;
        left: 50%;
        display: block !important;
        transform: translateX(-50%);
        color: #fff !important;
        font-size: 16px !important;
        font-weight: 950 !important;
        letter-spacing: -.055em;
        line-height: 1;
        text-shadow: 0 1px 7px rgba(0,0,0,.22);
      }
      .topbar .brand-trend {
        position: absolute;
        z-index: 2;
        left: 5px;
        right: 5px;
        bottom: 3px;
        width: calc(100% - 10px);
        height: 25px;
        overflow: visible;
        filter: drop-shadow(0 3px 5px rgba(75,16,38,.24));
      }
      .topbar .brand-trend-fill {
        fill: url(#sapTrendGradient);
        opacity: .98;
      }
      .topbar .brand-trend-line {
        fill: none;
        stroke: #fff7ed;
        stroke-width: 2.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .topbar .brand-trend-arrow {
        fill: none;
        stroke: #fff7ed;
        stroke-width: 2.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .topbar .brand-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        justify-content: center;
      }
      .topbar .brand-copy > strong {
        display: block;
        overflow: hidden;
        color: #0f172a;
        font-size: 15px;
        font-weight: 900;
        letter-spacing: -.025em;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .topbar .brand-meta {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
        color: #303846;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .035em;
        line-height: 1;
        white-space: nowrap;
      }
      .topbar .brand-meta span {
        display: inline !important;
      }
      .topbar .brand-meta-divider {
        color: #303846;
        font-weight: 900;
      }
      .topbar .brand-credit {
        color: #53647f;
        font-weight: 800;
      }

      .topbar {
        display: grid !important;
        grid-template-columns: minmax(260px, 1fr) auto auto;
        grid-template-areas:
          "brand exchange actions"
          "navigation navigation navigation";
        height: auto !important;
        min-height: 118px;
        gap: 10px 22px;
        align-items: center;
        padding-top: 12px !important;
        padding-bottom: 0 !important;
      }
      .topbar .brand-block {
        grid-area: brand;
      }
      .topbar .exchange-summary {
        grid-area: exchange;
        display: flex;
        min-width: 176px;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        padding: 4px 18px 4px 0;
        border-right: none;
      }
      .topbar .exchange-summary span {
        margin: 0;
        color: #303846;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
      }
      .topbar .exchange-summary strong {
        margin-top: 4px;
        color: #861f41;
        font-size: 22px;
        font-weight: 900;
        letter-spacing: -.03em;
        line-height: 1;
      }
      .topbar .exchange-summary small {
        margin-top: 5px;
        color: #303846;
        font-size: 9px;
        font-weight: 700;
      }
      .topbar .top-actions {
        grid-area: actions;
      }
      .topbar .main-navigation {
        grid-area: navigation;
        display: grid !important;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        width: calc(100% + 68px);
        min-width: 0;
        margin: 0 -34px;
        padding: 0 34px;
        align-self: end;
        border-top: 1px solid #e5eaf1;
        background: rgba(255,255,255,.96);
      }
      .topbar .main-navigation button {
        display: flex !important;
        height: 46px;
        align-items: center;
        justify-content: center;
        padding: 0 10px !important;
        border: 0 !important;
        border-bottom: 3px solid transparent !important;
        background: transparent;
        color: #303846;
        font-size: 12px !important;
        font-weight: 800;
      }
      .topbar .main-navigation button.active {
        color: #861f41 !important;
        border-bottom-color: #e87722 !important;
        background: transparent !important;
        box-shadow: none !important;
      }

      .main-grid {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
        align-items: stretch;
      }
      .main-grid > .allocation-card,
      .main-grid > .holdings-card {
        min-width: 0;
      }
      .holdings-card .table-scroll {
        overflow-x: auto;
      }
      .holdings-card table {
        min-width: 760px;
      }
      .mobile-category,
      .mobile-field-label {
        display: none;
      }
      @media (max-width: 1180px) {
        .topbar {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto;
          grid-template-areas:
            "brand actions"
            "navigation navigation";
          gap: 12px 14px;
          align-items: center;
          padding-bottom: 10px !important;
        }
        .topbar .brand-block {
          grid-area: brand;
          min-width: 0;
        }
        .topbar .top-actions {
          grid-area: actions;
          min-width: 0;
          justify-content: flex-end;
        }
        .topbar .main-navigation {
          grid-area: navigation;
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          width: 100%;
          min-width: 0;
          margin: 0;
          padding: 4px;
          gap: 3px;
          overflow: visible;
          border: 1px solid #e2e8f0;
          border-radius: 13px;
          background: #f8fafc;
          box-sizing: border-box;
        }
        .topbar .main-navigation button {
          display: flex !important;
          min-width: 0;
          height: 38px;
          align-items: center;
          justify-content: center;
          margin: 0 !important;
          padding: 0 6px !important;
          border: 0 !important;
          border-radius: 9px;
          overflow: hidden;
          color: #303846;
          font-size: 11px !important;
          font-weight: 800;
          line-height: 1;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .topbar .main-navigation button::after {
          display: none !important;
        }
        .topbar .main-navigation button.active {
          background: #ffffff;
          color: #15803d;
          box-shadow: 0 1px 4px rgba(15, 23, 42, .08);
        }
      }

      @media (max-width: 1180px) {
        .main-grid { grid-template-columns: 1fr !important; }
      }
      .topbar nav button:disabled { cursor: not-allowed; opacity: .42; }
      .ticker-search-label { position: relative; }
      .ticker-search-box { position: relative; }
      .ticker-search-box > input { padding-right: 88px !important; }
      .ticker-search-status { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: #303846; font-size: 11px; font-weight: 800; pointer-events: none; }
      .ticker-search-status.verified { color: #16a34a; }
      .ticker-results { position: absolute; z-index: 40; left: 0; right: 0; top: calc(100% + 6px); max-height: 250px; overflow-y: auto; padding: 6px; background: #fff; border: 1px solid #dbe4f0; border-radius: 12px; box-shadow: 0 18px 42px rgba(15, 23, 42, .18); }
      .ticker-results button { width: 100%; display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: center; padding: 10px; border: 0; border-radius: 9px; background: transparent; text-align: left; cursor: pointer; }
      .ticker-results button:hover { background: #f1f5f9; }
      .ticker-results strong { color: #0f172a; font-size: 13px; }
      .ticker-results span { overflow: hidden; color: #334155; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .ticker-results small { color: #303846 !important; font-size: 10px !important; white-space: nowrap; }
      .ticker-results p { margin: 0; padding: 14px 10px; color: #303846; font-size: 12px; text-align: center; }
      .stock-modal label em { color: #303846; font-size: 11px; font-style: normal; font-weight: 500; }
      .clear-button { color: #ef4444 !important; }
      .clear-button:disabled { cursor: not-allowed; opacity: .4; }
      .empty-holdings { min-height: 300px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: #7b879b; text-align: center; }
      .empty-holdings strong { color: #273247; font-size: 16px; }
      .empty-holdings span { font-size: 12px; }
      .cloud-state { color:#303846; font-size:11px; font-weight:800; white-space:nowrap; }
      .cloud-state.saved { color:#16a34a; }
      .cloud-state.error { color:#dc2626; }
      .logout-button { border:0; background:transparent; color:#303846; font-size:11px; font-weight:800; cursor:pointer; }
      .empty-holdings button { margin-top: 8px; }
      
      @media (max-width: 760px) {
        .topbar .brand-copy > strong{
          white-space: normal;
          overflow: visible;
          text-overflow: unset;
          line-height:1.15;
        }
        .topbar .brand-meta{
          display:flex;
          flex-wrap:wrap;
          white-space:normal;
          row-gap:2px;
        }
        .topbar .brand-meta-divider,
        .topbar .brand-credit{
          display:none!important;
        }
        .topbar .brand-subtitle{
          font-size:11px;
          font-weight:800;
        }
      }

@media (max-width: 1180px) {
        .holdings-heading {
          align-items: flex-start !important;
          gap: 14px;
        }
        .holdings-heading .table-tools {
          width: 100%;
          flex-wrap: wrap;
        }
        .holdings-heading .table-tools input {
          flex: 1 1 180px;
          min-width: 0;
        }
        .holdings-heading .table-tools select {
          flex: 0 1 130px;
        }
        .clear-button { order: 3; }

        .holdings-card {
          padding: 16px !important;
        }
        .holdings-card .table-scroll {
          overflow-x: visible;
        }
        .holdings-card table {
          display: block;
          width: 100%;
          min-width: 0;
        }
        .holdings-card thead {
          display: none;
        }
        .holdings-card tbody {
          display: grid;
          width: 100%;
          gap: 10px;
        }
        .holdings-card tbody tr {
          position: relative;
          display: grid;
          width: 100%;
          grid-template-columns: minmax(150px, 1.45fr) minmax(78px, .7fr) minmax(88px, .75fr) minmax(105px, .9fr) minmax(92px, .75fr) auto;
          grid-template-areas:
            "asset price shares value allocation actions";
          gap: 10px 12px;
          align-items: center;
          padding: 14px;
          border: 1px solid #e6ebf2;
          border-radius: 14px;
          background: #fff;
          box-sizing: border-box;
        }
        .holdings-card tbody tr:hover {
          background: #fff;
          border-color: #cbd5e1;
        }
        .holdings-card tbody td {
          min-width: 0;
          padding: 0 !important;
          border: 0 !important;
        }
        .asset-column { grid-area: asset; align-self: stretch; display: flex; align-items: center; }
        .price-column { grid-area: price; }
        .shares-column { grid-area: shares; }
        .value-column { grid-area: value; }
        .allocation-column { grid-area: allocation; }
        .actions-column { grid-area: actions; justify-self: end; align-self: start; }
        .category-column {
          display: none !important;
        }
        .asset-cell {
          min-width: 0;
          align-items: center !important;
        }
        .asset-copy {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .asset-copy > b {
          font-size: 14px;
        }
        .company-name {
          display: block;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px !important;
        }
        .mobile-category {
          display: inline-flex;
          width: fit-content;
          max-width: 100%;
          align-items: center;
          gap: 5px;
          margin-top: 3px;
          color: #303846;
          font-size: 10px;
          font-weight: 750;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mobile-category i {
          width: 7px;
          height: 7px;
          flex: 0 0 7px;
          border-radius: 50%;
        }
        .mobile-field-label {
          display: block;
          margin-bottom: 4px;
          color: #303846;
          font-size: 9px;
          font-weight: 850;
          letter-spacing: .07em;
          text-transform: uppercase;
        }
        .price-column,
        .shares-column,
        .value-column,
        .allocation-column {
          display: flex;
          min-width: 0;
          flex-direction: column;
          align-items: flex-start;
        }
        .price-column > b,
        .value-column > b {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }
        .price-column > span:not(.mobile-field-label),
        .value-column > span:not(.mobile-field-label) {
          font-size: 10px;
        }
        .shares-input {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 105px;
          box-sizing: border-box;
        }
        .allocation-column .allocation-cell {
          width: 100%;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 7px;
        }
        .allocation-column .allocation-cell > div {
          flex: 1 1 auto;
          min-width: 34px;
          max-width: 72px;
        }
        .allocation-column .allocation-cell > b {
          flex: 0 0 auto;
          font-size: 11px;
          white-space: nowrap;
        }
        .row-actions {
          gap: 4px !important;
        }
        .row-actions button:first-child {
          padding: 5px 8px !important;
          font-size: 10px !important;
        }
        .row-actions button:last-child {
          width: 26px !important;
          height: 26px !important;
        }
        .empty-holdings {
          grid-column: 1 / -1;
        }
      }

      @media (max-width: 430px) {
        .topbar .brand-copy > strong {
          max-width: 125px;
          font-size: 12px;
        }
        .topbar .brand-meta {
          max-width: 135px;
        }
        .topbar .brand-credit {
          display: none !important;
        }
        .topbar .brand-meta-divider {
          display: none !important;
        }
      }

      @media (max-width: 680px) {
        .topbar {
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          padding-left: 12px !important;
          padding-right: 12px !important;
        }
        .topbar .brand-mark {
          width: 43px;
          height: 43px;
          flex-basis: 43px;
          border-radius: 13px;
        }
        .topbar .brand-mark-main {
          display: block !important;
          font-size: 14px !important;
        }
        .topbar .brand-copy > strong {
          max-width: 155px;
          font-size: 13px;
        }
        .topbar .brand-meta {
          max-width: 190px;
          gap: 4px;
          margin-top: 4px;
          overflow: hidden;
          font-size: 8px;
          letter-spacing: .015em;
          text-overflow: ellipsis;
        }
        .topbar .brand-meta span {
          display: inline !important;
        }
        .topbar .top-actions .cloud-state,
        .topbar .top-actions .icon-button,
        .topbar .top-actions .logout-button {
          display: none !important;
        }
        .topbar .top-actions .primary-button {
          min-width: auto;
          height: 36px;
          padding: 0 10px !important;
          font-size: 0;
        }
        .topbar .top-actions .primary-button::after {
          content: "＋";
          font-size: 18px;
          line-height: 1;
        }
        .topbar .main-navigation button {
          height: 40px;
          padding: 0 3px !important;
          font-size: 10px !important;
        }
      }

      @media (max-width: 560px) {
        .page-wrap {
          padding-left: 12px !important;
          padding-right: 12px !important;
        }
        .holdings-card {
          padding: 12px !important;
          border-radius: 16px !important;
        }
        .holdings-card tbody tr {
          grid-template-columns: minmax(0, 1fr) minmax(104px, .78fr);
          grid-template-areas:
            "asset actions"
            "price shares"
            "value allocation";
          gap: 11px 12px;
          padding: 13px;
        }
        .asset-column {
          min-height: 50px;
        }
        .value-column,
        .allocation-column {
          padding-top: 9px !important;
          border-top: 1px solid #f1f5f9 !important;
        }
        .allocation-column {
          align-items: flex-end;
        }
        .allocation-column .allocation-cell {
          justify-content: flex-end;
        }
        .allocation-column .allocation-cell > div {
          max-width: 48px;
        }
        .company-name {
          max-width: 150px;
        }
      }
    
      /* Release 2.1 header and navigation alignment */
      .topbar { height:auto!important; min-height:82px; padding:12px max(18px,calc((100vw - 1560px)/2))!important; gap:22px!important; }
      .topbar .brand-mark { border:0!important; background:linear-gradient(145deg,#861f41 0%,#a92b52 58%,#e87722 100%)!important; box-shadow:0 10px 22px rgba(134,31,65,.28)!important; }
      .topbar .brand-mark::before,.topbar .brand-mark::after{display:none!important}
      .topbar .brand-copy>strong{color:#4b1026!important}
      .topbar .brand-meta{color:#861f41!important}.topbar .brand-credit{color:#e87722!important}
      .topbar .main-navigation{align-self:center!important;height:48px;padding:4px!important;border:2px solid rgba(134,31,65,.24)!important;border-radius:14px!important;background:#fff7ed!important;box-shadow:none!important}
      .topbar .main-navigation button{height:36px!important;border-radius:9px!important;color:#6f2a40!important;font-weight:850!important}
      .topbar .main-navigation button.active{background:#861f41!important;color:#fff!important;border:0!important;box-shadow:0 5px 12px rgba(134,31,65,.24)!important}
      .allocation-chart-area{aspect-ratio:auto!important}
      .allocation-donut{width:min(100%,530px)!important;height:auto!important;aspect-ratio:1/1!important;flex:0 0 auto!important}
      @media(max-width:1180px){.topbar{padding:10px 14px!important}.topbar .main-navigation{width:100%!important}}
      @media(max-width:680px){.topbar .brand-credit,.topbar .brand-meta-divider{display:inline!important}.topbar .brand-meta{max-width:none!important;overflow:visible!important}.topbar .brand-copy>strong{max-width:none!important}.topbar .main-navigation{margin-top:2px!important}}

      .top-holdings-card {
        display: flex;
        min-width: 0;
        height: 650px;
        flex-direction: column;
        overflow: hidden;
        background: #ffffff;
      }
      .top-holdings-heading {
        flex: 0 0 76px;
      }
      .top-holdings-columns {
        display: grid;
        flex: 0 0 36px;
        grid-template-columns: 92px minmax(118px, 1fr) 128px 104px 78px;
        align-items: center;
        gap: 14px;
        padding: 0 22px;
        border-bottom: 1px solid #edf0f4;
        background: linear-gradient(180deg, #fff, #fbfcfe);
        color: #303846;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .1em;
        text-transform: uppercase;
      }
      .top-holdings-columns span:nth-child(n+3) {
        text-align: right;
      }
      .top-holdings-list {
        display: grid;
        min-height: 0;
        flex: 1;
        grid-template-rows: repeat(5, minmax(0, 1fr));
        padding: 0 22px;
      }
      .top-holding-row {
        position: relative;
        display: grid;
        min-width: 0;
        grid-template-columns: 92px minmax(118px, 1fr) 128px 104px 78px;
        align-items: center;
        gap: 14px;
        padding: 0;
        border-bottom: 1px solid #edf0f4;
      }
      .top-holding-row:last-child {
        border-bottom: 0;
      }
      .top-holding-row::before {
        content: "";
        position: absolute;
        inset: 8px -8px;
        z-index: 0;
        border: 1px solid transparent;
        border-radius: 14px;
        background: linear-gradient(90deg, rgba(134,31,65,.035), rgba(232,119,34,.025));
        opacity: 0;
        transition: opacity 160ms ease, transform 160ms ease;
        pointer-events: none;
      }
      .top-holding-row:hover::before {
        opacity: 1;
        transform: translateX(2px);
      }
      .top-holding-row > * {
        position: relative;
        z-index: 1;
      }
      .top-holding-position {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .top-holding-position > span {
        display: grid;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        place-items: center;
        border: 1px solid rgba(134,31,65,.16);
        border-radius: 9px;
        background: #fff7ed;
        color: #861f41;
        font-size: 10px;
        font-weight: 950;
        letter-spacing: .04em;
      }
      .top-holding-logo {
        display: grid;
        width: 46px;
        height: 46px;
        flex: 0 0 46px;
        place-items: center;
        border: 1px solid rgba(134,31,65,.12);
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 6px 16px rgba(75,16,38,.08);
      }
      .top-holding-logo :global(.company-mark) {
        border: 0;
        background: transparent;
        box-shadow: none;
        padding: 3px;
      }
      .top-holding-identity {
        display: flex;
        min-width: 0;
        flex-direction: column;
        justify-content: center;
      }
      .top-holding-identity strong {
        color: #210a13;
        font-size: 16px;
        font-weight: 950;
        letter-spacing: -.025em;
        line-height: 1.1;
      }
      .top-holding-identity span {
        margin-top: 5px;
        overflow: hidden;
        color: #303846;
        font-size: 10px;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .top-holding-stat {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: flex-end;
        justify-content: center;
        text-align: right;
      }
      .top-holding-stat > span {
        color: #303846;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .08em;
        line-height: 1;
        text-transform: uppercase;
      }
      .top-holding-stat > strong {
        max-width: 100%;
        margin-top: 6px;
        overflow: hidden;
        color: #4b1026;
        font-size: 13px;
        font-weight: 900;
        line-height: 1.1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .top-holding-stat.allocation > i {
        display: block;
        width: 66px;
        height: 4px;
        margin-top: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: #f1e5df;
      }
      .top-holding-stat.allocation > i > b {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #861f41, #e87722);
      }
      .top-holding-stat.shares > strong {
        display: inline-flex;
        min-width: 58px;
        justify-content: flex-end;
        padding: 7px 9px;
        border: 1px solid rgba(134,31,65,.14);
        border-radius: 9px;
        background: #fffaf6;
      }
      .top-holdings-empty {
        display: grid;
        grid-row: 1 / -1;
        place-items: center;
        color: #303846;
        font-size: 12px;
      }
      .holdings-card-full {
        width: 100%;
        height: 650px;
        margin-top: 14px;
      }

      @media (max-width: 1180px) {
        .top-holdings-card {
          height: 650px;
        }
        .top-holdings-columns,
        .top-holding-row {
          grid-template-columns: 86px minmax(104px, 1fr) 112px 92px 70px;
          gap: 10px;
        }
        .top-holdings-columns,
        .top-holdings-list {
          padding-left: 16px;
          padding-right: 16px;
        }
      }

      @media (max-width: 760px) {
        .top-holdings-card {
          height: auto;
          min-height: 560px;
        }
        .top-holdings-columns {
          display: none;
        }
        .top-holdings-list {
          display: flex;
          padding: 0 14px 8px;
          flex-direction: column;
        }
        .top-holding-row {
          min-height: 104px;
          grid-template-columns: 82px minmax(0, 1fr) auto;
          grid-template-areas:
            "position identity value"
            "position allocation shares";
          gap: 8px 10px;
          padding: 10px 0;
        }
        .top-holding-position { grid-area: position; }
        .top-holding-identity { grid-area: identity; }
        .top-holding-stat.value { grid-area: value; }
        .top-holding-stat.allocation { grid-area: allocation; align-items: flex-start; text-align: left; }
        .top-holding-stat.shares { grid-area: shares; }
        .top-holding-position > span {
          display: none;
        }
        .top-holding-logo {
          width: 52px;
          height: 52px;
          border-radius: 15px;
        }
        .top-holding-stat > span {
          font-size: 7px;
        }
        .top-holding-stat > strong {
          font-size: 11px;
        }
        .top-holding-stat.shares > strong {
          min-width: 52px;
          padding: 6px 8px;
        }
        .holdings-card-full {
          height: auto;
          min-height: 600px;
        }
      }



      /* ===== MOBILE-ONLY LAYOUT FIX — preserves current desktop colors/theme ===== */
      @media (max-width: 760px) {
        html,
        body {
          width: 100%;
          max-width: 100%;
          overflow-x: hidden !important;
          -webkit-text-size-adjust: 100%;
        }

        *,
        *::before,
        *::after {
          box-sizing: border-box;
        }

        .app-shell {
          width: 100%;
          max-width: 100%;
          overflow-x: hidden !important;
        }

        /* Header */
        .topbar {
          position: relative !important;
          display: grid !important;
          width: 100% !important;
          min-height: 0 !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          grid-template-areas:
            "brand actions"
            "exchange exchange"
            "nav nav" !important;
          align-items: center !important;
          gap: 12px !important;
          padding: 14px 14px 12px !important;
          overflow: hidden !important;
        }

        .brand-block {
          grid-area: brand !important;
          display: flex !important;
          min-width: 0 !important;
          align-items: center !important;
          gap: 10px !important;
        }

        .brand-mark {
          width: 58px !important;
          height: 58px !important;
          min-width: 58px !important;
          flex: 0 0 58px !important;
          border-radius: 17px !important;
        }

        .brand-mark-main {
          font-size: 21px !important;
        }

        .brand-copy {
          display: block !important;
          min-width: 0 !important;
        }

        .brand-copy > strong {
          display: block !important;
          width: 100% !important;
          overflow: hidden !important;
          font-size: 15px !important;
          line-height: 1.15 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .brand-meta {
          display: block !important;
          width: 100% !important;
          min-width: 0 !important;
          margin-top: 4px !important;
          overflow: hidden !important;
          font-size: 10px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .brand-meta-divider,
        .brand-credit {
          display: none !important;
        }

        .top-actions {
          grid-area: actions !important;
          display: flex !important;
          width: auto !important;
          min-width: 0 !important;
          align-items: center !important;
          justify-content: flex-end !important;
          gap: 0 !important;
        }

        .top-actions .cloud-state,
        .top-actions .icon-button,
        .top-actions .logout-button,
        .top-actions input {
          display: none !important;
        }

        .top-actions .primary-button {
          display: grid !important;
          width: 52px !important;
          min-width: 52px !important;
          height: 52px !important;
          padding: 0 !important;
          place-items: center !important;
          overflow: hidden !important;
          border-radius: 16px !important;
          font-size: 0 !important;
        }

        .top-actions .primary-button::after {
          content: "+";
          font-size: 27px !important;
          font-weight: 900 !important;
          line-height: 1 !important;
        }

        .exchange-summary {
          grid-area: exchange !important;
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          grid-template-areas:
            "label value"
            "updated updated" !important;
          align-items: end !important;
          gap: 5px 12px !important;
          margin: 0 !important;
          padding: 12px 14px !important;
          overflow: hidden !important;
          border-radius: 14px !important;
        }

        .exchange-summary span {
          grid-area: label !important;
          min-width: 0 !important;
          font-size: 10px !important;
          line-height: 1.25 !important;
          overflow-wrap: anywhere !important;
        }

        .exchange-summary strong {
          grid-area: value !important;
          min-width: 0 !important;
          font-size: 22px !important;
          line-height: 1 !important;
          white-space: nowrap !important;
        }

        .exchange-summary small {
          grid-area: updated !important;
          font-size: 10px !important;
          line-height: 1.25 !important;
        }

        .main-navigation {
          grid-area: nav !important;
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          height: auto !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          gap: 4px !important;
          margin: 0 !important;
          padding: 4px !important;
          overflow: hidden !important;
          border-radius: 14px !important;
        }

        .main-navigation button {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 40px !important;
          align-items: center !important;
          justify-content: center !important;
          padding: 0 3px !important;
          overflow: hidden !important;
          border-radius: 10px !important;
          font-size: 9px !important;
          line-height: 1 !important;
          text-align: center !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        /* Main wrappers */
        .page-wrap,
        .market-map-page-wrap,
        .settings-page-wrap {
          width: 100% !important;
          max-width: 100% !important;
          padding: 14px 12px 26px !important;
          overflow: hidden !important;
        }

        .hero,
        .rebalancing-hero,
        .market-map-hero,
        .settings-hero {
          display: block !important;
          width: 100% !important;
          min-width: 0 !important;
          padding: 22px 18px !important;
          overflow: hidden !important;
        }

        .hero h1,
        .rebalancing-hero h1,
        .market-map-hero h1,
        .settings-hero h1 {
          font-size: 30px !important;
          line-height: 1.08 !important;
          overflow-wrap: anywhere !important;
        }

        .hero p,
        .rebalancing-hero p,
        .market-map-hero p,
        .settings-hero p {
          max-width: 100% !important;
          font-size: 14px !important;
          line-height: 1.45 !important;
          overflow-wrap: anywhere !important;
        }

        .market-pill {
          width: fit-content !important;
          max-width: 100% !important;
          margin-top: 14px !important;
        }

        /* Summary cards */
        .summary-grid {
          display: grid !important;
          width: 100% !important;
          grid-template-columns: 1fr !important;
          gap: 12px !important;
        }

        .summary-card {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          min-height: 116px !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 16px !important;
          padding: 19px 18px !important;
          overflow: hidden !important;
        }

        .summary-card > div {
          min-width: 0 !important;
          flex: 1 1 auto !important;
        }

        .summary-card span {
          font-size: 11px !important;
          line-height: 1.2 !important;
        }

        .summary-card strong {
          display: block !important;
          width: 100% !important;
          max-width: 100% !important;
          margin-top: 8px !important;
          overflow: hidden !important;
          font-size: clamp(25px, 8vw, 34px) !important;
          line-height: 1.05 !important;
          letter-spacing: -.035em !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .summary-card small {
          display: block !important;
          max-width: 100% !important;
          margin-top: 7px !important;
          font-size: 12px !important;
          line-height: 1.35 !important;
          overflow-wrap: anywhere !important;
        }

        .summary-card > i,
        .summary-card .summary-icon-button {
          position: static !important;
          width: 48px !important;
          min-width: 48px !important;
          height: 48px !important;
          flex: 0 0 48px !important;
          margin: 0 !important;
          transform: none !important;
        }

        /* Main content stacking */
        .main-grid {
          display: grid !important;
          width: 100% !important;
          grid-template-columns: 1fr !important;
          gap: 14px !important;
        }

        .allocation-card,
        .top-holdings-card,
        .holdings-card {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          overflow: hidden !important;
        }

        .allocation-category-card,
        .top-holdings-card {
          height: auto !important;
          min-height: 0 !important;
        }

        .section-heading {
          display: flex !important;
          min-width: 0 !important;
          align-items: flex-start !important;
          gap: 12px !important;
          padding: 18px !important;
        }

        .section-heading > div {
          min-width: 0 !important;
          flex: 1 1 auto !important;
        }

        .section-heading h2 {
          font-size: 22px !important;
          line-height: 1.15 !important;
          overflow-wrap: anywhere !important;
        }

        .section-heading .ghost-button {
          flex: 0 0 auto !important;
          padding: 9px 11px !important;
          white-space: nowrap !important;
        }

        /* Donut chart */
        .category-allocation-layout {
          display: grid !important;
          width: 100% !important;
          min-height: 0 !important;
          grid-template-columns: 1fr !important;
          gap: 18px !important;
          padding: 18px 14px 22px !important;
        }

        .category-donut-zone {
          width: 100% !important;
          min-width: 0 !important;
          overflow: hidden !important;
        }

        .category-donut {
          width: min(100%, 320px) !important;
          max-width: calc(100vw - 64px) !important;
          margin: 0 auto !important;
        }

        .category-donut-center strong {
          max-width: 78% !important;
          overflow: hidden !important;
          font-size: clamp(17px, 5vw, 23px) !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .category-allocation-list {
          width: 100% !important;
          min-width: 0 !important;
        }

        .category-allocation-row {
          width: 100% !important;
          min-width: 0 !important;
          padding: 0 4px !important;
        }

        .category-allocation-name {
          min-width: 0 !important;
          overflow: hidden !important;
          font-size: 12px !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        /* Top holdings */
        .top-holdings-columns {
          display: none !important;
        }

        .top-holdings-list {
          display: grid !important;
          width: 100% !important;
          gap: 10px !important;
          padding: 12px !important;
          overflow: visible !important;
        }

        .top-holding-row {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: auto minmax(0, 1fr) auto !important;
          grid-template-areas:
            "position identity value"
            "position allocation shares" !important;
          gap: 7px 10px !important;
          padding: 13px !important;
          overflow: hidden !important;
          border-radius: 14px !important;
        }

        .top-holding-position {
          grid-area: position !important;
          align-self: center !important;
        }

        .top-holding-logo {
          width: 42px !important;
          height: 42px !important;
        }

        .top-holding-identity {
          grid-area: identity !important;
          min-width: 0 !important;
        }

        .top-holding-identity strong,
        .top-holding-identity span {
          display: block !important;
          max-width: 100% !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-stat.value {
          grid-area: value !important;
          text-align: right !important;
        }

        .top-holding-stat.allocation {
          grid-area: allocation !important;
          min-width: 0 !important;
        }

        .top-holding-stat.shares {
          grid-area: shares !important;
          text-align: right !important;
        }

        .top-holding-stat > span {
          font-size: 9px !important;
        }

        .top-holding-stat > strong {
          font-size: 11px !important;
          white-space: nowrap !important;
        }

        /* Holdings tools and rows */
        .holdings-heading {
          display: block !important;
        }

        .holdings-heading .table-tools {
          display: grid !important;
          width: 100% !important;
          grid-template-columns: 1fr 110px !important;
          gap: 8px !important;
          margin-top: 14px !important;
        }

        .holdings-heading .table-tools input,
        .holdings-heading .table-tools select {
          width: 100% !important;
          min-width: 0 !important;
        }

        .holdings-heading .clear-button {
          grid-column: 1 / -1 !important;
          width: 100% !important;
        }

        .holdings-card .table-scroll {
          width: 100% !important;
          overflow: visible !important;
        }

        .holdings-card table {
          width: 100% !important;
          min-width: 0 !important;
        }

        .holdings-card tbody tr {
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: minmax(0, 1fr) minmax(100px, .7fr) !important;
          grid-template-areas:
            "asset actions"
            "price shares"
            "value allocation" !important;
        }

        .company-name {
          max-width: 46vw !important;
        }

        /* Detail overlay */
        .category-detail-overlay {
          inset: 70px 8px 8px !important;
          max-width: calc(100% - 16px) !important;
        }

        .category-detail-body {
          grid-template-columns: 68px minmax(0, 1fr) !important;
          gap: 10px !important;
          padding: 12px !important;
        }

        .category-detail-name {
          grid-template-columns: 8px 45px minmax(0, 1fr) !important;
          gap: 6px !important;
        }

        .statusbar {
          display: grid !important;
          width: 100% !important;
          grid-template-columns: 1fr !important;
          gap: 6px !important;
          padding: 14px 16px !important;
        }

        /* Other tabs */
        .rebalancing-page,
        .market-map-page,
        .settings-page {
          width: 100% !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }

        .rebalancing-page *,
        .market-map-page *,
        .settings-page * {
          min-width: 0;
        }

        .rebalancing-grid,
        .market-map-grid,
        .settings-grid,
        .settings-layout {
          grid-template-columns: 1fr !important;
        }
      }

      @media (max-width: 390px) {
        .topbar {
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        .brand-copy > strong {
          font-size: 13px !important;
        }

        .brand-meta,
        .main-navigation button {
          font-size: 8.5px !important;
        }

        .page-wrap,
        .market-map-page-wrap,
        .settings-page-wrap {
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        .category-donut {
          max-width: calc(100vw - 48px) !important;
        }
      }


      /* ===== MOBILE HOLDINGS VERTICAL SCROLL FIX ===== */
      @media (max-width: 760px) {
        .app-shell,
        .page-wrap,
        .market-map-page-wrap,
        .settings-page-wrap {
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow-x: hidden !important;
          overflow-y: visible !important;
        }

        .holdings-card,
        .holdings-card-full {
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          contain: none !important;
        }

        .holdings-card .table-scroll {
          display: block !important;
          width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow-x: hidden !important;
          overflow-y: visible !important;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-y !important;
        }

        .holdings-card table,
        .holdings-card tbody {
          display: block !important;
          width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
        }

        .holdings-card tbody {
          display: grid !important;
          gap: 10px !important;
        }

        .holdings-card tbody tr {
          position: relative !important;
          display: grid !important;
          height: auto !important;
          min-height: 150px !important;
          max-height: none !important;
          overflow: visible !important;
        }

        .holdings-card tbody td {
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
        }

        .holdings-card tbody tr:last-child {
          margin-bottom: 18px !important;
        }

        body {
          overflow-y: auto !important;
          touch-action: pan-y !important;
          -webkit-overflow-scrolling: touch;
        }
      }


      /* ===== MOBILE COMPACT SUMMARY + MARKET MAP FILTER SCROLL ===== */
      @media (max-width: 760px) {
        /* Compact portfolio summary cards: swipe horizontally */
        .summary-grid {
          display: flex !important;
          width: 100% !important;
          gap: 10px !important;
          padding: 2px 1px 8px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          scroll-snap-type: x proximity;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x pan-y !important;
        }

        .summary-grid::-webkit-scrollbar {
          display: none !important;
        }

        .summary-card {
          display: flex !important;
          width: 178px !important;
          min-width: 178px !important;
          max-width: 178px !important;
          min-height: 92px !important;
          height: 92px !important;
          flex: 0 0 178px !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 9px !important;
          padding: 13px 12px !important;
          overflow: hidden !important;
          scroll-snap-align: start;
          border-radius: 16px !important;
        }

        .summary-card > div {
          min-width: 0 !important;
          flex: 1 1 auto !important;
        }

        .summary-card span {
          display: block !important;
          font-size: 9px !important;
          line-height: 1.15 !important;
          letter-spacing: .075em !important;
        }

        .summary-card strong {
          display: block !important;
          width: 100% !important;
          max-width: 100% !important;
          margin-top: 5px !important;
          overflow: hidden !important;
          font-size: 19px !important;
          line-height: 1.05 !important;
          letter-spacing: -.035em !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .summary-card small {
          display: block !important;
          max-width: 100% !important;
          margin-top: 5px !important;
          overflow: hidden !important;
          font-size: 9px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .summary-card > i,
        .summary-card .summary-icon-button {
          position: static !important;
          width: 37px !important;
          min-width: 37px !important;
          height: 37px !important;
          flex: 0 0 37px !important;
          margin: 0 !important;
          padding: 0 !important;
          font-size: 15px !important;
          transform: none !important;
          border-radius: 12px !important;
        }

        /* Market Map category buttons: full-width horizontal swipe area */
        .market-map-page .map-toolbar {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          flex-direction: column !important;
          align-items: stretch !important;
          gap: 10px !important;
          padding: 10px !important;
          overflow: visible !important;
        }

        .market-map-page .map-category-filter {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          gap: 7px !important;
          padding: 2px 2px 7px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          scroll-snap-type: x proximity;
          scrollbar-width: none !important;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x !important;
        }

        .market-map-page .map-category-filter::-webkit-scrollbar {
          display: none !important;
        }

        .market-map-page .map-category-filter button {
          display: inline-flex !important;
          width: auto !important;
          min-width: max-content !important;
          max-width: none !important;
          height: 38px !important;
          flex: 0 0 auto !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 5px !important;
          padding: 0 12px !important;
          overflow: visible !important;
          font-size: 10px !important;
          line-height: 1 !important;
          text-overflow: clip !important;
          white-space: nowrap !important;
          scroll-snap-align: start;
        }

        .market-map-page .map-category-filter button span {
          display: inline !important;
          margin-left: 1px !important;
          font-size: 9px !important;
          white-space: nowrap !important;
        }

        .market-map-page .map-view-toggle {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 4px !important;
          padding: 4px !important;
          overflow: hidden !important;
        }

        .market-map-page .map-view-toggle button {
          width: 100% !important;
          min-width: 0 !important;
          height: 36px !important;
          padding: 0 8px !important;
          overflow: hidden !important;
          font-size: 10px !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        /* Prevent the map hero statistics from colliding on narrow screens */
        .market-map-page .map-hero-stats {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          gap: 8px !important;
          margin-top: 14px !important;
          padding-bottom: 3px !important;
          overflow-x: auto !important;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
        }

        .market-map-page .map-hero-stats::-webkit-scrollbar {
          display: none !important;
        }

        .market-map-page .map-hero-stats > div {
          width: 132px !important;
          min-width: 132px !important;
          flex: 0 0 132px !important;
          padding: 11px 12px !important;
        }

        .market-map-page .map-hero-stats strong {
          font-size: 16px !important;
        }
      }

      @media (max-width: 390px) {
        .summary-card {
          width: 166px !important;
          min-width: 166px !important;
          max-width: 166px !important;
          flex-basis: 166px !important;
        }

        .summary-card strong {
          font-size: 18px !important;
        }

        .market-map-page .map-category-filter button {
          height: 36px !important;
          padding: 0 10px !important;
          font-size: 9.5px !important;
        }
      }


      /* ===== MOBILE STATUS BAR FULL VISIBILITY FIX ===== */
      @media (max-width: 760px) {
        .statusbar {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          grid-template-columns: 1fr !important;
          gap: 8px !important;
          margin: 14px 0 0 !important;
          padding: 15px 16px calc(15px + env(safe-area-inset-bottom)) !important;
          overflow: visible !important;
          border-radius: 16px !important;
          white-space: normal !important;
        }

        .statusbar span {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          align-items: center !important;
          gap: 7px !important;
          overflow: visible !important;
          font-size: 10px !important;
          line-height: 1.35 !important;
          text-overflow: clip !important;
          white-space: normal !important;
          overflow-wrap: anywhere !important;
          word-break: keep-all !important;
        }

        .statusbar span:first-child {
          font-weight: 800 !important;
        }

        .statusbar span i {
          width: 8px !important;
          height: 8px !important;
          min-width: 8px !important;
          flex: 0 0 8px !important;
        }

        .page-wrap {
          padding-bottom: calc(28px + env(safe-area-inset-bottom)) !important;
        }

        .holdings-card-full {
          margin-bottom: 0 !important;
        }
      }


      /* ===== MOBILE SUMMARY ROWS + DONUT TOTAL FULL-VALUE FIX ===== */
      @media (max-width: 760px) {
        /* Three compact full-width rows instead of horizontal cards */
        .summary-grid {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: 1fr !important;
          gap: 8px !important;
          padding: 0 !important;
          overflow: visible !important;
        }

        .summary-card {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          height: auto !important;
          min-height: 70px !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          align-items: center !important;
          gap: 10px !important;
          padding: 11px 13px !important;
          overflow: hidden !important;
          border-radius: 14px !important;
        }

        .summary-card > div {
          display: grid !important;
          min-width: 0 !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          grid-template-areas:
            "label value"
            "note note" !important;
          align-items: baseline !important;
          gap: 3px 10px !important;
        }

        .summary-card span {
          grid-area: label !important;
          min-width: 0 !important;
          font-size: 9px !important;
          font-weight: 900 !important;
          line-height: 1.15 !important;
          letter-spacing: .075em !important;
          white-space: nowrap !important;
        }

        .summary-card strong {
          grid-area: value !important;
          display: block !important;
          width: auto !important;
          max-width: none !important;
          margin: 0 !important;
          overflow: visible !important;
          font-size: clamp(17px, 5.2vw, 22px) !important;
          line-height: 1.05 !important;
          letter-spacing: -.035em !important;
          text-align: right !important;
          text-overflow: clip !important;
          white-space: nowrap !important;
        }

        .summary-card small {
          grid-area: note !important;
          display: block !important;
          max-width: 100% !important;
          margin: 0 !important;
          overflow: hidden !important;
          font-size: 9px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .summary-card > i,
        .summary-card .summary-icon-button {
          position: static !important;
          width: 34px !important;
          min-width: 34px !important;
          height: 34px !important;
          flex: 0 0 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          font-size: 14px !important;
          transform: none !important;
          border-radius: 11px !important;
        }

        /* Donut center value must show in full */
        .category-donut-center {
          inset: 25% !important;
          padding: 8px !important;
          overflow: visible !important;
        }

        .category-donut-center span {
          font-size: 9px !important;
          line-height: 1 !important;
        }

        .category-donut-center strong {
          display: block !important;
          width: 100% !important;
          max-width: 100% !important;
          margin-top: 5px !important;
          overflow: visible !important;
          font-size: clamp(13px, 4vw, 18px) !important;
          line-height: 1.05 !important;
          letter-spacing: -.045em !important;
          text-align: center !important;
          text-overflow: clip !important;
          white-space: nowrap !important;
          transform: scale(.92) !important;
          transform-origin: center !important;
        }

        .category-donut::after {
          inset: 22% !important;
        }
      }

      @media (max-width: 390px) {
        .summary-card {
          min-height: 66px !important;
          padding: 10px 11px !important;
        }

        .summary-card strong {
          font-size: clamp(16px, 5vw, 20px) !important;
        }

        .category-donut-center strong {
          font-size: clamp(12px, 3.8vw, 16px) !important;
          transform: scale(.88) !important;
        }
      }


      /* ===== Average Cost + P/L vs Average Cost ===== */
      .top-holdings-columns,
      .top-holding-row {
        grid-template-columns: 82px minmax(105px, 1fr) 108px 106px 88px 68px !important;
        gap: 10px !important;
      }

      .top-holding-stat.cost > small {
        display: block;
        margin-top: 4px;
        font-size: 10px;
        font-weight: 900;
        line-height: 1;
        white-space: nowrap;
      }

      .cost-return.up { color: #15803d !important; }
      .cost-return.down { color: #b91c1c !important; }
      .cost-return.neutral { color: #303846 !important; }

      .holdings-card table {
        min-width: 1120px !important;
      }

      .avg-cost-column,
      .cost-return-column {
        min-width: 98px;
      }

      .avg-cost-column > b,
      .cost-return-column > b {
        display: block;
        color: #4b1026;
        font-size: 12px;
        font-weight: 900;
        white-space: nowrap;
      }

      .avg-cost-column > span:not(.mobile-field-label),
      .cost-return-column > span:not(.mobile-field-label) {
        display: block;
        margin-top: 4px;
        color: #303846;
        font-size: 9px;
        font-weight: 700;
        white-space: nowrap;
      }

      @media (max-width: 1180px) and (min-width: 761px) {
        .top-holdings-columns,
        .top-holding-row {
          grid-template-columns: 74px minmax(96px, 1fr) 98px 96px 80px 62px !important;
          gap: 8px !important;
        }
        .top-holding-stat > strong { font-size: 11px !important; }
        .top-holding-stat.cost > small { font-size: 9px !important; }
      }

      @media (max-width: 760px) {
        .top-holding-row {
          min-height: 138px !important;
          grid-template-columns: 64px minmax(0, 1fr) minmax(76px, auto) !important;
          grid-template-areas:
            "position identity value"
            "position cost shares"
            "position allocation allocation" !important;
          gap: 7px 10px !important;
        }

        .top-holding-stat.cost {
          grid-area: cost !important;
          align-items: flex-start !important;
          text-align: left !important;
        }

        .top-holding-stat.cost > strong { font-size: 11px !important; }
        .top-holding-stat.cost > small { margin-top: 3px !important; font-size: 9px !important; }

        .top-holding-stat.allocation {
          grid-area: allocation !important;
          width: 100% !important;
          align-items: flex-start !important;
          text-align: left !important;
        }

        .top-holding-stat.allocation > i {
          width: min(150px, 100%) !important;
        }

        .holdings-card table {
          min-width: 0 !important;
        }

        .holdings-card tbody tr {
          min-height: 188px !important;
          grid-template-columns: minmax(0, 1.25fr) minmax(82px, .72fr) minmax(82px, .72fr) !important;
          grid-template-areas:
            "asset asset actions"
            "price avgcost pnl"
            "shares value allocation" !important;
          gap: 12px 10px !important;
          align-items: start !important;
        }

        .avg-cost-column { grid-area: avgcost !important; }
        .cost-return-column { grid-area: pnl !important; }

        .avg-cost-column,
        .cost-return-column {
          display: flex !important;
          min-width: 0 !important;
          flex-direction: column !important;
          align-items: flex-start !important;
        }

        .avg-cost-column > b,
        .cost-return-column > b {
          max-width: 100% !important;
          overflow: hidden !important;
          font-size: 12px !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .avg-cost-column > span:not(.mobile-field-label),
        .cost-return-column > span:not(.mobile-field-label) {
          font-size: 9px !important;
        }
      }

      @media (max-width: 390px) {
        .holdings-card tbody tr {
          min-height: 198px !important;
          grid-template-columns: minmax(0, 1.15fr) minmax(74px, .72fr) minmax(74px, .72fr) !important;
          gap: 11px 8px !important;
        }

        .top-holding-row {
          min-height: 142px !important;
          grid-template-columns: 58px minmax(0, 1fr) minmax(70px, auto) !important;
        }
      }


      /* ===== Top Holdings rank badge ===== */
      .top-holding-position > span {
        display: grid !important;
        width: 28px !important;
        height: 28px !important;
        min-width: 28px !important;
        place-items: center !important;
        border-radius: 999px !important;
        font-size: 12px !important;
        font-weight: 900 !important;
        line-height: 1 !important;
      }

      @media (max-width: 760px) {
        .top-holding-position > span {
          width: 26px !important;
          height: 26px !important;
          min-width: 26px !important;
          font-size: 11px !important;
        }
      }


      /* ===== iOS/Android edit modal zoom prevention =====
         Mobile Safari auto-zooms focused inputs when font-size is below 16px.
         Keep edit/add form controls at 16px and prevent modal layout scaling. */
      @media (max-width: 760px) {
        .modal-card input,
        .modal-card select,
        .modal-card textarea,
        .stock-modal input,
        .stock-modal select,
        .stock-modal textarea,
        input[type="number"],
        input[type="text"],
        select,
        textarea {
          font-size: 16px !important;
          line-height: 1.25 !important;
        }

        .modal-card,
        .stock-modal {
          width: calc(100vw - 24px) !important;
          max-width: 520px !important;
          max-height: calc(100dvh - 28px) !important;
          overflow-y: auto !important;
          -webkit-overflow-scrolling: touch !important;
          transform: none !important;
        }

        .modal-backdrop,
        .modal-overlay {
          align-items: center !important;
          justify-content: center !important;
          padding: 14px 12px !important;
          overflow: hidden !important;
        }

        .modal-card button,
        .stock-modal button {
          min-height: 44px !important;
          font-size: 14px !important;
        }
      }


      /* ===== Mobile Top 5 spacing repair ===== */
      @media (max-width: 760px) {
        .top-holding-row {
          min-height: 154px !important;
          grid-template-columns: 56px minmax(0, 1fr) minmax(82px, auto) !important;
          grid-template-areas:
            "position identity value"
            "position cost shares"
            "position allocation allocation" !important;
          column-gap: 14px !important;
          row-gap: 10px !important;
          padding: 14px 12px !important;
          align-items: start !important;
        }

        .top-holding-position {
          grid-area: position !important;
          display: flex !important;
          width: 56px !important;
          min-width: 56px !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: flex-start !important;
          gap: 9px !important;
          padding-top: 1px !important;
        }

        .top-holding-position > span {
          position: static !important;
          width: 26px !important;
          min-width: 26px !important;
          height: 26px !important;
          margin: 0 !important;
          flex: 0 0 26px !important;
        }

        .top-holding-position .top-holding-logo {
          position: static !important;
          width: 44px !important;
          min-width: 44px !important;
          height: 44px !important;
          margin: 0 !important;
          flex: 0 0 44px !important;
          transform: none !important;
        }

        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          width: 100% !important;
          height: 100% !important;
          max-width: 44px !important;
          max-height: 44px !important;
          object-fit: contain !important;
        }

        .top-holding-identity {
          grid-area: identity !important;
          min-width: 0 !important;
          padding-left: 2px !important;
          align-self: start !important;
        }

        .top-holding-identity strong {
          display: block !important;
          max-width: 100% !important;
          overflow: hidden !important;
          font-size: 14px !important;
          line-height: 1.15 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-identity span {
          display: block !important;
          max-width: 100% !important;
          margin-top: 4px !important;
          overflow: hidden !important;
          font-size: 10px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-stat.value {
          grid-area: value !important;
          min-width: 82px !important;
          align-items: flex-end !important;
          text-align: right !important;
        }

        .top-holding-stat.cost {
          grid-area: cost !important;
          min-width: 0 !important;
          padding-left: 2px !important;
          align-items: flex-start !important;
          text-align: left !important;
        }

        .top-holding-stat.shares {
          grid-area: shares !important;
          min-width: 82px !important;
          align-items: flex-end !important;
          text-align: right !important;
        }

        .top-holding-stat.allocation {
          grid-area: allocation !important;
          width: 100% !important;
          min-width: 0 !important;
          padding-left: 2px !important;
          align-items: flex-start !important;
          text-align: left !important;
        }

        .top-holding-stat > span {
          font-size: 9px !important;
          line-height: 1.1 !important;
        }

        .top-holding-stat > strong {
          max-width: 100% !important;
          overflow: hidden !important;
          font-size: 11px !important;
          line-height: 1.15 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }
      }

      @media (max-width: 390px) {
        .top-holding-row {
          min-height: 158px !important;
          grid-template-columns: 52px minmax(0, 1fr) minmax(76px, auto) !important;
          column-gap: 11px !important;
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        .top-holding-position {
          width: 52px !important;
          min-width: 52px !important;
        }

        .top-holding-position .top-holding-logo {
          width: 40px !important;
          min-width: 40px !important;
          height: 40px !important;
          flex-basis: 40px !important;
        }

        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          max-width: 40px !important;
          max-height: 40px !important;
        }
      }


      /* ===== Mobile Holdings shares typography normalization ===== */
      @media (max-width: 760px) {
        .holdings-card .shares-column .shares-input,
        .holdings-card .shares-column input[type="number"] {
          font-size: 12px !important;
          font-weight: 900 !important;
          line-height: 1.2 !important;
          letter-spacing: 0 !important;
        }

        .holdings-card .shares-column > b,
        .holdings-card .shares-column > strong {
          font-size: 12px !important;
          font-weight: 900 !important;
          line-height: 1.2 !important;
        }
      }

      @media (max-width: 390px) {
        .holdings-card .shares-column .shares-input,
        .holdings-card .shares-column input[type="number"],
        .holdings-card .shares-column > b,
        .holdings-card .shares-column > strong {
          font-size: 11px !important;
        }
      }


      /* ===== Mobile Top 5: rank + ticker top alignment ===== */
      @media (max-width: 760px) {
        .top-holding-row {
          align-items: start !important;
        }

        .top-holding-position {
          align-self: start !important;
          justify-content: flex-start !important;
          padding-top: 0 !important;
        }

        .top-holding-position > span {
          align-self: center !important;
          margin-top: 0 !important;
        }

        .top-holding-identity {
          align-self: start !important;
          padding-top: 0 !important;
          margin-top: 0 !important;
        }

        .top-holding-identity strong {
          margin-top: 0 !important;
          line-height: 26px !important;
        }

        /* Rank number and ticker begin on the same visual top line.
           Logo remains below the rank number in its own column. */
        .top-holding-position .top-holding-logo {
          margin-top: 9px !important;
        }
      }


      /* ===== Mobile Top 5: exact rank/logo top-edge alignment ===== */
      @media (max-width: 760px) {
        .top-holding-position {
          display: grid !important;
          grid-template-rows: 44px 26px !important;
          align-items: start !important;
          justify-items: center !important;
          gap: 8px !important;
          padding-top: 0 !important;
        }

        .top-holding-position .top-holding-logo {
          grid-row: 1 !important;
          margin: 0 !important;
          align-self: start !important;
        }

        .top-holding-position > span {
          grid-row: 1 !important;
          align-self: start !important;
          margin-top: 9px !important;
          z-index: 2 !important;
        }

        .top-holding-identity {
          align-self: start !important;
          padding-top: 9px !important;
          margin-top: 0 !important;
        }

        .top-holding-identity strong {
          line-height: 1.15 !important;
        }
      }


      /* ===== FINAL mobile Top 5 collision fix =====
         Rank and logo sit side-by-side in their own reserved column.
         Ticker/company text starts only after that reserved space. */
      @media (max-width: 760px) {
        .top-holding-row {
          min-height: 144px !important;
          grid-template-columns: 92px minmax(0, 1fr) 82px !important;
          grid-template-areas:
            "position identity value"
            "position cost shares"
            "position allocation allocation" !important;
          column-gap: 14px !important;
          row-gap: 10px !important;
          padding: 14px 12px !important;
          align-items: start !important;
          overflow: hidden !important;
        }

        .top-holding-position {
          grid-area: position !important;
          display: grid !important;
          width: 92px !important;
          min-width: 92px !important;
          height: auto !important;
          grid-template-columns: 28px 44px !important;
          grid-template-rows: 44px !important;
          column-gap: 10px !important;
          align-items: start !important;
          justify-items: start !important;
          align-self: start !important;
          padding: 0 !important;
          margin: 0 !important;
        }

        .top-holding-position > span {
          position: static !important;
          grid-column: 1 !important;
          grid-row: 1 !important;
          display: grid !important;
          width: 26px !important;
          min-width: 26px !important;
          height: 26px !important;
          margin: 0 !important;
          padding: 0 !important;
          place-items: center !important;
          align-self: start !important;
          transform: none !important;
          z-index: 1 !important;
        }

        .top-holding-position .top-holding-logo {
          position: static !important;
          grid-column: 2 !important;
          grid-row: 1 !important;
          width: 44px !important;
          min-width: 44px !important;
          height: 44px !important;
          margin: 0 !important;
          padding: 0 !important;
          align-self: start !important;
          transform: none !important;
          overflow: hidden !important;
          z-index: 1 !important;
        }

        .top-holding-position .top-holding-logo :global(.company-mark),
        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          display: block !important;
          width: 44px !important;
          max-width: 44px !important;
          height: 44px !important;
          max-height: 44px !important;
          margin: 0 !important;
          object-fit: contain !important;
          transform: none !important;
        }

        .top-holding-identity {
          grid-area: identity !important;
          min-width: 0 !important;
          align-self: start !important;
          padding: 0 !important;
          margin: 0 !important;
          overflow: hidden !important;
        }

        .top-holding-identity strong {
          display: block !important;
          max-width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          font-size: 14px !important;
          line-height: 26px !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-identity span {
          display: block !important;
          max-width: 100% !important;
          margin-top: 3px !important;
          overflow: hidden !important;
          font-size: 10px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-stat.value,
        .top-holding-stat.shares {
          min-width: 82px !important;
          max-width: 82px !important;
        }
      }

      @media (max-width: 390px) {
        .top-holding-row {
          grid-template-columns: 84px minmax(0, 1fr) 74px !important;
          column-gap: 10px !important;
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        .top-holding-position {
          width: 84px !important;
          min-width: 84px !important;
          grid-template-columns: 26px 40px !important;
          grid-template-rows: 40px !important;
          column-gap: 8px !important;
        }

        .top-holding-position .top-holding-logo,
        .top-holding-position .top-holding-logo :global(.company-mark),
        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          width: 40px !important;
          min-width: 40px !important;
          max-width: 40px !important;
          height: 40px !important;
          max-height: 40px !important;
        }

        .top-holding-stat.value,
        .top-holding-stat.shares {
          min-width: 74px !important;
          max-width: 74px !important;
        }
      }


      /* ===== Mobile Top 5 exact composition =====
         Row 1: rank number and ticker share the same top edge.
         Row 2: company logo sits directly below the rank number.
         Text keeps a separate column so no overlap can occur. */
      @media (max-width: 760px) {
        .top-holding-row {
          min-height: 156px !important;
          grid-template-columns: 58px minmax(0, 1fr) 82px !important;
          grid-template-areas:
            "position identity value"
            "position cost shares"
            "position allocation allocation" !important;
          column-gap: 14px !important;
          row-gap: 10px !important;
          padding: 14px 12px !important;
          align-items: start !important;
        }

        .top-holding-position {
          grid-area: position !important;
          display: flex !important;
          width: 58px !important;
          min-width: 58px !important;
          height: auto !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: flex-start !important;
          gap: 8px !important;
          padding: 0 !important;
          margin: 0 !important;
          align-self: start !important;
        }

        .top-holding-position > span {
          position: static !important;
          display: grid !important;
          width: 26px !important;
          min-width: 26px !important;
          height: 26px !important;
          margin: 0 !important;
          padding: 0 !important;
          place-items: center !important;
          align-self: center !important;
          transform: none !important;
          line-height: 1 !important;
        }

        .top-holding-position .top-holding-logo {
          position: static !important;
          display: block !important;
          width: 44px !important;
          min-width: 44px !important;
          height: 44px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
          align-self: center !important;
          overflow: hidden !important;
        }

        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          display: block !important;
          width: 44px !important;
          max-width: 44px !important;
          height: 44px !important;
          max-height: 44px !important;
          margin: 0 !important;
          object-fit: contain !important;
        }

        .top-holding-identity {
          grid-area: identity !important;
          min-width: 0 !important;
          align-self: start !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
        }

        .top-holding-identity strong {
          display: block !important;
          max-width: 100% !important;
          height: 26px !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          font-size: 14px !important;
          line-height: 26px !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        .top-holding-identity span {
          display: block !important;
          max-width: 100% !important;
          margin-top: 3px !important;
          overflow: hidden !important;
          font-size: 10px !important;
          line-height: 1.2 !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }
      }

      @media (max-width: 390px) {
        .top-holding-row {
          grid-template-columns: 54px minmax(0, 1fr) 74px !important;
          column-gap: 10px !important;
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        .top-holding-position {
          width: 54px !important;
          min-width: 54px !important;
        }

        .top-holding-position .top-holding-logo,
        .top-holding-position .top-holding-logo img,
        .top-holding-position .top-holding-logo svg {
          width: 40px !important;
          min-width: 40px !important;
          max-width: 40px !important;
          height: 40px !important;
          max-height: 40px !important;
        }
      }


      /* ===== Average cost: KRW input / USD storage-display ===== */
      .krw-cost-input {
        position: relative;
        display: flex;
        width: 100%;
        align-items: center;
      }

      .krw-cost-input > span {
        position: absolute;
        z-index: 2;
        left: 12px;
        color: #861f41;
        font-size: 13px;
        font-weight: 900;
        pointer-events: none;
      }

      .krw-cost-input > input {
        width: 100%;
        padding-left: 30px !important;
      }

      .cost-conversion-preview {
        display: block;
        margin-top: 5px;
        color: #303846;
        font-size: 9px;
        font-weight: 700;
        line-height: 1.3;
      }

      @media (max-width: 760px) {
        .krw-cost-input > span {
          left: 12px;
          font-size: 15px;
        }

        .krw-cost-input > input {
          padding-left: 31px !important;
          font-size: 16px !important;
        }

        .cost-conversion-preview {
          font-size: 9px !important;
        }
      }


      /* ===== Total Return summary ===== */
      @media (max-width: 760px) {
        .summary-grid {
          grid-template-columns: 1fr !important;
          gap: 7px !important;
        }

        .summary-card {
          min-height: 64px !important;
          padding-top: 9px !important;
          padding-bottom: 9px !important;
        }

        .summary-card strong {
          font-size: clamp(16px, 4.8vw, 20px) !important;
        }

        .summary-card small {
          font-size: 9px !important;
        }
      }

      /* Final summary alignment + Total Return profit toggle */
      .summary-card {
        position: relative !important;
        display: flex !important;
        align-items: center !important;
      }
      .summary-card > div:not(.summary-icon-wrap):not(.total-return-popover),
      .summary-copy {
        display: flex !important;
        min-width: 0 !important;
        flex-direction: column !important;
        justify-content: center !important;
      }
      .summary-card strong, .summary-copy strong {
        margin-top: 2px !important;
        margin-bottom: 2px !important;
        line-height: 1.05 !important;
      }
      .total-return-card { overflow: visible !important; }
      .summary-icon-wrap { position: relative; display: grid; flex: 0 0 auto; place-items: center; }
      .total-return-trigger { border: 0; cursor: pointer; font: inherit; -webkit-tap-highlight-color: transparent; }
      .total-return-popover {
        position: absolute; z-index: 80; top: calc(100% + 9px); left: 0;
        display: flex; width: max-content; min-width: 150px; padding: 10px 12px;
        flex-direction: column; gap: 4px; border: 1px solid rgba(134,31,65,.14);
        border-radius: 13px; background: #f4efe7; box-shadow: 0 12px 28px rgba(42,24,32,.18);
      }
      .total-return-popover span { color:#861f41; font-size:9px; font-weight:900; letter-spacing:.12em; }
      .total-return-popover strong { font-size:12px !important; font-weight:900; white-space:nowrap; }
      .total-return-popover .previous-close-reference-time {
        color:#303846; font-size:10px; font-weight:700;
        letter-spacing:0; white-space:nowrap; line-height:1.4;
      }
      .profit-positive { color:#15803d !important; }
      .profit-negative { color:#b91c1c !important; }

      @media (max-width:760px) {
        .summary-card { min-height:64px !important; padding-top:8px !important; padding-bottom:8px !important; align-items:center !important; }
        .summary-card > div:not(.summary-icon-wrap):not(.total-return-popover), .summary-copy {
          align-self:stretch !important; justify-content:center !important;
        }
        .summary-card strong, .summary-copy strong { line-height:1 !important; }
        .total-return-popover { top:50%; left:calc(100% + 9px); min-width:140px; transform:translateY(-50%); }
      }


      /* ===== FINAL summary-card layout: label left / result right / identical orange icons ===== */
      .summary-grid .summary-card {
        position: relative !important;
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 38px !important;
        align-items: center !important;
        gap: 14px !important;
        overflow: visible !important;
      }

      .summary-grid .summary-card > div:first-child,
      .summary-grid .summary-card .summary-copy {
        display: grid !important;
        min-width: 0 !important;
        width: 100% !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        grid-template-areas:
          "label value"
          "note value" !important;
        align-items: center !important;
        column-gap: 14px !important;
        row-gap: 3px !important;
      }

      .summary-grid .summary-card > div:first-child > span,
      .summary-grid .summary-card .summary-copy > span {
        grid-area: label !important;
        margin: 0 !important;
        align-self: end !important;
        text-align: left !important;
        white-space: nowrap !important;
      }

      .summary-grid .summary-card > div:first-child > strong,
      .summary-grid .summary-card .summary-copy > strong {
        grid-area: value !important;
        margin: 0 !important;
        align-self: center !important;
        justify-self: end !important;
        text-align: right !important;
        line-height: 1 !important;
        white-space: nowrap !important;
      }

      .summary-grid .summary-card > div:first-child > small,
      .summary-grid .summary-card .summary-copy > small {
        grid-area: note !important;
        margin: 0 !important;
        align-self: start !important;
        text-align: left !important;
        white-space: nowrap !important;
      }

      /* Every icon: exact same size, shape and Hermes-orange treatment */
      .summary-grid .summary-card > i,
      .summary-grid .summary-card .summary-icon-button,
      .summary-grid .summary-card .total-return-trigger {
        position: static !important;
        display: grid !important;
        width: 38px !important;
        min-width: 38px !important;
        height: 38px !important;
        min-height: 38px !important;
        margin: 0 !important;
        padding: 0 !important;
        place-items: center !important;
        align-self: center !important;
        justify-self: end !important;
        border: 0 !important;
        border-radius: 12px !important;
        background: #E87722 !important;
        box-shadow: none !important;
        color: #fff7ed !important;
        font-size: 16px !important;
        font-style: normal !important;
        font-weight: 900 !important;
        line-height: 1 !important;
        transform: none !important;
      }

      .summary-grid .summary-icon-wrap {
        position: relative !important;
        display: grid !important;
        width: 38px !important;
        height: 38px !important;
        place-items: center !important;
        align-self: center !important;
        justify-self: end !important;
      }

      .summary-grid .total-return-card {
        overflow: visible !important;
      }

      .summary-grid .total-return-popover {
        left: auto !important;
        right: 0 !important;
        top: calc(100% + 10px) !important;
        transform: none !important;
      }

      @media (max-width: 760px) {
        .summary-grid .summary-card {
          min-height: 64px !important;
          grid-template-columns: minmax(0, 1fr) 34px !important;
          gap: 10px !important;
          padding: 9px 11px !important;
        }

        .summary-grid .summary-card > div:first-child,
        .summary-grid .summary-card .summary-copy {
          column-gap: 9px !important;
          row-gap: 2px !important;
        }

        .summary-grid .summary-card > div:first-child > strong,
        .summary-grid .summary-card .summary-copy > strong {
          font-size: clamp(16px, 4.8vw, 20px) !important;
        }

        .summary-grid .summary-card > i,
        .summary-grid .summary-card .summary-icon-button,
        .summary-grid .summary-card .total-return-trigger,
        .summary-grid .summary-icon-wrap {
          width: 34px !important;
          min-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
        }

        .summary-grid .summary-card > i,
        .summary-grid .summary-card .summary-icon-button,
        .summary-grid .summary-card .total-return-trigger {
          border-radius: 11px !important;
          font-size: 14px !important;
        }

        .summary-grid .total-return-popover {
          right: 0 !important;
          top: calc(100% + 8px) !important;
          min-width: 145px !important;
        }
      }


      /* ===== Mobile summary icon column: exact right-edge alignment ===== */
      @media (max-width: 760px) {
        .summary-grid .summary-card {
          grid-template-columns: minmax(0, 1fr) 34px !important;
        }

        .summary-grid .summary-card > i,
        .summary-grid .summary-card > .summary-icon-button {
          grid-column: 2 !important;
          justify-self: end !important;
          align-self: center !important;
          margin: 0 !important;
        }

        .summary-grid .total-return-card > .summary-icon-wrap {
          grid-column: 2 !important;
          grid-row: 1 !important;
          justify-self: end !important;
          align-self: center !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
        }

        .summary-grid .total-return-card .total-return-trigger {
          position: static !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          justify-self: end !important;
          transform: none !important;
        }

        .summary-grid .total-return-card > .summary-copy {
          grid-column: 1 !important;
          min-width: 0 !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
        }
      }


      /* ===== FINAL MOBILE RIGHT ICON RAIL — preserve all completed dashboard features ===== */
      @media (max-width: 760px) {
        .summary-grid .summary-card {
          position: relative !important;
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) 34px !important;
          column-gap: 10px !important;
          align-items: center !important;
          padding-left: 11px !important;
          padding-right: 11px !important;
        }

        /* Every summary card reserves exactly the same 34px right rail. */
        .summary-grid .summary-card > i,
        .summary-grid .summary-card > .summary-icon,
        .summary-grid .summary-card > .summary-icon-button,
        .summary-grid .summary-card > .summary-icon-wrap {
          grid-column: 2 !important;
          grid-row: 1 !important;
          align-self: center !important;
          justify-self: end !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          inset: auto !important;
          transform: none !important;
        }

        /* TOTAL RETURN has a wrapper: keep wrapper and button on the same rail. */
        .summary-grid .total-return-card > .summary-icon-wrap {
          position: relative !important;
          display: grid !important;
          place-items: center !important;
        }

        .summary-grid .total-return-card .total-return-trigger {
          position: static !important;
          display: grid !important;
          place-items: center !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
        }

        /* Text/result always stays in column 1 and cannot push the icon rail. */
        .summary-grid .summary-card > div:first-child:not(.summary-icon-wrap),
        .summary-grid .summary-card > .summary-copy {
          grid-column: 1 !important;
          grid-row: 1 !important;
          min-width: 0 !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        /* Popover remains anchored to Total Return icon without affecting alignment. */
        .summary-grid .total-return-popover {
          position: absolute !important;
          right: 0 !important;
          left: auto !important;
          top: calc(100% + 8px) !important;
          transform: none !important;
        }
      }


      /* ===== MOBILE SUMMARY ICON ABSOLUTE RAIL FIX =====
         All four icons use the same physical right/top coordinates,
         independent of each card's internal DOM structure. */
      @media (max-width: 760px) {
        .summary-grid .summary-card {
          position: relative !important;
          display: block !important;
          min-height: 64px !important;
          padding: 9px 56px 9px 11px !important;
          overflow: visible !important;
        }

        .summary-grid .summary-card > div:first-child:not(.summary-icon-wrap),
        .summary-grid .summary-card > .summary-copy {
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          grid-template-areas:
            "label value"
            "note value" !important;
          align-items: center !important;
          column-gap: 9px !important;
          row-gap: 2px !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        /* Normal SummaryCard icons */
        .summary-grid .summary-card > i,
        .summary-grid .summary-card > .summary-icon-button {
          position: absolute !important;
          top: 50% !important;
          right: 11px !important;
          left: auto !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: translateY(-50%) !important;
          display: grid !important;
          place-items: center !important;
        }

        /* TOTAL RETURN wrapper gets the exact same anchor */
        .summary-grid .total-return-card > .summary-icon-wrap {
          position: absolute !important;
          top: 50% !important;
          right: 11px !important;
          left: auto !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: translateY(-50%) !important;
          display: grid !important;
          place-items: center !important;
        }

        .summary-grid .total-return-card .total-return-trigger {
          position: static !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
          display: grid !important;
          place-items: center !important;
        }

        /* All four icons: same orange, same shape, same type size */
        .summary-grid .summary-card > i,
        .summary-grid .summary-card > .summary-icon-button,
        .summary-grid .total-return-card .total-return-trigger {
          border: 0 !important;
          border-radius: 11px !important;
          background: #E87722 !important;
          color: #fff7ed !important;
          box-shadow: none !important;
          font-size: 14px !important;
          font-style: normal !important;
          font-weight: 900 !important;
          line-height: 1 !important;
        }

        /* Popover is positioned from the fixed Total Return icon wrapper only. */
        .summary-grid .total-return-popover {
          position: absolute !important;
          top: calc(100% + 8px) !important;
          right: 0 !important;
          left: auto !important;
          transform: none !important;
        }
      }


      /* ===== TRUE FINAL MOBILE SUMMARY LAYOUT =====
         All four cards now share the same DOM structure:
         .summary-content + .summary-icon-slot
         This removes the Total Return alignment exception entirely. */
      @media (max-width: 760px) {
        .summary-grid {
          display: grid !important;
          grid-template-columns: 1fr !important;
          gap: 7px !important;
        }

        .summary-grid .summary-card {
          position: relative !important;
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 68px !important;
          min-height: 68px !important;
          max-height: 68px !important;
          grid-template-columns: minmax(0, 1fr) 36px !important;
          align-items: stretch !important;
          column-gap: 10px !important;
          padding: 0 11px 0 12px !important;
          overflow: visible !important;
        }

        /* Left label/note + vertically-centered right result */
        .summary-grid .summary-card > .summary-content {
          position: static !important;
          display: grid !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 68px !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          grid-template-rows: 1fr 1fr !important;
          grid-template-areas:
            "label value"
            "note value" !important;
          align-items: stretch !important;
          column-gap: 10px !important;
          row-gap: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        .summary-grid .summary-card > .summary-content > span {
          grid-area: label !important;
          display: flex !important;
          margin: 0 !important;
          padding: 0 !important;
          align-items: flex-end !important;
          justify-content: flex-start !important;
          padding-bottom: 2px !important;
          font-size: 10px !important;
          line-height: 1 !important;
          text-align: left !important;
          white-space: nowrap !important;
        }

        .summary-grid .summary-card > .summary-content > small {
          grid-area: note !important;
          display: flex !important;
          margin: 0 !important;
          padding: 2px 0 0 !important;
          align-items: flex-start !important;
          justify-content: flex-start !important;
          font-size: 9px !important;
          line-height: 1.1 !important;
          text-align: left !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
        }

        .summary-grid .summary-card > .summary-content > strong {
          grid-area: value !important;
          display: flex !important;
          width: auto !important;
          max-width: none !important;
          height: 68px !important;
          margin: 0 !important;
          padding: 0 !important;
          align-items: center !important;
          justify-content: flex-end !important;
          align-self: stretch !important;
          justify-self: end !important;
          overflow: visible !important;
          font-size: clamp(16px, 4.8vw, 20px) !important;
          line-height: 1 !important;
          letter-spacing: -.025em !important;
          text-align: right !important;
          text-overflow: clip !important;
          white-space: nowrap !important;
        }

        /* One identical physical icon rail for every card */
        .summary-grid .summary-card > .summary-icon-slot {
          position: relative !important;
          display: grid !important;
          width: 36px !important;
          min-width: 36px !important;
          max-width: 36px !important;
          height: 68px !important;
          min-height: 68px !important;
          max-height: 68px !important;
          margin: 0 !important;
          padding: 0 !important;
          place-items: center !important;
          align-self: stretch !important;
          justify-self: end !important;
          transform: none !important;
        }

        .summary-grid .summary-card > .summary-icon-slot > i,
        .summary-grid .summary-card > .summary-icon-slot > .summary-icon-button {
          position: static !important;
          display: grid !important;
          width: 34px !important;
          min-width: 34px !important;
          max-width: 34px !important;
          height: 34px !important;
          min-height: 34px !important;
          max-height: 34px !important;
          margin: 0 !important;
          padding: 0 !important;
          place-items: center !important;
          border: 0 !important;
          border-radius: 11px !important;
          background: #E87722 !important;
          color: #fff7ed !important;
          box-shadow: none !important;
          font-size: 14px !important;
          font-style: normal !important;
          font-weight: 900 !important;
          line-height: 1 !important;
          transform: none !important;
        }

        /* Total Return popup stays attached to its icon slot without changing layout */
        .summary-grid .total-return-card > .total-return-icon-slot {
          position: relative !important;
        }

        .summary-grid .total-return-popover {
          position: absolute !important;
          z-index: 100 !important;
          top: calc(50% + 25px) !important;
          right: 0 !important;
          left: auto !important;
          transform: none !important;
        }
      }


      /* ===== Holdings typography normalization: Price / Avg Cost / Value only =====
         Top Holdings is intentionally untouched.
         P/L vs Avg keeps its existing green/red styling. */
      .holdings-card .price-column > b,
      .holdings-card .avg-cost-column > b,
      .holdings-card .value-column > b {
        color: #4b1026 !important;
        font-size: 12px !important;
        font-weight: 900 !important;
        line-height: 1.2 !important;
        letter-spacing: 0 !important;
        white-space: nowrap !important;
      }

      @media (max-width: 760px) {
        .holdings-card .price-column > b,
        .holdings-card .avg-cost-column > b,
        .holdings-card .value-column > b {
          color: #4b1026 !important;
          font-size: 12px !important;
          font-weight: 900 !important;
          line-height: 1.2 !important;
          letter-spacing: 0 !important;
        }
      }

      @media (max-width: 390px) {
        .holdings-card .price-column > b,
        .holdings-card .avg-cost-column > b,
        .holdings-card .value-column > b {
          font-size: 12px !important;
        }
      }


      /* ===== Holdings P/L KRW amount =====
         Match the KRW sub-value typography used under Value.
         P/L percentage keeps its existing green/red styling. */
      .holdings-card .cost-return-column > .pl-krw {
        display: block !important;
        margin-top: 4px !important;
        color: #303846 !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        line-height: 1.2 !important;
        white-space: nowrap !important;
      }

      @media (max-width: 760px) {
        .holdings-card .cost-return-column > .pl-krw {
          font-size: 10px !important;
          font-weight: 700 !important;
        }
      }


      /* Interactive bottom tab thumb: only visible while touching/dragging. */
      @media (max-width: 760px) {
        .mobile-bottom-navigation {
          touch-action: none !important;
          overscroll-behavior: contain;
        }
        .mobile-bottom-navigation button {
          position: relative !important;
          z-index: 2 !important;
          touch-action: none !important;
        }
        .mobile-bottom-navigation.is-sliding button.active {
          background: transparent !important;
          color: #6f2a40 !important;
          box-shadow: none !important;
        }
        .mobile-bottom-navigation.is-sliding button[data-slide-selected="true"] {
          color: #fff7ed !important;
        }
        .mobile-bottom-navigation .bottom-tab-slide-highlight {
          position: absolute;
          z-index: 1;
          top: 5px;
          width: calc((100% - 28px) / 4);
          height: 48px;
          border-radius: 12px;
          background: #861f41;
          box-shadow: 0 4px 11px rgba(134, 31, 65, .22);
          pointer-events: none;
          will-change: left;
        }
      }

      /* ===== Dedicated mobile bottom navigation =====
         Desktop keeps the original header navigation unchanged.
         Mobile hides that header navigation completely and uses a separate
         fixed navigation element, so the header grid cannot be disturbed. */
      .mobile-bottom-navigation {
        display: none;
        touch-action: pan-y;
        user-select: none;
        -webkit-user-select: none;
      }

      @media (max-width: 760px) {
        /* Critical: remove the original nav from the mobile header layout. */
        .topbar .desktop-navigation {
          display: none !important;
        }

        /* Restore the mobile header to its normal content flow.
           Do NOT redefine its grid areas here; existing header rules remain intact. */
        .mobile-bottom-navigation {
          position: fixed !important;
          z-index: 1000 !important;
          right: 10px !important;
          bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
          left: 10px !important;
          display: grid !important;
          height: 58px !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          gap: 4px !important;
          margin: 0 !important;
          padding: 5px !important;
          box-sizing: border-box !important;
          border: 1px solid rgba(134, 31, 65, .20) !important;
          border-radius: 17px !important;
          background: rgba(255, 247, 237, .97) !important;
          box-shadow: 0 10px 30px rgba(56, 24, 38, .24) !important;
          backdrop-filter: blur(16px) !important;
          -webkit-backdrop-filter: blur(16px) !important;
        }

        .mobile-bottom-navigation button {
          display: flex !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 48px !important;
          margin: 0 !important;
          padding: 0 3px !important;
          align-items: center !important;
          justify-content: center !important;
          border: 0 !important;
          border-radius: 12px !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #6f2a40 !important;
          font-size: 11px !important;
          font-weight: 850 !important;
          line-height: 1 !important;
          text-align: center !important;
          white-space: nowrap !important;
          -webkit-tap-highlight-color: transparent !important;
        }

        .mobile-bottom-navigation button.active {
          background: #861f41 !important;
          color: #fff7ed !important;
          box-shadow: 0 4px 11px rgba(134, 31, 65, .22) !important;
        }

        /* Keep final page content clear of the fixed bar. */
        body {
          padding-bottom: calc(82px + env(safe-area-inset-bottom, 0px)) !important;
        }

        .page-wrap,
        .market-map-page-wrap,
        .settings-page-wrap {
          padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)) !important;
        }
      }


      /* ===== Mobile bottom nav flush to viewport bottom ===== */
      @media (max-width: 760px) {
        .mobile-bottom-navigation {
          right: 0 !important;
          bottom: 0 !important;
          left: 0 !important;
          width: 100% !important;
          height: 62px !important;
          padding: 5px 8px !important;
          border-right: 0 !important;
          border-bottom: 0 !important;
          border-left: 0 !important;
          border-radius: 16px 16px 0 0 !important;
          background: #fff7ed !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          box-shadow: 0 -8px 24px rgba(56, 24, 38, .18) !important;
        }

        .mobile-bottom-navigation button {
          height: 48px !important;
        }

        /* Reserve exactly the bar height so content scrolls behind nothing. */
        body {
          padding-bottom: 62px !important;
        }

        .page-wrap,
        .market-map-page-wrap,
        .settings-page-wrap {
          padding-bottom: 82px !important;
        }
      }


      /* Mobile bottom navigation sits directly on the viewport edge.
         The existing safe-area padding lives INSIDE the navigation. */
      @media (max-width: 760px) {
        .mobile-bottom-navigation {
          bottom: 0 !important;
        }
      }

      /* Keep the full navigation visible, including the phone safe area.
         Equal top/bottom spacing surrounds the 48px buttons; on phones with
         a home indicator the safe-area is inside the colored navigation. */
      @media (max-width: 760px) {
        .mobile-bottom-navigation {
          bottom: 0 !important;
          height: calc(62px + env(safe-area-inset-bottom, 0px)) !important;
          padding: 7px 8px calc(7px + env(safe-area-inset-bottom, 0px)) !important;
          background: #fff7ed !important;
          overflow: visible !important;
        }

        .mobile-bottom-navigation button {
          height: 48px !important;
        }

        /* A separate 30px white strip directly beneath the existing tab bar.
           No changes to the navigation position, height, or drag behavior. */
        .mobile-bottom-navigation::after {
          content: "" !important;
          position: absolute !important;
          top: 100% !important;
          left: 0 !important;
          right: 0 !important;
          height: 30px !important;
          background: #ffffff !important;
          pointer-events: none !important;
          display: block !important;
        }

        body {
          padding-bottom: calc(62px + env(safe-area-inset-bottom, 0px)) !important;
        }
      }

      /* Rebalancing-only spacing refinements. Other three tabs are untouched. */
      @media (max-width: 760px) {
        .app-rebalancing-active .topbar {
          row-gap: 7px !important;
          padding-top: 10px !important;
          padding-bottom: 7px !important;
        }
        .app-rebalancing-active .topbar .exchange-summary {
          padding-top: 9px !important;
          padding-bottom: 9px !important;
          row-gap: 4px !important;
        }
        .app-rebalancing-active .topbar .exchange-summary {
          align-items: center !important;
          row-gap: 2px !important;
          padding-top: 7px !important;
          padding-bottom: 7px !important;
        }
        .app-rebalancing-active .topbar .exchange-summary > span,
        .app-rebalancing-active .topbar .exchange-summary > strong {
          align-self: center !important;
          margin: 0 !important;
        }
        .app-rebalancing-active .topbar .exchange-summary > span {
          line-height: 1.15 !important;
        }
        .app-rebalancing-active .topbar .exchange-summary > strong {
          line-height: 1.15 !important;
        }
        .app-rebalancing-active .topbar .exchange-summary > small {
          align-self: center !important;
          margin: 0 !important;
          line-height: 1.1 !important;
        }
        .app-rebalancing-active > .page-wrap {
          padding-top: 7px !important;
        }
        .app-rebalancing-active .rebalancing-hero {
          padding-top: 0 !important;
          padding-bottom: 0 !important;
        }
        .app-rebalancing-active .rebalancing-hero h1 {
          margin-top: 4px !important;
          margin-bottom: 7px !important;
        }
      }


      /* Portfolio-only mobile spacing: match the approved 7px rebalancing rhythm. */
      @media (max-width: 760px) {
        .app-portfolio-active .topbar {
          row-gap: 7px !important;
          padding-top: 10px !important;
          padding-bottom: 7px !important;
        }
        .app-portfolio-active .topbar .exchange-summary {
          align-items: center !important;
          row-gap: 2px !important;
          padding-top: 7px !important;
          padding-bottom: 7px !important;
        }
        .app-portfolio-active .topbar .exchange-summary > span,
        .app-portfolio-active .topbar .exchange-summary > strong,
        .app-portfolio-active .topbar .exchange-summary > small {
          align-self: center !important;
          margin: 0 !important;
        }
        .app-portfolio-active .topbar .exchange-summary > span,
        .app-portfolio-active .topbar .exchange-summary > strong {
          line-height: 1.15 !important;
        }
        .app-portfolio-active .topbar .exchange-summary > small {
          line-height: 1.1 !important;
        }
        .app-portfolio-active > .page-wrap {
          display: flex !important;
          flex-direction: column !important;
          gap: 7px !important;
          padding-top: 7px !important;
        }
        .app-portfolio-active > .page-wrap > .hero,
        .app-portfolio-active > .page-wrap > .summary-grid,
        .app-portfolio-active > .page-wrap > .main-grid,
        .app-portfolio-active > .page-wrap > .holdings-card,
        .app-portfolio-active > .page-wrap > .statusbar {
          margin-top: 0 !important;
          margin-bottom: 0 !important;
        }
        /* Override the shared mobile .hero 22px top/bottom padding. */
        .app-shell.app-portfolio-active > .page-wrap > section.hero {
          padding-top: 0 !important;
          padding-bottom: 0 !important;
          margin-top: 0 !important;
          margin-bottom: 0 !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child {
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > span {
          display: block !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > p {
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > section.hero h1 {
          margin-top: 4px !important;
          margin-bottom: 7px !important;
        }
        .app-portfolio-active > .page-wrap > .hero .market-pill {
          margin-top: 7px !important;
        }
        .app-portfolio-active > .page-wrap > .summary-grid,
        .app-portfolio-active > .page-wrap > .main-grid {
          row-gap: 7px !important;
        }
      }

`}</style>

      {/* Match the approved 7px mobile rhythm only on the Market Map tab.
          Global CSS is intentional: the map hero is rendered by MarketMapTab. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-market-map-active .topbar {
            row-gap: 7px !important;
            padding-top: 10px !important;
            padding-bottom: 7px !important;
          }
          .app-shell.app-market-map-active .topbar .exchange-summary {
            align-items: center !important;
            row-gap: 2px !important;
            padding-top: 7px !important;
            padding-bottom: 7px !important;
          }
          .app-shell.app-market-map-active .topbar .exchange-summary > span,
          .app-shell.app-market-map-active .topbar .exchange-summary > strong,
          .app-shell.app-market-map-active .topbar .exchange-summary > small {
            align-self: center !important;
            margin: 0 !important;
          }
          .app-shell.app-market-map-active .topbar .exchange-summary > span,
          .app-shell.app-market-map-active .topbar .exchange-summary > strong {
            line-height: 1.15 !important;
          }
          .app-shell.app-market-map-active .topbar .exchange-summary > small {
            line-height: 1.1 !important;
          }
          .app-shell.app-market-map-active > .market-map-page-wrap {
            padding-top: 7px !important;
          }
          .app-shell.app-market-map-active .market-map-page {
            row-gap: 7px !important;
          }
          .app-shell.app-market-map-active .market-map-page > .hero,
          .app-shell.app-market-map-active .market-map-page > .market-map-hero {
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
          }
          .app-shell.app-market-map-active .market-map-page > .hero h1,
          .app-shell.app-market-map-active .market-map-page > .market-map-hero h1 {
            margin-top: 4px !important;
            margin-bottom: 7px !important;
          }
          .app-shell.app-market-map-active .market-map-page > .hero p,
          .app-shell.app-market-map-active .market-map-page > .market-map-hero p {
            margin-top: 0 !important;
            margin-bottom: 0 !important;
          }
        }
      `}</style>

      {/* Align the Portfolio and Rebalancing section eyebrow baselines on mobile.
          This affects only their hero entry points; all other card spacing stays as-is. */}
      <style jsx global>{`
        @media (max-width:760px) {
          .app-shell.app-portfolio-active > .page-wrap,
          .app-shell.app-rebalancing-active > .page-wrap {
            padding-top:7px !important;
          }

          .app-shell.app-portfolio-active > .page-wrap > section.hero,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero {
            padding-top:0 !important;
            margin-top:0 !important;
          }

          .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > div:first-child {
            margin-top:0 !important;
            padding-top:0 !important;
          }

          .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > span:first-child,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > div:first-child > span:first-child {
            display:block !important;
            margin-top:0 !important;
            margin-bottom:0 !important;
            padding-top:0 !important;
            padding-bottom:0 !important;
            line-height:1.2 !important;
            vertical-align:top !important;
          }
        }
      `}</style>

      {/* Settings-only mobile spacing, matching the approved 7px rhythm. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-settings-active .topbar {
            row-gap: 7px !important;
            padding-top: 10px !important;
            padding-bottom: 7px !important;
          }
          .app-shell.app-settings-active .topbar .exchange-summary {
            align-items: center !important;
            row-gap: 2px !important;
            padding-top: 7px !important;
            padding-bottom: 7px !important;
          }
          .app-shell.app-settings-active .topbar .exchange-summary > span,
          .app-shell.app-settings-active .topbar .exchange-summary > strong,
          .app-shell.app-settings-active .topbar .exchange-summary > small {
            align-self: center !important;
            margin: 0 !important;
          }
          .app-shell.app-settings-active .topbar .exchange-summary > span,
          .app-shell.app-settings-active .topbar .exchange-summary > strong {
            line-height: 1.15 !important;
          }
          .app-shell.app-settings-active .topbar .exchange-summary > small {
            line-height: 1.1 !important;
          }
          .app-shell.app-settings-active > .settings-page-wrap {
            padding-top: 7px !important;
          }
          .app-shell.app-settings-active .settings-page {
            row-gap: 7px !important;
          }
          .app-shell.app-settings-active .settings-page > .hero,
          .app-shell.app-settings-active .settings-page > .settings-hero,
          .app-shell.app-settings-active .settings-page-wrap > .hero,
          .app-shell.app-settings-active .settings-page-wrap > .settings-hero {
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero > div:first-child,
          .app-shell.app-settings-active .settings-page > .settings-hero > div:first-child {
            margin-top: 0 !important;
            padding-top: 0 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero > div:first-child > span:first-child,
          .app-shell.app-settings-active .settings-page > .settings-hero > div:first-child > span:first-child {
            display: block !important;
            margin: 0 !important;
            padding: 0 !important;
            line-height: 1.2 !important;
            vertical-align: top !important;
          }
          .app-shell.app-settings-active .settings-page > .hero h1,
          .app-shell.app-settings-active .settings-page > .settings-hero h1 {
            margin-top: 4px !important;
            margin-bottom: 7px !important;
          }
          .app-shell.app-settings-active .settings-page > .hero p,
          .app-shell.app-settings-active .settings-page > .settings-hero p {
            margin-top: 0 !important;
            margin-bottom: 0 !important;
          }
        }
      `}</style>
      {/* Portfolio-only orange outlines. No changes to spacing, content or other tabs. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active > .page-wrap .summary-grid > .summary-card,
        .app-shell.app-portfolio-active > .page-wrap .main-grid > .allocation-card,
        .app-shell.app-portfolio-active > .page-wrap .main-grid > .top-holdings-card,
        .app-shell.app-portfolio-active > .page-wrap > .holdings-card {
          border: 1px solid #e87722 !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody tr {
            border: 1px solid #e87722 !important;
          }
        }
      `}</style>
      {/* Collapsible Portfolio panels: only collapsed state and toggle presentation. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid .portfolio-panel-collapsed {
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
        }
        .app-shell.app-portfolio-active .main-grid .portfolio-panel-collapsed > .section-heading {
          flex: 0 0 auto !important;
          margin-bottom: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-fold-actions {
          display: flex;
          flex: 0 0 auto;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          margin-left: auto;
        }
        /* Both panel toggles share the exact same right edge. */
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card > .section-heading {
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          width: 100%;
          box-sizing: border-box;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > div:first-child,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card > .section-heading > div:first-child {
          flex: 1 1 auto !important;
          min-width: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card > .section-heading > .portfolio-fold-toggle {
          margin-left: auto;
        }
        .app-shell.app-portfolio-active .portfolio-fold-toggle {
          flex: 0 0 auto;
          padding: 7px 10px;
          border: 1px solid #e87722;
          border-radius: 8px;
          color: #861f41;
          background: #fff7ed;
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
          white-space: nowrap;
        }
        .app-shell.app-portfolio-active .portfolio-fold-toggle {
          min-height: 36px;
          padding: 8px 12px;
          border-color: #ffd2ad;
          border-radius: 10px;
        }
        .app-shell.app-portfolio-active .portfolio-fold-toggle:hover {
          background: #ffedd5;
        }
        .app-shell.app-portfolio-active .portfolio-fold-toggle:focus-visible {
          outline: 2px solid #e87722;
          outline-offset: 3px;
        }
        @media (max-width: 480px) {
          .app-shell.app-portfolio-active .portfolio-fold-toggle {
            min-height: 32px;
            padding: 7px 9px;
          }
        }
        /* Match the Holdings heading's left edge to the other Portfolio headings,
           and reduce only its upper blank space by about ten percent. */
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading {
            /* Match the 18px heading inset used by the two panels above. */
            padding-top: 2px !important;
            padding-left: 2px !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading > div:first-child {
            text-align: left !important;
            margin-left: 0 !important;
          }
        }
        @media (max-width: 560px) {
          /* The holdings card changes from 16px to 12px padding on phones.
             Add the missing 4px so its heading stays at the same 18px left edge. */
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading {
            padding-left: 6px !important;
            padding-top: 6px !important;
          }
        }
      `}</style>
      {/* Portfolio holdings name: force ticker and full name into the SAME row on mobile. */}
      <style jsx global>{`
        @media (max-width: 1180px) {
          .app-shell.app-portfolio-active .holdings-card .asset-column,
          .app-shell.app-portfolio-active .holdings-card .asset-cell,
          .app-shell.app-portfolio-active .holdings-card .asset-copy {
            min-width: 0 !important;
          }
          .app-shell.app-portfolio-active .holdings-card .asset-copy {
            flex: 1 1 auto !important;
            width: 100% !important;
            max-width: 100% !important;
            gap: 3px !important;
          }
          .app-shell.app-portfolio-active .holdings-card .asset-name-line {
            display: grid !important;
            grid-template-columns: max-content minmax(0, 1fr) !important;
            align-items: baseline !important;
            column-gap: 6px !important;
            width: 100% !important;
            min-width: 0 !important;
            max-width: 100% !important;
          }
          .app-shell.app-portfolio-active .holdings-card .asset-name-line > b {
            display: block !important;
            min-width: 0 !important;
            margin: 0 !important;
            white-space: nowrap !important;
          }
          .app-shell.app-portfolio-active .holdings-card .asset-name-line > .company-name {
            display: block !important;
            width: 100% !important;
            min-width: 0 !important;
            max-width: 100% !important;
            margin: 0 !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
          }
          .app-shell.app-portfolio-active .holdings-card .asset-copy > .mobile-category {
            display: inline-flex !important;
            width: fit-content !important;
            margin-top: 0 !important;
          }
        }
      `}</style>
      {/* Portfolio mobile holdings: left-align Allocation and tighten the two data rows only. */}
      <style jsx global>{`
        @media (max-width: 560px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody {
            gap: 7px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody tr {
            row-gap: 7px !important;
            padding: 10px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .asset-column {
            min-height: 42px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .value-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column {
            padding-top: 5px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column {
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column .mobile-field-label {
            text-align: left !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column .allocation-cell {
            justify-content: flex-start !important;
          }
        }
      `}</style>
      {/* Align only the main Portfolio and Rebalancing headings with the left
          edge of their content cards on mobile, without changing vertical spacing. */}
      <style jsx global>{`
        @media (max-width:760px) {
          .app-shell.app-portfolio-active > .page-wrap > section.hero,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero {
            /* Inset headings 8px from their container, matching the card headings. */
            padding-left:8px !important;
            padding-right:8px !important;
            box-sizing:border-box !important;
          }
          /* Keep the target total box aligned with the full-width cards. */
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > .target-total {
            width:calc(100% + 16px) !important;
            margin-left:-8px !important;
            margin-right:-8px !important;
            max-width:none !important;
            box-sizing:border-box !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > div:first-child {
            margin-left:0 !important;
            padding-left:0 !important;
            text-align:left !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > span:first-child,
          .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > h1,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > div:first-child > span:first-child,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero > div:first-child > h1 {
            margin-left:0 !important;
            padding-left:0 !important;
            text-align:left !important;
          }
        }
      `}</style>
      {/* Match the distance above and below the main headings on mobile.
          Remove only nested bottom margins; the surrounding 7px section gaps remain. */}
      <style jsx global>{`
        @media (max-width:760px) {
          .app-shell.app-portfolio-active > .page-wrap > section.hero h1,
          .app-shell.app-rebalancing-active > .page-wrap > .rebalancing-page > section.rebalancing-hero h1 {
            margin-bottom:0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > section.hero .market-pill {
            margin-top:0 !important;
          }
        }
      `}</style>

      {/* Unified performance panel: center the total, no inner dividers, reserve space for icons. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active > .page-wrap > .summary-grid {
          display:grid !important;
          grid-template-columns:minmax(0,1fr) !important;
          gap:7px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          display:grid !important;
          grid-template-columns:repeat(2,minmax(0,1fr)) !important;
          grid-template-areas:"value value" "return change" !important;
          gap:0 !important;
          width:100% !important;
          padding:10px !important;
          box-sizing:border-box !important;
          border:1px solid #E87722 !important;
          border-radius:16px !important;
          background:#fff !important;
          overflow:visible !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(1) { grid-area:value !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) { grid-area:return !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) { grid-area:change !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card {
          position:relative !important;
          width:100% !important;
          max-width:100% !important;
          min-width:0 !important;
          min-height:0 !important;
          height:auto !important;
          padding:9px 6px !important;
          margin:0 !important;
          box-sizing:border-box !important;
          border:0 !important;
          border-radius:0 !important;
          box-shadow:none !important;
          background:transparent !important;
          overflow:visible !important;
        }
        /* TOTAL VALUE: force full-width centered content irrespective of older summary-grid CSS. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child {
          display:flex !important;
          flex-direction:column !important;
          align-items:center !important;
          justify-content:center !important;
          text-align:center !important;
          padding:12px 4px 14px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content {
          position:static !important;
          display:flex !important;
          flex-direction:column !important;
          align-items:center !important;
          justify-content:center !important;
          width:100% !important;
          min-width:0 !important;
          max-width:100% !important;
          gap:5px !important;
          margin:0 !important;
          padding:0 !important;
          text-align:center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content > * {
          position:static !important;
          display:block !important;
          width:100% !important;
          height:auto !important;
          min-height:0 !important;
          margin:0 !important;
          padding:0 !important;
          justify-self:center !important;
          align-self:center !important;
          text-align:center !important;
          white-space:normal !important;
          grid-area:auto !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content > strong {
          font-size:clamp(23px,6vw,34px) !important;
          font-weight:900 !important;
          line-height:1.18 !important;
          overflow-wrap:anywhere !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-icon-slot {
          display:none !important;
        }
        /* RETURN / CHANGE: left-aligned text with a dedicated right-side icon column. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) {
          display:grid !important;
          grid-template-columns:minmax(0,1fr) 28px !important;
          grid-template-rows:auto !important;
          align-items:center !important;
          column-gap:5px !important;
          padding:8px 5px !important;
          min-height:64px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content {
          position:static !important;
          display:flex !important;
          flex-direction:column !important;
          align-items:flex-start !important;
          justify-content:center !important;
          width:100% !important;
          min-width:0 !important;
          max-width:100% !important;
          gap:5px !important;
          margin:0 !important;
          padding:0 !important;
          text-align:left !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > * {
          position:static !important;
          display:block !important;
          grid-area:auto !important;
          width:100% !important;
          min-width:0 !important;
          height:auto !important;
          margin:0 !important;
          padding:0 !important;
          align-self:flex-start !important;
          justify-self:start !important;
          text-align:left !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > strong {
          font-size:clamp(14px,3.5vw,19px) !important;
          line-height:1.15 !important;
          overflow-wrap:anywhere !important;
          white-space:normal !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > small {
          font-size:8px !important;
          line-height:1.25 !important;
          white-space:normal !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-icon-slot {
          position:relative !important;
          display:grid !important;
          grid-column:2 !important;
          grid-row:1 !important;
          flex:none !important;
          width:28px !important;
          height:28px !important;
          min-width:28px !important;
          min-height:28px !important;
          max-width:28px !important;
          max-height:28px !important;
          margin:0 !important;
          padding:0 !important;
          transform:none !important;
          place-items:center !important;
          align-self:center !important;
          justify-self:end !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) .summary-icon-button {
          position:static !important;
          display:grid !important;
          width:28px !important;
          height:28px !important;
          min-width:28px !important;
          min-height:28px !important;
          max-width:28px !important;
          max-height:28px !important;
          margin:0 !important;
          padding:0 !important;
          transform:none !important;
          place-items:center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .total-return-popover {
          z-index:30 !important;
        }
        /* Refinement: larger USD equivalent beneath the centered total. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content > small {
          font-size:clamp(13px,3.6vw,17px) !important;
          font-weight:700 !important;
          line-height:1.3 !important;
        }
        /* Return/Change: center each information group; put the action icon
           directly after its label rather than at the far card edge. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) {
          display:grid !important;
          grid-template-columns:max-content 26px !important;
          grid-template-rows:auto auto auto !important;
          justify-content:center !important;
          justify-items:center !important;
          align-content:center !important;
          align-items:center !important;
          gap:4px 4px !important;
          padding:9px 3px !important;
          text-align:center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content {
          display:contents !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > span {
          grid-column:1 !important;
          grid-row:1 !important;
          width:auto !important;
          align-self:center !important;
          justify-self:end !important;
          text-align:right !important;
          white-space:nowrap !important;
          font-size:clamp(8px,2.4vw,11px) !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > strong {
          grid-column:1 / -1 !important;
          grid-row:2 !important;
          width:100% !important;
          justify-self:center !important;
          text-align:center !important;
          line-height:1.2 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-content > small {
          grid-column:1 / -1 !important;
          grid-row:3 !important;
          width:100% !important;
          justify-self:center !important;
          text-align:center !important;
          white-space:normal !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) > .summary-icon-slot {
          position:relative !important;
          grid-column:2 !important;
          grid-row:1 !important;
          width:24px !important;
          height:24px !important;
          min-width:24px !important;
          min-height:24px !important;
          max-width:24px !important;
          max-height:24px !important;
          justify-self:start !important;
          align-self:center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(n+2) .summary-icon-button {
          width:24px !important;
          height:24px !important;
          min-width:24px !important;
          min-height:24px !important;
          max-width:24px !important;
          max-height:24px !important;
          font-size:12px !important;
        }
        /* No decorative icon or reserved icon column for Holdings. */
        .app-shell.app-portfolio-active > .page-wrap > .summary-grid > .summary-card-no-icon {
          grid-template-columns:minmax(0,1fr) !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > .summary-grid > .summary-card-no-icon > .summary-content {
          grid-column:1 / -1 !important;
        }
      `}</style>
      {/* Portfolio overview: one enclosing card, clean centered labels and accessible icons. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          grid-template-areas: "value value" "return change" "holdings holdings" !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          grid-area: holdings !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          min-height: 0 !important;
          padding: 9px 6px !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content {
          display: flex !important;
          flex-direction: column !important;
          width: 100% !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 4px !important;
          text-align: center !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > * {
          display: block !important;
          width: auto !important;
          text-align: center !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-icon-slot {
          display: none !important;
        }
        /* The two detail actions have their own reserved columns, with a real
           gap after their titles so the rounded-square buttons never overlap. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          grid-template-columns: minmax(0,max-content) 26px !important;
          column-gap: 9px !important;
          justify-content: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          position: relative !important;
          top: auto !important;
          right: auto !important;
          left: auto !important;
          transform: none !important;
          grid-column: 2 !important;
          grid-row: 1 !important;
          width: 26px !important;
          height: 26px !important;
          margin: 0 !important;
          padding: 0 !important;
          align-self: center !important;
          justify-self: start !important;
          z-index: 2 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) .summary-icon-button,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) .summary-icon-button {
          position: static !important;
          display: grid !important;
          place-items: center !important;
          width: 26px !important;
          height: 26px !important;
          min-width: 26px !important;
          min-height: 26px !important;
          padding: 0 !important;
          margin: 0 !important;
          border-radius: 8px !important;
          transform: none !important;
          box-sizing: border-box !important;
          cursor: pointer !important;
        }
        @media (max-width: 380px) {
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
            column-gap: 6px !important;
          }
        }
      `}</style>
      {/* Three-column portfolio overview: consistent centered baselines and non-overlapping action icons. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
          grid-template-areas: "value value value" "return change holdings" !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          width: 100% !important;
          min-width: 0 !important;
          min-height: 76px !important;
          box-sizing: border-box !important;
          padding: 7px 2px !important;
          align-self: stretch !important;
          align-items: start !important;
          justify-items: center !important;
          align-content: start !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          display: grid !important;
          grid-template-columns: minmax(0,max-content) 22px !important;
          grid-template-rows: 25px minmax(24px,auto) minmax(16px,auto) !important;
          column-gap: 5px !important;
          row-gap: 3px !important;
          justify-content: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content {
          display: contents !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > span {
          grid-column: 1 !important;
          grid-row: 1 !important;
          width: auto !important;
          justify-self: end !important;
          align-self: center !important;
          text-align: right !important;
          white-space: nowrap !important;
          font-size: clamp(7px, 2vw, 10px) !important;
          line-height: 1.1 !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > strong {
          grid-column: 1 / -1 !important;
          grid-row: 2 !important;
          width: 100% !important;
          font-size: clamp(12px, 3.1vw, 18px) !important;
          text-align: center !important;
          justify-self: center !important;
          align-self: center !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > small,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > small {
          grid-column: 1 / -1 !important;
          grid-row: 3 !important;
          width: 100% !important;
          text-align: center !important;
          justify-self: center !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          position: relative !important;
          grid-column: 2 !important;
          grid-row: 1 !important;
          width: 22px !important;
          height: 22px !important;
          min-width: 22px !important;
          min-height: 22px !important;
          max-width: 22px !important;
          max-height: 22px !important;
          justify-self: start !important;
          align-self: center !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) .summary-icon-button,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) .summary-icon-button {
          position: static !important;
          width: 22px !important;
          height: 22px !important;
          min-width: 22px !important;
          min-height: 22px !important;
          max-width: 22px !important;
          max-height: 22px !important;
          border-radius: 7px !important;
          padding: 0 !important;
          margin: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          grid-area: holdings !important;
          display: grid !important;
          grid-template-columns: minmax(0,1fr) !important;
          grid-template-rows: 25px minmax(24px,auto) minmax(16px,auto) !important;
          gap: 3px !important;
          justify-content: stretch !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content {
          display: contents !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > span {
          grid-column: 1 !important;
          grid-row: 1 !important;
          justify-self: center !important;
          align-self: center !important;
          font-size: clamp(7px, 2vw, 10px) !important;
          white-space: nowrap !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > strong {
          grid-column: 1 !important;
          grid-row: 2 !important;
          justify-self: center !important;
          align-self: center !important;
          font-size: clamp(12px, 3.1vw, 18px) !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > small {
          grid-column: 1 !important;
          grid-row: 3 !important;
          justify-self: center !important;
          align-self: start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-icon-slot {
          display: none !important;
        }
      `}</style>
      {/* Keep the two info icons in reserved right-side cells; labels cannot extend underneath them. */}
      <style jsx global>{`
        @media (max-width: 720px) {
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
            grid-template-columns: minmax(0, 1fr) 22px !important;
            column-gap: 7px !important;
            justify-content: stretch !important;
          }
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > span,
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > span {
            width: 100% !important;
            min-width: 0 !important;
            justify-self: stretch !important;
            text-align: center !important;
            font-size: clamp(6px, 1.8vw, 9px) !important;
            letter-spacing: 0 !important;
          }
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
            width: 22px !important;
            height: 22px !important;
            min-width: 22px !important;
            min-height: 22px !important;
            justify-self: end !important;
          }
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) .summary-icon-button,
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) .summary-icon-button {
            width: 22px !important;
            height: 22px !important;
            min-width: 22px !important;
            min-height: 22px !important;
            border-radius: 7px !important;
          }
        }
      `}</style>
      {/* Portfolio summary typography and alignment: intentionally scoped to this card only. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total .rolling-total-stage,
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total .rolling-total-static,
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total .rolling-total-stage > span {
          color: #0f172a !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive .portfolio-rolling-total span {
          color: #15803d !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative .portfolio-rolling-total span {
          color: #b91c1c !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > strong {
          color: #0f172a !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive > .summary-card:nth-child(2) > .summary-content > strong { color: #15803d !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative > .summary-card:nth-child(2) > .summary-content > strong { color: #b91c1c !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > strong { color: #0f172a !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-positive > .summary-card:nth-child(3) > .summary-content > strong { color: #15803d !important; }
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-negative > .summary-card:nth-child(3) > .summary-content > strong { color: #b91c1c !important; }
        /* All three labels and values share identical alignment, size and vertical rhythm. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          align-content: start !important;
          justify-content: center !important;
          justify-items: center !important;
          grid-template-rows: 27px minmax(30px,auto) minmax(16px,auto) !important;
          padding: 7px 2px !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          grid-template-columns: minmax(0,1fr) 20px !important;
          column-gap: 5px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > span {
          font-size: clamp(8px,2.15vw,11px) !important;
          font-weight: 850 !important;
          line-height: 1.1 !important;
          white-space: nowrap !important;
          text-align: center !important;
          align-self: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > span {
          grid-column: 1 !important;
          width: 100% !important;
          justify-self: stretch !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > strong {
          grid-row: 2 !important;
          font-size: clamp(16px,4.1vw,21px) !important;
          font-weight: 900 !important;
          line-height: 1.1 !important;
          margin: 0 !important;
          text-align: center !important;
          justify-self: center !important;
          align-self: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > strong {
          grid-column: 1 / -1 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          grid-column: 2 !important;
          grid-row: 1 !important;
          justify-self: end !important;
          align-self: center !important;
          width: 20px !important;
          min-width: 20px !important;
          max-width: 20px !important;
          height: 20px !important;
          min-height: 20px !important;
          max-height: 20px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) .summary-icon-button,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) .summary-icon-button {
          width: 20px !important;
          min-width: 20px !important;
          max-width: 20px !important;
          height: 20px !important;
          min-height: 20px !important;
          max-height: 20px !important;
          border-radius: 7px !important;
        }
      `}</style>
      {/* Animated total: incoming digits slide up from below, like a scoreboard. */}
      <style jsx global>{`
        .app-shell .portfolio-rolling-total {
          display: block !important;
          width: 100% !important;
          text-align: center !important;
          /* Restore the original Total Value size (previous animation inherited small text). */
          font-size:clamp(23px,6vw,34px) !important;
          font-weight:900 !important;
          font-family:inherit !important;
          font-variant-numeric: tabular-nums;
          line-height: 1.18 !important;
        }
        .app-shell .portfolio-rolling-total .rolling-total-stage,
        .app-shell .portfolio-rolling-total .rolling-total-static {
          display: inline-block !important;
          width: auto !important;
          position: relative !important;
          max-width: 100%;
          overflow: hidden;
          vertical-align: middle;
          white-space: nowrap !important;
          text-align: center !important;
        }
        .app-shell .portfolio-rolling-total .rolling-total-stage,
        .app-shell .portfolio-rolling-total .rolling-total-static,
        .app-shell .portfolio-rolling-total .rolling-total-stage > span {
          font-size:inherit !important;
          font-weight:inherit !important;
        }
        .app-shell .portfolio-rolling-total .rolling-total-stage {
          height: 1.2em;
          min-height: 1.2em !important;
        }
        .app-shell .portfolio-rolling-total .rolling-total-stage > span {
          display: block;
          width: 100%;
          line-height: 1.2;
          white-space: nowrap;
          text-align: center;
        }
        .app-shell .portfolio-rolling-total .rolling-total-measure { visibility: hidden; }
        .app-shell .portfolio-rolling-total .rolling-total-old {
          position: absolute;
          inset: 0;
          animation: portfolio-score-out 460ms cubic-bezier(.2,.65,.2,1) both;
        }
        .app-shell .portfolio-rolling-total .rolling-total-new {
          position: absolute;
          inset: 0;
          animation: portfolio-score-in 460ms cubic-bezier(.2,.65,.2,1) both;
        }
        @keyframes portfolio-score-out {
          from { transform: translateY(0); opacity: 1; }
          to { transform: translateY(-100%); opacity: 0; }
        }
        @keyframes portfolio-score-in {
          from { transform: translateY(100%); opacity: .3; }
          to { transform: translateY(0); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .app-shell .portfolio-rolling-total .rolling-total-old,
          .app-shell .portfolio-rolling-total .rolling-total-new {
            animation: none !important;
          }
          .app-shell .portfolio-rolling-total .rolling-total-old { display: none !important; }
        }
        /* Per-character Total Value transition: stationary digits never move. */
        .app-shell .portfolio-rolling-total .rolling-total-digits {
          display: inline-flex !important;
          width: auto !important;
          max-width: 100%;
          align-items: baseline;
          justify-content: center;
          white-space: nowrap;
          font: inherit !important;
          color: inherit !important;
          font-variant-numeric: tabular-nums;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-static,
        .app-shell .portfolio-rolling-total .rolling-digit-slot {
          display: inline-block !important;
          position: relative;
          flex: 0 0 auto;
          vertical-align: baseline;
          font: inherit !important;
          color: inherit !important;
          line-height: 1.2 !important;
        }
        /* Every digit occupies the same fixed cell before, during and after a roll.
           Otherwise swapping a static digit for the animated slot changes the width
           and baseline of the entire amount on each live quote update. */
        .app-shell .portfolio-rolling-total .rolling-digit-number,
        .app-shell .portfolio-rolling-total .rolling-digit-slot {
          box-sizing: border-box !important;
          width: 1ch !important;
          min-width: 1ch !important;
          max-width: 1ch !important;
          height: 1.2em !important;
          min-height: 1.2em !important;
          flex: 0 0 1ch !important;
          line-height: 1.2 !important;
          text-align: center !important;
          font-variant-numeric: tabular-nums !important;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-number {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-slot {
          overflow: hidden;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-slot > span {
          position: absolute;
          inset: 0;
          display: flex !important;
          align-items: center;
          justify-content: center;
          font: inherit !important;
          color: inherit !important;
          line-height: 1.2 !important;
        }
        /* Each digit stays in the same DOM slot for its entire lifetime.
           Only inner, absolutely-positioned glyphs animate: no layout shifts. */
        .app-shell .portfolio-rolling-total .rolling-digit-old {
          visibility: hidden;
          animation: none;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-new {
          animation: none;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-slot.is-changing .rolling-digit-old {
          visibility: visible;
          animation: portfolio-score-out 460ms cubic-bezier(.2,.65,.2,1) both;
        }
        .app-shell .portfolio-rolling-total .rolling-digit-slot.is-changing .rolling-digit-new {
          animation: portfolio-score-in 460ms cubic-bezier(.2,.65,.2,1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .app-shell .portfolio-rolling-total .rolling-digit-old { display: none !important; }
          .app-shell .portfolio-rolling-total .rolling-digit-new { animation: none !important; }
        }
        /* Mobile Add Stock: center the plus using geometry rather than font glyph metrics. */
        @media (max-width: 720px) {
          .top-actions .primary-button {
            position: relative !important;
            width: 38px !important;
            min-width: 38px !important;
            height: 38px !important;
            border-radius: 12px !important;
          }
          .top-actions .primary-button::after {
            content: "" !important;
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            width: 16px !important;
            height: 16px !important;
            background:
              linear-gradient(#fff, #fff) center / 16px 2px no-repeat,
              linear-gradient(#fff, #fff) center / 2px 16px no-repeat !important;
            pointer-events: none !important;
          }
        }
      `}</style>
      {/* Hide only the muted descriptions immediately under each tab's main title.
          Shared across Portfolio, Rebalancing, Market Map, and Settings. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active > .page-wrap > section.hero > div:first-child > p,
        .app-shell.app-rebalancing-active .rebalancing-hero > div:first-child > p,
        .app-shell.app-market-map-active .market-map-hero > div:first-child > p,
        .app-shell.app-market-map-active .market-map-page > section.hero > div:first-child > p,
        .app-shell.app-settings-active .settings-hero > div:first-child > p,
        .app-shell.app-settings-active .settings-page > section.hero > div:first-child > p {
          display: none !important;
        }
      `}</style>
      {/* Market Map only: match the Portfolio/Rebalancing horizontal card gutters.
          The shared page-wrap already supplies 12px per side on mobile;
          remove only the nested map-page horizontal inset. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-market-map-active > .page-wrap.market-map-page-wrap {
            padding-left: 12px !important;
            padding-right: 12px !important;
          }
          .app-shell.app-market-map-active > .page-wrap.market-map-page-wrap > .market-map-page {
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(
            .hero, .market-map-hero
          ) {
            /* Same 8px heading inset as Portfolio and Rebalancing. */
            padding-left: 8px !important;
            padding-right: 8px !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(
            .hero, .market-map-hero
          ) > div:first-child {
            margin-left: 0 !important;
            padding-left: 0 !important;
            text-align: left !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(
            .hero, .market-map-hero
          ) > div:first-child > :is(span, h1) {
            margin-left: 0 !important;
            padding-left: 0 !important;
            text-align: left !important;
          }
        }
      `}</style>
      {/* Market Map: recolor the existing rounded card border only.
          Do not draw a second, square border around section wrappers or the title. */}
      <style jsx global>{`
        .app-shell.app-market-map-active .market-map-page :is(
          .map-card,
          .map-panel,
          .map-section,
          .market-map-card,
          .market-map-panel,
          .market-card,
          .market-panel,
          .stock-card,
          .sector-card,
          .heatmap-card,
          .heatmap-panel
        ):not(.hero):not(.market-map-hero) {
          border-color: #E87722 !important;
          border-width: 1px !important;
          border-style: solid !important;
        }
        /* Match the actual existing card shells, including generic Card/Panel
           class names used inside MarketMapTab. Recolor their single border;
           never create borders on arbitrary inner elements or wrappers. */
        .app-shell.app-market-map-active .market-map-page :is(
          .card, .panel, .glass-card, .surface-card,
          [class$="-card"], [class$="-panel"],
          [class*="-card "], [class*="-panel "],
          [class*="_card_"], [class*="_panel_"]
        ):not(.hero):not(.market-map-hero):not(.map-toolbar):not(.map-category-filter):not(.map-view-toggle) {
          border-color: #E87722 !important;
        }
        /* If the MarketMap component uses its own plain sections as cards,
           set their native border without touching the title or inner grid. */
        .app-shell.app-market-map-active .market-map-page > section:not(.hero):not(.market-map-hero),
        .app-shell.app-market-map-active .market-map-page > article {
          border-color: #E87722 !important;
        }
        /* Recolor the existing toolbar shell too; keep its original radius. */
        .app-shell.app-market-map-active .market-map-page > .map-toolbar.card {
          border-color: #E87722 !important;
        }
        /* The heading is outside of the card design, like the other tabs. */
        .app-shell.app-market-map-active .market-map-page > :is(
          .hero,
          .market-map-hero
        ) {
          border: 0 !important;
          box-shadow: none !important;
          background: transparent !important;
        }
      `}</style>

      {/* Market Map mobile title: match Rebalancing's type scale and vertical rhythm. */}
      <style jsx global>{`
        @media (max-width:760px) {
          .app-shell.app-market-map-active > .page-wrap.market-map-page-wrap {
            padding-top:7px !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) {
            margin-top:0 !important;
            margin-bottom:0 !important;
            padding-top:0 !important;
            padding-bottom:0 !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) > div:first-child {
            margin-top:0 !important;
            padding-top:0 !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) > div:first-child > span:first-child {
            display:block !important;
            margin:0 !important;
            padding:0 !important;
            /* Keep the Market Map eyebrow blue; typography is unchanged. */
            color:#2563eb !important;
            /* All typography comes from the shared .hero heading styling. */
            line-height:1.2 !important;
            vertical-align:top !important;
          }
          /* Rebalancing reference: same typography and 7px section rhythm. */
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) h1 {
            display:block !important;
            margin-top:4px !important;
            margin-bottom:0 !important;
            padding:0 !important;
            /* Font size, weight, tracking and color inherit .hero h1, exactly as Rebalancing. */
            text-align:left !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) {
            margin-bottom:0 !important;
          }
          .app-shell.app-market-map-active .market-map-page > :is(.hero,.market-map-hero) + * {
            margin-top:0 !important;
          }
        }
      `}</style>

      {/* Market Map hero metrics: one unified rounded card, no horizontal swipe.
          Do not change the already-matched headings or any other tab. */}
      <style jsx global>{`
        .app-shell.app-market-map-active .market-map-page .map-hero-stats {
          display: grid !important;
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 0 !important;
          margin-top: 0 !important;
          padding: 10px 6px !important;
          overflow: visible !important;
          border: 1px solid #E87722 !important;
          border-radius: 16px !important;
          background: #ffffff !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
        }
        /* Strip any inherited card appearance from the two plain stat columns. */
        .app-shell.app-market-map-active .market-map-page .market-map-hero .map-hero-stats > div,
        .app-shell.app-market-map-active .market-map-page .market-map-hero .map-hero-stats > div:first-child,
        .app-shell.app-market-map-active .market-map-page .market-map-hero .map-hero-stats > div:last-child {
          border: none !important;
          border-width: 0 !important;
          border-color: transparent !important;
          outline: none !important;
          box-shadow: none !important;
          background: transparent !important;
          background-image: none !important;
          border-radius: 0 !important;
        }
        .app-shell.app-market-map-active .market-map-page .map-hero-stats > div {
          display: flex !important;
          width: auto !important;
          max-width: none !important;
          min-width: 0 !important;
          height: auto !important;
          flex: 1 1 0 !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 3px !important;
          margin: 0 !important;
          padding: 5px 3px !important;
          border: 0 !important;
          border-radius: 0 !important;
          outline: 0 !important;
          background: transparent !important;
          background-image: none !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
          text-align: center !important;
        }
        .app-shell.app-market-map-active .market-map-page .map-hero-stats > div :is(span,strong,small) {
          display: block !important;
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          margin: 0 !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
          text-align: center !important;
        }
        .app-shell.app-market-map-active .market-map-page .map-hero-stats > div:first-child > strong {
          color: #16A34A !important;
        }
        .app-shell.app-market-map-active .market-map-page .map-hero-stats > div:nth-child(2) > strong {
          color: #9333EA !important;
        }
        @media (max-width: 760px) {
          /* Rebalancing reference: 7px between heading block and its card.
             The card itself occupies the true container width; only text is inset. */
          .app-shell.app-market-map-active .market-map-page > .market-map-hero,
          .app-shell.app-market-map-active .market-map-page > .hero.market-map-hero {
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 7px !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
            overflow: visible !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-market-map-active .market-map-page > .market-map-hero > div:first-child,
          .app-shell.app-market-map-active .market-map-page > .hero.market-map-hero > div:first-child {
            margin-left: 8px !important;
            margin-right: 8px !important;
          }
          .app-shell.app-market-map-active .market-map-page .map-hero-stats {
            /* Cancel the hero's 8px heading-only inset so this card aligns
               exactly with the full-width toolbar and treemap cards below. */
            width: 100% !important;
            max-width: 100% !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
            padding: 9px 5px !important;
            margin-top: 0 !important;
            overflow: visible !important;
          }
          .app-shell.app-market-map-active .market-map-page .map-hero-stats > div {
            min-width: 0 !important;
            padding: 4px 2px !important;
          }
          .app-shell.app-market-map-active .market-map-page .map-hero-stats > div > span {
            font-size: 9px !important;
          }
          .app-shell.app-market-map-active .market-map-page .map-hero-stats > div > strong {
            font-size: 16px !important;
            line-height: 1.15 !important;
          }
          .app-shell.app-market-map-active .market-map-page .map-hero-stats > div > small {
            font-size: 9px !important;
          }
        }
      `}</style>

      {/* Portfolio Top Holdings: compact five-row mobile layout only. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card:not(.portfolio-panel-collapsed) {
            height: auto !important;
            min-height: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holdings-list {
            display: grid !important;
            grid-template-rows: none !important;
            gap: 5px !important;
            padding: 6px 10px 8px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            height: auto !important;
            min-height: 100px !important;
            grid-template-columns: 54px minmax(0, 1fr) 74px !important;
            grid-template-areas:
              "position identity value"
              "position cost shares"
              "position allocation allocation" !important;
            column-gap: 9px !important;
            row-gap: 4px !important;
            padding: 7px 9px !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            gap: 4px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > strong {
            margin-top: 3px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost > small {
            margin-top: 2px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation > i {
            margin-top: 4px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares > strong {
            padding: 4px 7px !important;
          }
        }
      `}</style>

      {/* Top Holdings mobile: fixed three-row grid; rank and company mark are rigid circles. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            display: grid !important;
            grid-template-columns: 44px minmax(0, 1fr) minmax(0, 1fr) !important;
            grid-template-rows: repeat(3, minmax(31px, auto)) !important;
            grid-template-areas:
              "position identity value"
              "position cost pnl"
              "position allocation shares" !important;
            column-gap: 10px !important;
            row-gap: 5px !important;
            align-items: start !important;
            min-height: 0 !important;
            height: auto !important;
            padding: 8px 10px !important;
            overflow: visible !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            grid-area: position !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: flex-start !important;
            gap: 7px !important;
            width: 44px !important;
            min-width: 44px !important;
            max-width: 44px !important;
            align-self: start !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position > span {
            position: static !important;
            display: grid !important;
            place-items: center !important;
            flex: 0 0 22px !important;
            width: 22px !important;
            min-width: 22px !important;
            max-width: 22px !important;
            height: 22px !important;
            min-height: 22px !important;
            max-height: 22px !important;
            aspect-ratio: 1 / 1 !important;
            box-sizing: border-box !important;
            border-radius: 50% !important;
            padding: 0 !important;
            margin: 0 !important;
            line-height: 1 !important;
            transform: none !important;
            align-self: center !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo {
            position: static !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 40px !important;
            width: 40px !important;
            min-width: 40px !important;
            max-width: 40px !important;
            height: 40px !important;
            min-height: 40px !important;
            max-height: 40px !important;
            padding: 0 !important;
            margin: 0 auto !important;
            overflow: hidden !important;
            border-radius: 50% !important;
            box-sizing: border-box !important;
            transform: none !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo .company-mark {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 34px !important;
            width: 34px !important;
            min-width: 34px !important;
            max-width: 34px !important;
            height: 34px !important;
            min-height: 34px !important;
            max-height: 34px !important;
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            border-radius: 50% !important;
            overflow: hidden !important;
            box-sizing: border-box !important;
            transform: none !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo .company-mark img,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo img,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo svg {
            display: block !important;
            width: 30px !important;
            min-width: 30px !important;
            max-width: 30px !important;
            height: 30px !important;
            min-height: 30px !important;
            max-height: 30px !important;
            margin: auto !important;
            padding: 0 !important;
            object-fit: contain !important;
            object-position: center !important;
            transform: none !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return {
            min-width: 0 !important;
            width: 100% !important;
            max-width: none !important;
            min-height: 31px !important;
            margin: 0 !important;
            padding: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: flex-start !important;
            align-items: flex-start !important;
            text-align: left !important;
            align-self: start !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity { grid-area: identity !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value { grid-area: value !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost { grid-area: cost !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return { grid-area: pnl !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation { grid-area: allocation !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares { grid-area: shares !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > strong {
            display: block !important;
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            margin: 3px 0 0 !important;
            padding: 0 !important;
            border: 0 !important;
            background: transparent !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            line-height: 1.25 !important;
            text-align: left !important;
            overflow: hidden !important;
            white-space: nowrap !important;
            text-overflow: ellipsis !important;
            font-variant-numeric: tabular-nums !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity strong {
            font-size: 12px !important;
            margin: 0 !important;
            line-height: 15px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity span {
            display: block !important;
            margin-top: 2px !important;
            font-size: 9px !important;
            line-height: 12px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > span {
            display: block !important;
            font-size: 9px !important;
            line-height: 12px !important;
            letter-spacing: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost > small { display: none !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return { display: flex !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation > i {
            display: none !important;
          }
        }
      `}</style>

      {/* Top Holdings: aligned compact mobile rows, circular marks, explicit paired metrics. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .top-holding-return { display: none; }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            display: grid !important;
            grid-template-columns: 54px minmax(0, 1fr) minmax(100px, 1fr) !important;
            grid-template-areas:
              "position identity value"
              "position cost pnl"
              "position allocation shares" !important;
            gap: 7px 10px !important;
            min-height: 0 !important;
            padding: 10px 8px !important;
            align-items: center !important;
            overflow: hidden !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            grid-area: position !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: flex-start !important;
            align-items: center !important;
            align-self: start !important;
            gap: 5px !important;
            width: 54px !important;
            min-width: 0 !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position > span {
            position: static !important;
            width: 20px !important;
            min-width: 20px !important;
            height: 20px !important;
            border-radius: 50% !important;
            font-size: 10px !important;
            transform: none !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position .top-holding-logo {
            position: static !important;
            display: grid !important;
            place-items: center !important;
            width: 40px !important;
            min-width: 40px !important;
            height: 40px !important;
            border-radius: 50% !important;
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
            transform: none !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-logo .company-mark,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-logo img,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-logo svg {
            width: 36px !important;
            max-width: 36px !important;
            height: 36px !important;
            max-height: 36px !important;
            border-radius: 50% !important;
            object-fit: contain !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            grid-area: identity !important;
            align-self: center !important;
            min-width: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity strong {
            font-size: 13px !important;
            line-height: 1.25 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity span {
            margin-top: 3px !important;
            font-size: 10px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat {
            min-width: 0 !important;
            justify-content: center !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value {
            grid-area: value !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost { grid-area: cost !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return {
            display: flex !important;
            grid-area: pnl !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost > small { display: none !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost > span { font-size: 9px !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation {
            grid-area: allocation !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares {
            grid-area: shares !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > span {
            font-size: 9px !important;
            line-height: 1.15 !important;
            letter-spacing: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > strong {
            width: auto !important;
            margin-top: 4px !important;
            padding: 0 !important;
            border: 0 !important;
            background: transparent !important;
            font-size: 12px !important;
            line-height: 1.2 !important;
            font-variant-numeric: tabular-nums !important;
          }
          /* Keep the complete right column aligned to the same left edge. */
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares {
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            align-items: flex-start !important;
            text-align: left !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares > strong {
            text-align: left !important;
            align-self: stretch !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > strong.up { color: #dc2626 !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > strong.down { color: #2563eb !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return > strong.neutral { color: #303846 !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation > i {
            width: min(100%, 90px) !important;
            margin-top: 5px !important;
          }
        }
      `}</style>


      {/* Portfolio: give company names more room; unified positive/negative return colors. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            grid-template-columns: 54px minmax(0, 1.3fr) minmax(90px, .7fr) !important;
          }
        }
        .app-shell.app-portfolio-active .top-holdings-card .cost-return.up,
        .app-shell.app-portfolio-active .top-holdings-card .top-holding-return > strong.up,
        .app-shell.app-portfolio-active .holdings-card .cost-return.up,
        .app-shell.app-portfolio-active .holdings-card .change.up,
        .app-shell.app-portfolio-active .profit-positive,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive .portfolio-rolling-total span,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-positive > .summary-card:nth-child(3) > .summary-content > strong {
          color: #dc2626 !important;
        }
        .app-shell.app-portfolio-active .top-holdings-card .cost-return.down,
        .app-shell.app-portfolio-active .top-holdings-card .top-holding-return > strong.down,
        .app-shell.app-portfolio-active .holdings-card .cost-return.down,
        .app-shell.app-portfolio-active .holdings-card .change.down,
        .app-shell.app-portfolio-active .profit-negative,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative .portfolio-rolling-total span,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-negative > .summary-card:nth-child(3) > .summary-content > strong {
          color: #2563eb !important;
        }
      `}</style>

      {/* Portfolio only: Total Value stays maroon; tighten Top Holdings vertical rhythm. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary .portfolio-rolling-total span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .summary-content > strong {
          color: #861f41 !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holdings-list {
            row-gap: 4px !important;
            padding-top: 4px !important;
            padding-bottom: 5px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            grid-template-rows: repeat(3, minmax(27px, auto)) !important;
            row-gap: 4px !important;
            min-height: 0 !important;
            padding-top: 6px !important;
            padding-bottom: 6px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat > strong {
            margin-top: 2px !important;
          }
        }
      `}</style>

      {/* Portfolio: fixed FX-maroon total and inline identity on mobile only. */}
      <style jsx global>{`
        /* Performance state selectors previously overrode the Total Value color. */
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive > .summary-card:first-child .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative > .summary-card:first-child .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total .rolling-total-stage > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .summary-content > strong {
          color: #861f41 !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            grid-template-columns: 54px minmax(0, 1fr) minmax(85px, .56fr) !important;
            column-gap: 9px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: nowrap !important;
            align-items: center !important;
            justify-content: flex-start !important;
            gap: 5px !important;
            overflow: hidden !important;
            white-space: nowrap !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > strong {
            flex: 0 0 auto !important;
            white-space: nowrap !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > span {
            flex: 1 1 0 !important;
            min-width: 0 !important;
            max-width: 100% !important;
            margin: 0 !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
          }
        }
      `}</style>

      {/* Portfolio mobile Top Holdings: show ticker + company name on one baseline; align first-row metrics. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            grid-template-columns: 50px minmax(0, 1fr) 94px !important;
            column-gap: 7px !important;
            align-items: stretch !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            width: 50px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            grid-area: identity !important;
            display: flex !important;
            flex-direction: row !important;
            align-items: flex-end !important;
            align-self: stretch !important;
            justify-content: flex-start !important;
            gap: 5px !important;
            min-width: 0 !important;
            padding-bottom: 1px !important;
            overflow: hidden !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > strong {
            display: inline-block !important;
            width: auto !important;
            max-width: none !important;
            flex: 0 0 auto !important;
            margin: 0 !important;
            font-size: 12px !important;
            line-height: 15px !important;
            white-space: nowrap !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > span {
            display: inline-block !important;
            width: auto !important;
            flex: 1 1 auto !important;
            min-width: 0 !important;
            margin: 0 !important;
            color: #303846 !important;
            font-size: 10px !important;
            line-height: 15px !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value {
            justify-content: flex-end !important;
            align-self: stretch !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > strong {
            margin-top: 2px !important;
            line-height: 15px !important;
          }
        }
      `}</style>


      {/* Portfolio mobile Top Holdings: align rank, ticker and total-value header on the first row. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            align-items: start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            justify-content: flex-start !important;
            align-self: start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position > span {
            align-self: center !important;
            flex: 0 0 22px !important;
            width: 22px !important;
            height: 22px !important;
            min-width: 22px !important;
            line-height: 22px !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            align-self: start !important;
            align-items: center !important;
            justify-content: flex-start !important;
            padding: 3px 0 0 !important;
            height: 22px !important;
            box-sizing: border-box !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value {
            align-self: start !important;
            justify-content: flex-start !important;
            padding: 3px 0 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > span {
            line-height: 15px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > strong {
            margin-top: 2px !important;
          }
        }
      `}</style>


      {/* Scoped layout correction: stable currency/digit alignment and space above the pulse. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          row-gap: 12px !important;
          grid-auto-rows: minmax(0, auto) !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total {
          line-height: 1.2 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total .rolling-total-digits {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          vertical-align: middle !important;
          height: 1.2em !important;
          line-height: 1.2 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total .rolling-digit-static,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total .rolling-digit-slot {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          align-self: center !important;
          height: 1.2em !important;
          line-height: 1.2 !important;
          vertical-align: middle !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .portfolio-index-pulse {
          align-self: start !important;
          margin-top: 4px !important;
          clear: both !important;
        }
      `}</style>
      {/* Nasdaq/S&P market pulse is a full-width last row in the existing combined summary. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          grid-template-areas: "value value value" "return change holdings" "indices indices indices" !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .portfolio-index-pulse {
          grid-area: indices !important;
          grid-column: 1 / -1 !important;
          width: 100% !important;
          min-width: 0 !important;
        }
      `}</style>
      {/* Center Total Return and Total Change labels, values and captions consistently. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          position: relative !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          width: 100% !important;
          min-width: 0 !important;
          text-align: center !important;
          gap: 4px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > *,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > * {
          display: block !important;
          width: 100% !important;
          text-align: center !important;
          align-self: center !important;
          justify-self: center !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          position: absolute !important;
          top: 7px !important;
          right: 4px !important;
          left: auto !important;
          margin: 0 !important;
        }
      `}</style>
      {/* Keep the return/change action icons clear of centered labels. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          overflow: visible !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          right: -5px !important;
          top: 7px !important;
          z-index: 2 !important;
        }
      `}</style>
      {/* Holdings: use the same centered vertical rhythm as Return and Change. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          align-self: stretch !important;
          text-align: center !important;
          padding: 7px 2px !important;
          gap: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 4px !important;
          width: 100% !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content > small {
          display: block !important;
          grid-area: auto !important;
          width: 100% !important;
          align-self: center !important;
          justify-self: center !important;
          margin: 0 !important;
          padding: 0 !important;
          text-align: center !important;
        }
      `}</style>
      {/* Unified overview labels, icon spacing and vertical rhythm. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card .summary-content > span {
          font-size: clamp(9px, 2.45vw, 11px) !important;
          line-height: 1.25 !important;
          font-weight: 850 !important;
          letter-spacing: .02em !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
          display: grid !important;
          grid-template-columns: max-content 22px !important;
          grid-template-rows: 25px minmax(30px,auto) minmax(16px,auto) !important;
          column-gap: 7px !important;
          row-gap: 7px !important;
          justify-content: center !important;
          justify-items: center !important;
          align-content: start !important;
          padding: 7px 2px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > span {
          grid-column: 1 !important;
          grid-row: 1 !important;
          align-self: center !important;
          justify-self: end !important;
          width: auto !important;
          text-align: right !important;
          white-space: nowrap !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-icon-slot,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-icon-slot {
          position: static !important;
          top: auto !important;
          right: auto !important;
          left: auto !important;
          transform: none !important;
          grid-column: 2 !important;
          grid-row: 1 !important;
          justify-self: start !important;
          align-self: center !important;
          width: 22px !important;
          height: 22px !important;
          min-width: 22px !important;
          min-height: 22px !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > strong,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > strong {
          grid-column: 1 / -1 !important;
          grid-row: 2 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2) > .summary-content > small,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) > .summary-content > small {
          grid-column: 1 / -1 !important;
          grid-row: 3 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) {
          justify-content: flex-start !important;
          padding: 7px 2px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(4) > .summary-content {
          gap: 7px !important;
        }
        @media (max-width: 370px) {
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(2),
          .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:nth-child(3) {
            column-gap: 6px !important;
          }
        }
      `}</style>
      {/* One authoritative 3-row layout for the three overview metrics. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          row-gap: 6px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card:nth-child(n+2) {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: flex-start !important;
          min-width: 0 !important;
          min-height: 0 !important;
          height: auto !important;
          padding: 5px 2px 3px !important;
          margin: 0 !important;
          gap: 0 !important;
          text-align: center !important;
          box-sizing: border-box !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-heading {
          display: flex !important;
          flex: 0 0 25px !important;
          height: 25px !important;
          min-height: 25px !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 7px !important;
          white-space: nowrap !important;
          width: 100% !important;
          padding: 0 !important;
          margin: 0 !important;
          line-height: 1.25 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-heading > span {
          display: inline-block !important;
          width: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          text-align: center !important;
          font-size: clamp(9px, 2.45vw, 11px) !important;
          font-weight: 850 !important;
          letter-spacing: .02em !important;
          line-height: 1.25 !important;
          white-space: nowrap !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-action {
          position: relative !important;
          display: flex !important;
          flex: 0 0 22px !important;
          width: 22px !important;
          height: 22px !important;
          align-items: center !important;
          justify-content: center !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-action > .summary-icon-button {
          position: static !important;
          display: grid !important;
          width: 22px !important;
          height: 22px !important;
          min-width: 22px !important;
          min-height: 22px !important;
          place-items: center !important;
          margin: 0 !important;
          padding: 0 !important;
          transform: none !important;
          font-size: 12px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-value {
          display: block !important;
          flex: 0 0 30px !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 30px !important;
          line-height: 30px !important;
          font-size: clamp(14px,3.5vw,19px) !important;
          font-weight: 900 !important;
          margin: 2px 0 0 !important;
          padding: 0 !important;
          text-align: center !important;
          white-space: nowrap !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-note {
          display: block !important;
          width: 100% !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          font-size: 8px !important;
          line-height: 1.25 !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .portfolio-index-pulse {
          margin-top: 0 !important;
        }
        /* Center the LABEL itself, not the label+button group. */
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-heading {
          position: relative !important;
          display: flex !important;
          flex: 0 0 25px !important;
          width: max-content !important;
          max-width: 100% !important;
          height: 25px !important;
          margin-left: auto !important;
          margin-right: auto !important;
          align-self: center !important;
          justify-content: center !important;
          align-items: center !important;
          overflow: visible !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-heading > span {
          flex: 0 0 auto !important;
          width: auto !important;
          color: inherit;
          text-align: center !important;
        }
        /* Keep icons close to the centered labels without shifting label alignment. */
        .app-shell.app-portfolio-active .portfolio-combined-summary .overview-stat-heading > .overview-stat-action {
          position: absolute !important;
          top: 50% !important;
          left: calc(100% + 3px) !important;
          right: auto !important;
          transform: translateY(-50%) !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-value,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-note {
          align-self: center !important;
          text-align: center !important;
        }
        /* Match the three overview metric labels and numbers to Total Value maroon. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card .overview-stat-heading > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-value,
        /* Only the values of Total Return / Total Change are gain-loss colored. */
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive > .total-return-card > .overview-stat-value,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-positive > .overview-stat-card:nth-child(3) > .overview-stat-value {
          color: #dc2626 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative > .total-return-card > .overview-stat-value,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-negative > .overview-stat-card:nth-child(3) > .overview-stat-value {
          color: #2563eb !important;
        }
            `}</style>
      {/* Mobile Top Holdings: definitive top alignment for rank, ticker/company and Total Value. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            align-items: start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            align-self: start !important;
            justify-content: flex-start !important;
            margin-top: 0 !important;
            padding-top: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position > span {
            align-self: center !important;
            margin-top: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            align-self: start !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
            height: auto !important;
            min-height: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity > span {
            align-self: flex-start !important;
            margin-top: 0 !important;
            line-height: 22px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value {
            align-self: start !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
            height: auto !important;
            min-height: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > span {
            align-self: flex-start !important;
            margin: 0 !important;
            line-height: 11px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value > strong {
            align-self: flex-start !important;
            margin: 0 !important;
            line-height: 11px !important;
          }
        }
      `}</style>


      {/* Final portfolio overview alignment: titles and numbers centered; actions beside titles; notes visible. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: flex-start !important;
          height: auto !important;
          min-height: 94px !important;
          overflow: visible !important;
          padding: 5px 2px 8px !important;
          box-sizing: border-box !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-heading {
          position: relative !important;
          display: flex !important;
          flex: 0 0 25px !important;
          align-items: center !important;
          justify-content: center !important;
          align-self: center !important;
          width: fit-content !important;
          max-width: none !important;
          height: 25px !important;
          min-height: 25px !important;
          margin: 0 auto !important;
          padding: 0 !important;
          gap: 0 !important;
          overflow: visible !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-heading > span {
          display: block !important;
          flex: 0 0 auto !important;
          width: max-content !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 !important;
          text-align: center !important;
          white-space: nowrap !important;
          color: #861f41 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-heading > .overview-stat-action {
          position: absolute !important;
          left: calc(100% + 4px) !important;
          right: auto !important;
          top: 50% !important;
          transform: translateY(-50%) !important;
          width: 22px !important;
          height: 22px !important;
          min-width: 22px !important;
          min-height: 22px !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-value {
          display: block !important;
          align-self: center !important;
          flex: 0 0 auto !important;
          width: 100% !important;
          height: auto !important;
          min-height: 28px !important;
          line-height: 28px !important;
          margin: 2px 0 0 !important;
          padding: 0 !important;
          text-align: center !important;
          color: #861f41 !important;
          overflow: visible !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-note {
          display: block !important;
          position: static !important;
          flex: 0 0 auto !important;
          align-self: center !important;
          visibility: visible !important;
          opacity: 1 !important;
          width: 100% !important;
          max-width: 100% !important;
          height: auto !important;
          min-height: 12px !important;
          margin: 2px 0 0 !important;
          padding: 0 !important;
          font-size: 8px !important;
          line-height: 1.4 !important;
          text-align: center !important;
          white-space: normal !important;
          overflow: visible !important;
        }
        /* Only the values of Total Return / Total Change are gain-loss colored. */
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-positive > .total-return-card > .overview-stat-value,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-positive > .overview-stat-card:nth-child(3) > .overview-stat-value {
          color: #dc2626 !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary.performance-negative > .total-return-card > .overview-stat-value,
        .app-shell.app-portfolio-active .portfolio-combined-summary.daily-negative > .overview-stat-card:nth-child(3) > .overview-stat-value {
          color: #2563eb !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .summary-content > span,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total,
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child .portfolio-rolling-total span {
          color: #861f41 !important;
        }
      `}</style>
      {/* Minimal portfolio overview spacing: tighten only Total Return heading-to-value, hide the pulse separator. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .portfolio-index-pulse {
          border-top: 0 !important;
        }
        /* Equal row tracks across Total Return, Total Change, and Holdings. */
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) !important;
          grid-template-rows: 25px 30px minmax(14px, auto) !important;
          row-gap: 2px !important;
          justify-items: center !important;
          align-content: start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-heading {
          grid-row: 1 !important;
          align-self: center !important;
          height: 25px !important;
          min-height: 25px !important;
          margin: 0 auto !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-value {
          grid-row: 2 !important;
          align-self: center !important;
          min-height: 30px !important;
          height: 30px !important;
          line-height: 30px !important;
          margin: 0 !important;
          text-align: center !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card > .overview-stat-note {
          grid-row: 3 !important;
          align-self: start !important;
          min-height: 14px !important;
          margin: 0 !important;
          text-align: center !important;
        }
      `}</style>

      {/* Top Holdings: single aligned grid, first-row top alignment, Shares left-aligned. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row {
            display: grid !important;
            grid-template-areas: "position identity value" "position cost pnl" "position allocation shares" !important;
            grid-template-columns: 50px minmax(0, 1fr) 105px !important;
            grid-template-rows: repeat(3, minmax(27px, auto)) !important;
            column-gap: 9px !important;
            row-gap: 4px !important;
            align-items: start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-position {
            grid-area: position !important;
            align-self: start !important;
            justify-content: flex-start !important;
            margin-top: 0 !important;
            padding-top: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-identity {
            grid-area: identity !important;
            align-self: start !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
            height: auto !important;
            min-height: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.value {
            grid-area: value !important;
            align-self: start !important;
            justify-content: flex-start !important;
            align-items: flex-start !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.cost { grid-area: cost !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return { grid-area: pnl !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.allocation { grid-area: allocation !important; }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares {
            grid-area: shares !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
            text-align: left !important;
            justify-self: stretch !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat.shares > strong {
            display: block !important;
            width: 100% !important;
            text-align: left !important;
            align-self: flex-start !important;
            margin-left: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-stat,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-return {
            align-self: start !important;
          }
        }
      `}</style>


      {/* Top Holdings: uniform label/value spacing for all five metrics and all five holdings. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.value,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.cost,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-return,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.allocation,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.shares {
            display: flex !important;
            flex-direction: column !important;
            justify-content: flex-start !important;
            align-items: flex-start !important;
            text-align: left !important;
            gap: 0 !important;
            padding: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-return > span {
            display: block !important;
            height: 12px !important;
            min-height: 12px !important;
            line-height: 12px !important;
            margin: 0 !important;
            padding: 0 !important;
            text-align: left !important;
            align-self: flex-start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat > strong,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-return > strong {
            display: block !important;
            height: 15px !important;
            min-height: 15px !important;
            line-height: 15px !important;
            margin: 3px 0 0 !important;
            padding: 0 !important;
            text-align: left !important;
            align-self: flex-start !important;
          }
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.shares > span,
          .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holding-row .top-holding-stat.shares > strong {
            width: 100% !important;
            text-align: left !important;
            align-self: flex-start !important;
            margin-left: 0 !important;
            padding-left: 0 !important;
          }
        }
      `}</style>

      {/* Holdings search placeholder: a placeholder needs its own pseudo-element color. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .holdings-card-full .holdings-heading .table-tools input::placeholder,
        .app-shell.app-portfolio-active .holdings-card-full .holdings-heading .table-tools input {
          color: #303846 !important;
          opacity: 1 !important;
          -webkit-text-fill-color: #303846 !important;
        }
        .market-pulse-duration-value { color: #303846 !important; font-weight: 800 !important; opacity: 1 !important; }
      `}</style>

      {/* Holdings mobile controls: match orange stock-card width and unify control typography only. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools {
            box-sizing: border-box !important;
            margin-left: -2px !important;
            width: calc(100% + 20px) !important;
            max-width: none !important;
            min-width: 0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools input,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools input::placeholder,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools select,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools .clear-button {
            font-size: 12px !important;
            font-weight: 700 !important;
            letter-spacing: 0 !important;
          }
        }
        @media (max-width: 560px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading .table-tools {
            margin-left: -6px !important;
            width: calc(100% + 24px) !important;
          }
        }
      `}</style>

      {/* Holdings mobile: keep the Clear all -> first stock card spacing consistent with the tool grid gap. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading {
            padding-bottom: 8px !important;
            margin-bottom: 0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .table-scroll {
            margin-top: 0 !important;
          }
        }
      `}</style>


      {/* Allocation by Category: compact expanded layout only. */}
      <style jsx global>{`
        /* Keep the heading's top baseline identical when toggling the chart. */
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading {
          align-items: flex-start !important;
          justify-content: space-between !important;
          padding-top: 8px !important;
          margin-top: 0 !important;
          transform: none !important;
          border-bottom: 0 !important;
          box-shadow: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > div:first-child {
          align-self: flex-start !important;
          margin-top: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .allocation-category-title-word {
          display: inline;
          font: inherit !important;
          color: inherit !important;
          letter-spacing: inherit !important;
          line-height: inherit !important;
          font-weight: inherit !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .allocation-category-title-word-expanded {
          display: block;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) > .section-heading::after {
          display: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
          width: min(100%, 351px) !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-list {
          gap: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
          min-height: 31px !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) {
            min-height: 0 !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
            gap: 9px !important;
            padding: 10px 14px 14px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
            width: min(100%, 288px) !important;
            max-width: calc(100vw - 64px) !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
            min-height: 29px !important;
            padding-top: 2px !important;
            padding-bottom: 2px !important;
          }
        }
      `}</style>


      {/* Portfolio: exact 8px heading-to-border spacing, preserving other layout. */}
      <style jsx global>{`
        /* Total Value: both wrapper and first inner card must start at the top. */
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          padding-top: 8px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child {
          padding-top: 0 !important;
          justify-content: flex-start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content {
          justify-content: flex-start !important;
        }
        /* Collapsed panel: same 8px below the header as above it. */
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card > .section-heading {
          padding-top: 8px !important;
          margin-top: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card.portfolio-panel-collapsed > .section-heading,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card.portfolio-panel-collapsed > .section-heading {
          padding-bottom: 8px !important;
          margin-bottom: 0 !important;
        }
        /* Holdings has its own outer padding: adjust only the top to avoid double spacing. */
        .app-shell.app-portfolio-active > .page-wrap > .holdings-card {
          padding-top: 8px !important;
        }
        .app-shell.app-portfolio-active > .page-wrap > .holdings-card > .holdings-heading {
          padding-top: 0 !important;
          margin-top: 0 !important;
        }
      `}</style>


      {/* Portfolio: consistent 8px inset at top and bottom of collapsed headings. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card.portfolio-panel-collapsed,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card.portfolio-panel-collapsed {
          padding-top: 0 !important;
          padding-bottom: 0 !important;
          row-gap: 0 !important;
          gap: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card.portfolio-panel-collapsed > .section-heading,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card.portfolio-panel-collapsed > .section-heading {
          flex: 0 0 auto !important;
          min-height: 0 !important;
          height: auto !important;
          padding-top: 8px !important;
          padding-bottom: 8px !important;
          margin-top: 0 !important;
          margin-bottom: 0 !important;
          transform: none !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          padding-top: 8px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child {
          padding-top: 0 !important;
          align-items: center !important;
          justify-content: flex-start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content {
          justify-content: flex-start !important;
          margin-top: 0 !important;
          padding-top: 0 !important;
        }
      `}</style>

      {/* Total Value only: exact top inset from the orange outer border; keep the title in normal flow. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          padding-top: 8px !important;
          align-content: start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child {
          padding-top: 0 !important;
          margin-top: 0 !important;
          align-self: start !important;
          justify-content: flex-start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content {
          padding-top: 0 !important;
          margin-top: 0 !important;
          justify-content: flex-start !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content > span:first-child {
          display: block !important;
          position: static !important;
          transform: none !important;
          margin-top: 0 !important;
          padding-top: 0 !important;
        }

      /* Company marks: preserve true image aspect ratio in both Portfolio lists. */
      .app-shell.app-portfolio-active .top-holding-logo .company-mark,
      .app-shell.app-portfolio-active .holdings-card .asset-cell .company-mark {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 auto !important;
        border-radius: 50% !important;
        overflow: hidden !important;
      }
      .app-shell.app-portfolio-active .top-holding-logo .company-mark img,
      .app-shell.app-portfolio-active .holdings-card .asset-cell .company-mark img {
        display: block !important;
        width: 78% !important;
        height: 78% !important;
        object-fit: contain !important;
        object-position: center !important;
        max-width: 78% !important;
        max-height: 78% !important;
        margin: auto !important;
        transform: none !important;
      }

      /* Portfolio company logos: fixed round container and true aspect ratio. */
      .app-shell.app-portfolio-active .holdings-card .asset-cell .company-mark {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 50% !important;
        aspect-ratio: 1 / 1 !important;
        overflow: hidden !important;
        flex-shrink: 0 !important;
      }
      .app-shell.app-portfolio-active .holdings-card .asset-cell .company-mark img {
        display: block !important;
        width: 78% !important;
        height: 78% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: 78% !important;
        max-height: 78% !important;
        object-fit: contain !important;
        object-position: center !important;
        margin: auto !important;
        padding: 0 !important;
        transform: none !important;
      }
      `}</style>

      {/* Overview helper notes removed: reclaim their unused vertical track only. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .overview-stat-card {
          grid-template-rows: 25px 30px !important;
          min-height: 0 !important;
          padding-bottom: 2px !important;
        }
      `}</style>

      {/* Portfolio text legibility: Total Value USD line uses the same darker gray as other secondary labels. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child > .summary-content > small {
          color: #303846 !important;
        }
      `}</style>

      {/* The time-axis ticks are SVG text (not HTML span elements). */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-index-pulse .index-pulse-monitor svg > text {
          fill: #f1f5f9 !important;
          font-size: 10px !important;
          font-weight: 850 !important;
          paint-order: stroke fill;
          stroke: rgba(4, 14, 28, .8);
          stroke-width: 1px;
          stroke-linejoin: round;
        }
      `}</style>

      {/* Market Pulse: directly target the interval/elapsed-time text, not just generic class guesses. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .portfolio-index-pulse .index-pulse-footnote,
        .app-shell.app-portfolio-active .portfolio-index-pulse .index-pulse-footnote span,
        .app-shell.app-portfolio-active .portfolio-index-pulse [class*="interval"],
        .app-shell.app-portfolio-active .portfolio-index-pulse [class*="timeframe"],
        .app-shell.app-portfolio-active .portfolio-index-pulse [class*="period"] {
          color: #303846 !important;
        }
      `}</style>

      {/* Compact Portfolio Holdings cards only: reduce vertical whitespace while preserving field alignment and touch targets. */}
      <style jsx global>{`
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody {
            gap: 6px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody tr {
            min-height: 0 !important;
            height: auto !important;
            padding: 8px 10px !important;
            column-gap: 9px !important;
            row-gap: 5px !important;
            align-items: center !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .asset-column {
            min-height: 34px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .asset-copy {
            gap: 1px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .price-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .avg-cost-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .cost-return-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .shares-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .value-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column {
            min-height: 0 !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody tr:last-child {
            margin-bottom: 10px !important;
          }
        }
      `}</style>

      {/* Portfolio Holdings: match the darker neutral text used in Top Holdings. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .holdings-card .mobile-field-label,
        .app-shell.app-portfolio-active .holdings-card .company-name,
        .app-shell.app-portfolio-active .holdings-card .mobile-category,
        .app-shell.app-portfolio-active .holdings-card .category-pill,
        .app-shell.app-portfolio-active .holdings-card .avg-cost-column > span:not(.mobile-field-label),
        .app-shell.app-portfolio-active .holdings-card .price-column > span:not(.mobile-field-label):not(.change),
        .app-shell.app-portfolio-active .holdings-card .value-column > span:not(.mobile-field-label),
        .app-shell.app-portfolio-active .holdings-card .cost-return-column > .pl-krw {
          color: #303846 !important;
        }
        .app-shell.app-portfolio-active .holdings-card .allocation-cell > b,
        .app-shell.app-portfolio-active .holdings-card .asset-copy .asset-name-line > b {
          color: #303846 !important;
        }
      `}</style>

      {/* Holdings: align both data rows on the same three column guides; show KRW consistently. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .holdings-card .holding-krw-amount {
          display: block !important;
          color: #303846 !important;
          font-size: 10px !important;
          font-weight: 650 !important;
          line-height: 1.25 !important;
          letter-spacing: 0 !important;
          white-space: nowrap !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card tbody tr {
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
            grid-template-areas:
              "asset asset actions"
              "price avgcost pnl"
              "shares value allocation" !important;
            align-items: start !important;
            column-gap: 8px !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .price-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .avg-cost-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .cost-return-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .shares-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .value-column,
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .allocation-column {
            display: flex !important;
            flex-direction: column !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
            align-self: start !important;
            padding: 0 !important;
            margin: 0 !important;
            min-width: 0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .mobile-field-label {
            display: block !important;
            height: 13px !important;
            min-height: 13px !important;
            margin: 0 0 4px !important;
            line-height: 13px !important;
            white-space: nowrap !important;
            letter-spacing: 0 !important;
          }
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .holding-krw-amount {
            margin-top: 3px !important;
          }
          /* Align the Shares input box with the left edge of its field label. */
          .app-shell.app-portfolio-active > .page-wrap > .holdings-card .shares-column > .shares-input {
            display: block !important;
            align-self: flex-start !important;
            margin-left: 0 !important;
            margin-right: auto !important;
            transform: none !important;
            box-sizing: border-box !important;
          }
        }
      `}</style>

      {/* Portfolio header: visible Total Value top inset and centered Allocation toggle. */}
      <style jsx global>{`
        /* The glyph's visible top is inside its line box; use optical inset rather than 8px line-box padding. */
        .app-shell.app-portfolio-active .portfolio-combined-summary {
          padding-top: 14px !important;
        }
        .app-shell.app-portfolio-active .portfolio-combined-summary > .summary-card:first-child {
          padding-top: 0 !important;
          margin-top: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading {
          align-items: center !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > div:first-child {
          align-self: flex-start !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > .portfolio-fold-actions {
          align-self: center !important;
          align-items: center !important;
          margin-top: auto !important;
          margin-bottom: auto !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > .portfolio-fold-actions > .portfolio-fold-toggle {
          align-self: center !important;
        }
        /* Allocation: controls in two rows; chart left and legend right. */
        .app-shell.app-portfolio-active .allocation-category-card .allocation-heading-controls {
          display: flex; flex-direction: column; align-items: flex-end; gap: 5px; min-width: 0;
        }
        .app-shell.app-portfolio-active .allocation-category-card .allocation-heading-controls > .portfolio-fold-actions {
          display: flex; align-items: center; justify-content: flex-end; flex-wrap: nowrap; gap: 6px;
          margin: 0 !important; align-self: auto !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card .allocation-heading-controls > .allocation-view-switch {
          align-self: flex-end; margin: 0; height: 25px; font-size: 10px;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
          display: grid !important; grid-template-columns: minmax(0, 58%) minmax(0, 1fr) !important;
          align-items: center !important; gap: 3px !important; padding: 12px 6px 16px !important;
          width: 100% !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-zone {
          display: flex !important; align-items: center !important; justify-content: flex-start !important;
          width: 100% !important; min-width: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
          width: min(100%, 335px) !important; max-width: 100% !important;
          margin: 0 !important; flex: 0 1 auto !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-center strong {
          font-size: clamp(9px, 1.5vw, 17px) !important; margin-top: 3px !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-center span {
          font-size: 9px !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-list {
          width: 100% !important; min-width: 0 !important; align-self: center !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
          gap: 2px !important; padding-left: 0 !important; padding-right: 0 !important; justify-content: flex-start !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name {
          gap: 3px !important; flex: 0 1 auto !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
          flex: 0 0 auto !important; text-align: left !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name,
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
          font-size: 11px !important; font-weight: 800 !important; line-height: 1.3 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) > .section-heading {
          padding-top: 15px !important;
        }

        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
            grid-template-columns: minmax(0, 57%) minmax(0, 1fr) !important;
            gap: 3px !important; padding: 9px 5px 13px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
            width: 100% !important; max-width: 290px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-center strong {
            font-size: clamp(8px, 2.4vw, 13px) !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
            min-height: 24px !important; gap: 4px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name,
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
            font-size: 10px !important; font-weight: 800 !important;
          }
        }
        /* Allocation panel: generous separation above chart and below upper controls. */
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) > .section-heading {
          padding-top: 26px !important;
          padding-bottom: 20px !important;
          margin-bottom: 0 !important;
          align-items: flex-start !important;
          flex: 0 0 auto !important;
          min-height: 0 !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card .allocation-heading-controls {
          padding-top: 0 !important;
          align-self: flex-start !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
          padding-top: 24px !important;
          background: transparent !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .category-donut-zone {
          background: transparent !important;
          background-color: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
          justify-content: space-between !important;
          width: 100% !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name {
          flex: 1 1 auto !important;
          text-align: left !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
          flex: 0 0 auto !important;
          margin-left: auto !important;
          text-align: right !important;
          font-weight: 800 !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) > .section-heading {
            padding-top: 24px !important;
            padding-bottom: 18px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
            padding-top: 20px !important;
          }
        }
        /* Total Return detail: align all popover contents to the left only. */
        .app-shell.app-portfolio-active .total-return-card .total-return-popover {
          align-items: flex-start !important;
          justify-content: flex-start !important;
          text-align: left !important;
        }
        .app-shell.app-portfolio-active .total-return-card .total-return-popover > span,
        .app-shell.app-portfolio-active .total-return-card .total-return-popover > strong {
          align-self: flex-start !important;
          text-align: left !important;
        }

        /* Top Holdings podium: medal backgrounds, not numeral colors. */
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holdings-list > .top-holding-row:nth-child(1) .top-holding-position > span { background: #D4A017 !important; border-color: #D4A017 !important; color: #FFFFFF !important; }
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holdings-list > .top-holding-row:nth-child(2) .top-holding-position > span { background: #8C98A8 !important; border-color: #8C98A8 !important; color: #FFFFFF !important; }
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card .top-holdings-list > .top-holding-row:nth-child(3) .top-holding-position > span { background: #B87333 !important; border-color: #B87333 !important; color: #FFFFFF !important; }

      `}
</style>


      {/* Allocation chart: fixed donut placement across modes, clean white panel,
          comfortable outer gutters and right-aligned values. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
          grid-template-columns: minmax(0, 55%) minmax(0, 1fr) !important;
          column-gap: 12px !important;
          padding: 24px 16px 18px !important;
          align-items: start !important;
          background: #ffffff !important;
          background-image: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-zone {
          width: 100% !important;
          align-self: start !important;
          justify-content: flex-start !important;
          align-items: flex-start !important;
          background: transparent !important;
          background-image: none !important;
          border: 0 !important;
          box-shadow: none !important;
          padding: 0 !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
          width: min(100%, 335px) !important;
          margin: 0 !important;
          align-self: flex-start !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-list {
          align-self: start !important;
          background: transparent !important;
          padding-right: 0 !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
          display: flex !important;
          justify-content: space-between !important;
          gap: 8px !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name {
          flex: 1 1 auto !important;
          min-width: 0 !important;
          text-align: left !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
          flex: 0 0 auto !important;
          margin-left: auto !important;
          text-align: right !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
            grid-template-columns: minmax(0, 54%) minmax(0, 1fr) !important;
            column-gap: 9px !important;
            padding: 20px 11px 14px !important;
          }
        }
      `}</style>

      {/* Allocation final polish: no rectangular backdrop, larger fixed donut,
          compact aligned legend, and a readable center total. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card {
          background: #fff !important;
          background-image: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
          grid-template-columns: minmax(0, 62%) minmax(0, 1fr) !important;
          column-gap: 7px !important;
          padding: 24px 10px 18px !important;
          background: transparent !important;
          background-color: transparent !important;
          background-image: none !important;
          box-shadow: none !important;
          border: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout::before,
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout::after,
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-zone::before,
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-zone::after {
          content: none !important;
          display: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-zone {
          background: transparent !important;
          background-image: none !important;
          border: none !important;
          box-shadow: none !important;
          align-self: start !important;
          align-items: flex-start !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut {
          width: min(100%, 400px) !important;
          max-width: 100% !important;
          background-color: transparent;
          box-shadow: none !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-center strong {
          width: max-content !important;
          max-width: none !important;
          font-size: clamp(17px, 2.3vw, 29px) !important;
          line-height: 1.08 !important;
          transform: none !important;
          overflow: visible !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-list {
          width: 100% !important;
          padding: 0 !important;
          gap: 3px !important;
          background: transparent !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          gap: 3px !important;
          padding: 0 !important;
          width: 100% !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-name {
          min-width: 0 !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-row strong {
          justify-self: end !important;
          margin: 0 !important;
          text-align: right !important;
        }
        @media(max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
            grid-template-columns: minmax(0, 61%) minmax(0, 1fr) !important;
            column-gap: 6px !important;
            padding: 20px 8px 14px !important;
          }
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-donut-center strong {
            font-size: clamp(15px, 4.2vw, 23px) !important;
          }
        }
      `}</style>

      {/* Detail view: compact viewport for roughly 5-6 holdings; remaining rows scroll. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card.allocation-detail-expanded {
          height: 525px !important;
          min-height: 525px !important;
          align-self: start !important;
          overflow: hidden !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-overlay {
          inset: 78px 10px 10px !important;
          max-width: calc(100% - 20px) !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-body {
          grid-template-columns: 78px minmax(0, 1fr) !important;
          gap: 9px !important;
          padding: 9px !important;
          min-height: 0 !important;
          flex: 1 1 auto !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .stacked-bar {
          width: 59px !important;
          height: 100% !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-list {
          min-height: 0 !important;
          overflow-y: auto !important;
          overscroll-behavior: contain;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-row {
          min-height: 40px !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-header {
          min-height: 49px !important;
          padding: 9px 12px !important;
          gap: 8px !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-header h3 {
          font-size: 14px !important;
          margin-top: 2px !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-name b,
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-row strong {
          font-size: 11px !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-name small {
          font-size: 9px !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-portfolio-active .main-grid > .allocation-category-card.allocation-detail-expanded {
            height: 475px !important;
            min-height: 475px !important;
          }
          .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-overlay {
            inset: 70px 8px 8px !important;
            max-width: calc(100% - 16px) !important;
          }
          .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-body {
            grid-template-columns: 61px minmax(0, 1fr) !important;
            gap: 7px !important;
            padding: 8px !important;
          }
          .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .stacked-bar {
            width: 48px !important;
          }
          .app-shell.app-portfolio-active .allocation-category-card.allocation-detail-expanded .category-detail-row {
            min-height: 38px !important;
          }
        }
      `}</style>

      {/* Stock details: fit all ten positions in the existing panel without an internal scroll.
          Category details retain their independent row sizing and scroll behavior. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-list {
          overflow-y: hidden !important;
          padding-right: 0 !important;
          display: grid !important;
          grid-template-rows: repeat(10, minmax(0, 1fr)) !important;
          align-content: stretch !important;
          min-height: 0 !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-row {
          min-height: 0 !important;
          height: 100% !important;
          gap: 5px !important;
          padding: 0 2px !important;
          box-sizing: border-box !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-name {
          min-width: 0 !important;
          gap: 5px !important;
          grid-template-columns: 9px minmax(38px, auto) minmax(0, 1fr) !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-name b,
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-row strong {
          font-size: 10px !important;
          line-height: 1.1 !important;
        }
        .app-shell.app-portfolio-active .allocation-category-card.allocation-stock-detail .category-detail-name small {
          font-size: 8px !important;
          line-height: 1.1 !important;
        }
      `}</style>

      {/* Allocation header: same fold-control position as Top Holdings in both states.
          The stock/category switch stays on its own second line. */}
      <style jsx global>{`
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading,
        .app-shell.app-portfolio-active .main-grid > .top-holdings-card > .section-heading {
          padding-top: 8px !important;
          padding-bottom: 8px !important;
          margin-top: 0 !important;
          box-sizing: border-box !important;
          align-items: center !important;
          min-height: 0 !important;
          height: auto !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card > .section-heading > div:first-child {
          align-self: center !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .allocation-heading-controls {
          display: flex !important;
          flex-direction: column !important;
          align-items: flex-end !important;
          align-self: center !important;
          justify-content: flex-start !important;
          gap: 5px !important;
          padding: 0 !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .allocation-heading-controls > .portfolio-fold-actions {
          align-self: flex-end !important;
          margin: 0 !important;
          gap: 6px !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card .allocation-heading-controls > .allocation-view-switch {
          align-self: flex-end !important;
          margin: 0 !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) > .section-heading {
          padding-top: 8px !important;
          padding-bottom: 8px !important;
          margin-bottom: 0 !important;
          flex: 0 0 auto !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card:not(.portfolio-panel-collapsed) .category-allocation-layout {
          padding-top: 24px !important;
        }
        .app-shell.app-portfolio-active .main-grid > .allocation-category-card.portfolio-panel-collapsed > .section-heading {
          padding-top: 8px !important;
          padding-bottom: 8px !important;
        }
      `}</style>

  </main>;
}
