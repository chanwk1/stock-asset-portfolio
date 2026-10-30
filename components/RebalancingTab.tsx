"use client";

import { useEffect, useMemo, useState } from "react";
import type { CalculatedHolding } from "../lib/portfolio-calculations";

type MarketMetric = {
  ticker: string;
  price: number | null;
  sma60: number | null;
  sma120: number | null;
  sma120Previous: number | null;
  return1Day: number | null;
  return3Month: number | null;
  return1Year: number | null;
  return3Year: number | null;
  high52Week: number | null;
  low52Week: number | null;
  error?: string;
};

type SignalSide = "BUY" | "SELL" | "BALANCED";

type ScoredRow = {
  holding: CalculatedHolding;
  targetAllocation: number;
  absoluteGap: number;
  score: number;
  side: SignalSide;
  level: 0 | 1 | 2 | 3;
  metric?: MarketMetric;
  fullAdjustmentShares: number;
  recommendedShares: number;
  executionRatio: number;
  dailyBudgetUsd: number;
};

const TARGET_STORAGE_KEY = "stock-portfolio-target-allocations-v1";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatPercent(value: number | null | undefined, digits = 1) {
  if (!finite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function levelLabel(side: SignalSide, level: number) {
  if (side === "BALANCED") return "목표 비중 일치";
  if (level === 0) return "단계 조건 미충족";
  return `${side === "BUY" ? "매수" : "매도"} ${level}단계`;
}

function calculateSignal(
  currentAllocation: number,
  targetAllocation: number,
  metric?: MarketMetric,
): { side: SignalSide; level: 0 | 1 | 2 | 3 } {
  const gap = targetAllocation - currentAllocation;
  if (Math.abs(gap) < 0.01) return { side: "BALANCED", level: 0 };

  if (!metric || !finite(metric.price)) {
    return { side: gap > 0 ? "BUY" : "SELL", level: 0 };
  }

  if (gap > 0) {
    // A negative same-day return is mandatory before entering any BUY stage.
    // Missing, zero or positive daily returns remain at stage 0.
    if (!finite(metric.return1Day) || metric.return1Day >= 0) {
      return { side: "BUY", level: 0 };
    }

    const return3Month = finite(metric.return3Month)
      ? metric.return3Month
      : Number.POSITIVE_INFINITY;

    const distance60 =
      finite(metric.sma60) && metric.sma60 > 0
        ? (metric.price / metric.sma60 - 1) * 100
        : Number.POSITIVE_INFINITY;

    if (return3Month <= -30 || distance60 <= -30) {
      return { side: "BUY", level: 3 };
    }
    if (return3Month <= -20 || distance60 <= -20) {
      return { side: "BUY", level: 2 };
    }
    if (return3Month <= -10 || distance60 <= -10) {
      return { side: "BUY", level: 1 };
    }
    return { side: "BUY", level: 0 };
  }

  // A positive same-day return is mandatory before entering any SELL stage.
  if (!finite(metric.return1Day) || metric.return1Day <= 0) {
    return { side: "SELL", level: 0 };
  }

  // A nonnegative, verified 1-year return is required for every SELL stage.
  // Missing or negative annual data cannot trigger a sell, even on an up day.
  if (!finite(metric.return1Year) || metric.return1Year < 0) {
    return { side: "SELL", level: 0 };
  }
  const return1Year = metric.return1Year;
  if (return1Year >= 200) return { side: "SELL", level: 3 };
  if (return1Year >= 100) return { side: "SELL", level: 2 };
  return { side: "SELL", level: 1 };
}

function calculateBuyDrawdown(metric?: MarketMetric) {
  if (!metric) return null;

  const return3MonthDrawdown =
    finite(metric.return3Month) ? Math.max(0, -metric.return3Month) : null;
  const distance60 = finite(metric.price) && finite(metric.sma60) && metric.sma60 > 0
    ? (metric.price / metric.sma60 - 1) * 100 : null;
  const distance60Drawdown = finite(distance60) ? Math.max(0, -distance60) : null;
  const candidates = [return3MonthDrawdown, distance60Drawdown].filter(finite);
  return candidates.length ? Math.max(...candidates) : null;
}

// 기본점수는 단계 안에서도 지표 강도에 따라 1점씩 증가한다.
// 매수: 3개월 수익률 하락폭과 60일선 이격도 하락폭 중 큰 값을 사용한다.
// 1단계 10~20% => 30~45점, 2단계 20~30% => 60~70점,
// 3단계 30~50% => 70~85점 (50% 이상은 85점 상한).
function calculateBuyTechnicalScore(drawdown: number | null) {
  if (!finite(drawdown) || drawdown < 10) return 0;
  if (drawdown < 20) return 30 + (drawdown - 10) / 10 * 15;
  if (drawdown < 30) return 60 + (drawdown - 20) / 10 * 10;
  return 70 + clamp((drawdown - 30) / 20, 0, 1) * 15;
}

// 매도: 1년 수익률을 주축으로 기본점수 차등화한다.
// 1단계는 52주 고점 근접도도 함께 반영한다.
// 2단계 100~200% => 60~70점, 3단계 200~400% => 70~85점.
function calculateSellTechnicalScore(metric?: MarketMetric) {
  if (!metric) return 0;
  const annual = finite(metric.return1Year) ? metric.return1Year : null;
  const highRatio = finite(metric.price) && finite(metric.high52Week) && metric.high52Week > 0
    ? metric.price / metric.high52Week : null;
  if (annual !== null && annual >= 200) {
    return 70 + clamp((annual - 200) / 200, 0, 1) * 15;
  }
  if (annual !== null && annual >= 100) {
    return 60 + (annual - 100) / 100 * 10;
  }
  const annualProgress = annual === null ? 0 : clamp(annual / 100, 0, 1);
  const proximityProgress = highRatio === null ? 0 : clamp((highRatio - 0.8) / 0.2, 0, 1);
  return 30 + Math.max(annualProgress, proximityProgress) * 15;
}

// 공포·탐욕 applies only to BUY; lower 공포·탐욕 receives more points.
// The eligible range tightens by stage (45 / 35 / 25).
// A missing 공포·탐욕 is never treated as oversold.
function buyRsiBonus(stage: number, rsi: number | null | undefined) {
  if (stage < 1 || !finite(rsi)) return 0;
  const limits = stage === 1 ? { entry: 45, full: 30 }
    : stage === 2 ? { entry: 35, full: 20 }
    : { entry: 25, full: 10 };
  return 5 * clamp((limits.entry - rsi) / (limits.entry - limits.full), 0, 1);
}

// SELL 공포·탐욕 mirrors BUY: higher 공포·탐욕 scores more, with stricter ranges by stage.
function sellRsiBonus(stage: number, rsi: number | null | undefined) {
  if (stage < 1 || !finite(rsi)) return 0;
  const limits = stage === 1 ? { entry: 55, full: 70 }
    : stage === 2 ? { entry: 65, full: 80 }
    : { entry: 75, full: 90 };
  return 5 * clamp((rsi - limits.entry) / (limits.full - limits.entry), 0, 1);
}

function calculateContinuousScore(
  signal: { side: SignalSide; level: 0 | 1 | 2 | 3 },
  metric?: MarketMetric,
  fearGreed?: number | null,
) {
  if (signal.side === "BALANCED") return 0;

  const technicalScore =
    signal.side === "BUY"
      ? calculateBuyTechnicalScore(calculateBuyDrawdown(metric))
      : calculateSellTechnicalScore(metric);

  const near52Low =
    signal.side === "BUY" &&
    finite(metric?.price) &&
    finite(metric?.low52Week) &&
    metric.low52Week > 0 &&
    metric.price >= metric.low52Week * 0.95 &&
    metric.price <= metric.low52Week * 1.05;

  const near52High =
    signal.side === "SELL" &&
    finite(metric?.price) &&
    finite(metric?.high52Week) &&
    metric.high52Week > 0 &&
    metric.price >= metric.high52Week * 0.9 &&
    metric.price <= metric.high52Week * 1.1;

  // Daily direction is an entry condition, not a bonus, for both sides.
  const proximityBonus = near52Low || near52High ? 10 : 0;
  const rsiBonus = signal.side === "BUY"
    ? buyRsiBonus(signal.level, fearGreed)
    : sellRsiBonus(signal.level, fearGreed);
  const totalBonus = signal.level > 0 ? proximityBonus + rsiBonus : 0;

  // 단계 진입 기준은 그대로 유지하고 기본점수만 지표에 따라 변화시킨다.
  // 최대 기본 85점 + 52주 근접 10점 + 공포·탐욕 5점 = 100점.
  const baseStageScore = signal.level === 0 ? 0 : technicalScore;
  const stageMaximum = signal.level === 1 ? 59 : signal.level === 2 ? 84 : 100;
  const finalScore = signal.level === 0
    ? 0
    : Math.min(stageMaximum, baseStageScore + totalBonus);

  return Math.round(clamp(finalScore, 0, 100));
}

function ScoreBadge({ score }: { score: number }) {
  const band = score >= 85 ? "very-high" : score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const displayScore = Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1);

  return (
    <div className={`rebalance-score ${band}`} title="매수는 당일 하락을 필수 조건으로 하고 52주 저점 근접 +10점과 단계별 공포·탐욕 최대 +5점을 적용합니다. 매도도 당일 상승 필수 조건과 고점 근접 +10점·공포·탐욕 최대 +5점을 적용합니다.">
      <strong>{displayScore}</strong>
      <span>/100</span>
    </div>
  );
}

function SignalBadge({ side, level }: { side: SignalSide; level: number }) {
  const direction = side === "BUY" ? "buy" : side === "SELL" ? "sell" : "balanced";

  return (
    <div className={`signal-badge ${direction} level-${level}`}>
      <div className="signal-stage-bar" aria-label={level > 0 ? `${level}단계` : "단계 조건 미충족"}>
        {[1, 2, 3].map((stage) => (
          <i
            key={stage}
            className={`stage-${stage}${stage <= level ? " active" : ""}`}
            title={`${stage}단계`}
          />
        ))}
      </div>
      <b>{levelLabel(side, level)}</b>
    </div>
  );
}

export default function RebalancingTab({ holdings }: { holdings: CalculatedHolding[] }) {
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [metrics, setMetrics] = useState<Record<string, MarketMetric>>({});
  const [loading, setLoading] = useState(false);
  const [loadedTargets, setLoadedTargets] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [fearGreed, setFearGreed] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TARGET_STORAGE_KEY);
      if (saved) setTargets(JSON.parse(saved) as Record<string, number>);
    } catch {
      // 잘못된 저장값은 무시하고 현재 비중으로 초기화합니다.
    } finally {
      setLoadedTargets(true);
    }
  }, []);

  useEffect(() => {
    if (!loadedTargets) return;
    setTargets((current) => {
      const next = { ...current };
      let changed = false;
      holdings.forEach((holding) => {
        if (!finite(next[holding.ticker])) {
          next[holding.ticker] = Number(holding.allocation.toFixed(2));
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [holdings, loadedTargets]);

  useEffect(() => {
    if (!loadedTargets) return;
    window.localStorage.setItem(TARGET_STORAGE_KEY, JSON.stringify(targets));
  }, [targets, loadedTargets]);

  useEffect(() => {
    const tickers = holdings.map((holding) => holding.ticker).filter(Boolean);
    if (!tickers.length) {
      setMetrics({});
      return;
    }

    let cancelled = false;

    const loadHistory = async () => {
      setLoading(true);

      try {
        const response = await fetch(
          `/api/rebalancing-data?symbols=${encodeURIComponent(tickers.join(","))}&t=${Date.now()}`,
          { cache: "no-store" },
        );

        if (!response.ok) throw new Error("시장 데이터를 가져오지 못했습니다.");

        const payload = await response.json() as { data?: MarketMetric[] };
        if (cancelled) return;

        setMetrics((current) => {
          const next = { ...current };

          for (const item of payload.data ?? []) {
            const previous = current[item.ticker];
            next[item.ticker] = {
              ...previous,
              ...item,
                            // 실시간 전용 API가 이미 가져온 당일 값은 장기 API의 null로 덮지 않습니다.
              return1Day: finite(previous?.return1Day)
                ? previous.return1Day
                : item.return1Day,
              price: finite(previous?.price)
                ? previous.price
                : item.price,
            };
          }

          return next;
        });
      } catch {
        // 장기 지표 요청 실패가 실시간 시세를 지우지 않도록 유지합니다.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [holdings.map((holding) => holding.ticker).join(",")]);

  useEffect(() => {
    const tickers = holdings.map((holding) => holding.ticker).filter(Boolean);
    if (!tickers.length) return;

    let cancelled = false;
    const pending = new Set(tickers);

    const fetchOne = async (ticker: string) => {
      try {
        const response = await fetch(
          `/api/live-quotes?symbols=${encodeURIComponent(ticker)}&t=${Date.now()}`,
          { cache: "no-store" },
        );

        if (!response.ok) return false;

        const payload = await response.json() as {
          data?: Array<{
            ticker: string;
            price: number | null;
            previousClose: number | null;
            return1Day: number | null;
          }>;
        };

        const quote = payload.data?.[0];
        if (!quote || !finite(quote.return1Day) || cancelled) return false;

        setMetrics((current) => ({
          ...current,
          [ticker]: {
            ...(current[ticker] ?? {
              ticker,
              price: null,
              sma60: null,
              sma120: null,
              sma120Previous: null,
              return1Day: null,
              return3Month: null,
              return1Year: null,
              return3Year: null,
              high52Week: null,
              low52Week: null,
            }),
            price: finite(quote.price) ? quote.price : current[ticker]?.price ?? null,
            return1Day: quote.return1Day,
          },
        }));

        pending.delete(ticker);
        return true;
      } catch {
        return false;
      }
    };

    const runQueue = async (symbols: string[], concurrency = 3) => {
      let cursor = 0;
      const worker = async () => {
        while (!cancelled) {
          const index = cursor++;
          if (index >= symbols.length) return;
          await fetchOne(symbols[index]);
          await new Promise((resolve) => window.setTimeout(resolve, 220));
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()),
      );
    };

    const refreshAll = async () => {
      pending.clear();
      tickers.forEach((ticker) => pending.add(ticker));
      await runQueue(tickers, 3);
    };

    const retryMissing = async () => {
      const missing = Array.from(pending);
      if (missing.length) await runQueue(missing, 2);
    };

    refreshAll();
    const retryId = window.setInterval(retryMissing, 12_000);
    const refreshId = window.setInterval(refreshAll, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(retryId);
      window.clearInterval(refreshId);
    };
  }, [holdings.map((holding) => holding.ticker).join(",")]);

  // One US market sentiment value, shared across every holding. Keep the last
  // valid score through a transient provider failure instead of flashing "—".
  useEffect(() => {
    let cancelled = false;
    const refreshSentiment = async () => {
      try {
        const response = await fetch("/api/market-fear-greed", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { score?: number | null };
        if (!cancelled && finite(payload.score) && payload.score >= 0 && payload.score <= 100) {
          setFearGreed(payload.score);
        }
      } catch { /* Keep the last verified market reading. */ }
    };
    void refreshSentiment();
    const timer = window.setInterval(refreshSentiment, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const rows = useMemo<ScoredRow[]>(() => {
    const investedValue = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);

    // 보유 주식이 전체 자산의 90%, 현금성 자산이 10%라고 가정합니다.
    // 현금 10%를 50거래일에 걸쳐 사용하므로 하루 전체 매수 한도는
    // 총자산의 0.2%(= 현금 10% / 50일)입니다.
    const assumedTotalAssets = investedValue > 0 ? investedValue / 0.9 : 0;
    const baseDailyBudget = assumedTotalAssets * 0.1 / 50;

    const baseRows = holdings.map((holding) => {
      const targetAllocation = clamp(Number(targets[holding.ticker] ?? holding.allocation), 0, 100);
      const absoluteGap = Math.abs(targetAllocation - holding.allocation);
      const metric = metrics[holding.ticker];
      const signal = calculateSignal(holding.allocation, targetAllocation, metric);
      const score = calculateContinuousScore(signal, metric, fearGreed);
      const targetValue = investedValue * targetAllocation / 100;
      const valueGap = targetValue - holding.valueUsd;
      const price = finite(metric?.price) && metric!.price! > 0 ? metric!.price! : holding.currentPrice;
      const rawFullShares = price > 0 ? Math.abs(valueGap) / price : 0;
      const fullAdjustmentShares = signal.side === "SELL" ? Math.min(rawFullShares, holding.shares) : rawFullShares;

      return {
        holding,
        targetAllocation,
        absoluteGap,
        score,
        side: signal.side,
        level: signal.level,
        metric,
        price,
        fullAdjustmentShares,
      };
    });

    const eligibleBuyRows = baseRows.filter((row) => row.side === "BUY" && row.level > 0 && row.score >= 30 && row.fullAdjustmentShares > 0 && row.price > 0);
    const eligibleSellRows = baseRows.filter((row) => row.side === "SELL" && row.level > 0 && row.score >= 30 && row.fullAdjustmentShares > 0 && row.price > 0);

    // 기본 예산은 현금 10%를 50거래일에 나눈 값입니다. 다만 드문 고점수 기회에는
    // 최고 점수에 따라 기본 예산의 최대 2배까지 탄력적으로 집행합니다.
    const buyPeakScore = eligibleBuyRows.reduce((max, row) => Math.max(max, row.score), 0);
    const sellPeakScore = eligibleSellRows.reduce((max, row) => Math.max(max, row.score), 0);
    const budgetMultiplier = (peakScore: number) => peakScore < 30 ? 0 : 1 + clamp((peakScore - 30) / 70, 0, 1);
    const dailyBuyBudget = baseDailyBudget * budgetMultiplier(buyPeakScore);
    const dailySellBudget = baseDailyBudget * budgetMultiplier(sellPeakScore);

    const weightOf = (row: typeof baseRows[number]) => Math.max(0.01, row.absoluteGap) * Math.max(0.01, row.score / 100);
    const totalBuyWeight = eligibleBuyRows.reduce((sum, row) => sum + weightOf(row), 0);
    const totalSellWeight = eligibleSellRows.reduce((sum, row) => sum + weightOf(row), 0);

    return baseRows.map<ScoredRow>((row) => {
      const isBuy = row.side === "BUY";
      const isSell = row.side === "SELL";
      const isEligible = row.level > 0 && row.score >= 30 && row.fullAdjustmentShares > 0 && row.price > 0;
      const sideBudget = isBuy ? dailyBuyBudget : isSell ? dailySellBudget : 0;
      const totalWeight = isBuy ? totalBuyWeight : isSell ? totalSellWeight : 0;
      const allocatedBudget = isEligible && totalWeight > 0
        ? sideBudget * weightOf(row) / totalWeight
        : 0;
      const budgetLimitedShares = row.price > 0 ? allocatedBudget / row.price : 0;
      const recommendedShares = Math.min(row.fullAdjustmentShares, budgetLimitedShares);
      const executionRatio = row.fullAdjustmentShares > 0
        ? clamp(recommendedShares / row.fullAdjustmentShares, 0, 1)
        : 0;

      return {
        holding: row.holding,
        targetAllocation: row.targetAllocation,
        absoluteGap: row.absoluteGap,
        score: row.score,
        side: row.side,
        level: row.level,
        metric: row.metric,
        fullAdjustmentShares: row.fullAdjustmentShares,
        recommendedShares,
        executionRatio,
        dailyBudgetUsd: allocatedBudget,
      };
    }).sort((a, b) => b.score - a.score || b.level - a.level || a.holding.ticker.localeCompare(b.holding.ticker));
  }, [holdings, targets, metrics, fearGreed]);

  const targetTotal = Object.values(targets).reduce((sum, value) => sum + (finite(value) ? value : 0), 0);

  const updateTarget = (ticker: string, value: number) => {
    if (!Number.isFinite(value)) return;
    setTargets((current) => ({ ...current, [ticker]: clamp(value, 0, 100) }));
  };

  return (
    <section className="rebalancing-page">
      <section className="hero rebalancing-hero">
        <div>
          <span>REBALANCING</span>
          <h1>Rebalancing Signals</h1>
          <p>단계는 현재 구간을 보여주고, 점수는 다음 단계까지의 거리와 당일 실행 조건을 100점 척도로 세밀하게 계산합니다.</p>
        </div>
        <div className={`target-total ${Math.abs(targetTotal - 100) <= 0.05 ? "complete" : ""}`}>
          <div className="rebalancing-portfolio-heading-copy">
            <span>TOTAL TARGET ALLOCATION</span>
            <h2>{targetTotal.toFixed(1)}%</h2>
          </div>
        </div>
      </section>

      <section className="criteria-card card">
        <div className="criteria-toggle-header">
          <div className="criteria-title rebalancing-portfolio-heading-copy">
            <span>SCORING CRITERIA</span>
            <h2>매수·매도 단계 및 점수 산출 기준</h2>
          </div>
          <button
            type="button"
            className="criteria-toggle-button"
            aria-expanded={criteriaOpen}
            aria-controls="rebalance-criteria-content"
            onClick={() => setCriteriaOpen((open) => !open)}
          >
            {criteriaOpen ? "접기 ▲" : "펼쳐보기 ▼"}
          </button>
        </div>

        {criteriaOpen && <div id="rebalance-criteria-content" className="criteria-collapsible-content">
        <section className="rebalance-score-criteria">
          <div className="score-criteria-heading">
            <strong>리밸런싱 점수 산출 기준</strong>
            <span>목표 비중은 매수·매도 방향만 결정합니다. 같은 단계에서도 매수 하락폭(3개월·60일선), 매도 1년 수익률·고점 근접도에 따라 기본점수가 1점 단위로 달라집니다. 기본점수는 최대 85점입니다.</span>
          </div>
          <div className="score-criteria-formula">
            <div><b>방향 결정</b><span>현재 비중이 목표보다 낮으면 매수, 높으면 매도, 같으면 균형</span></div>
            <div><b>단계 결정</b><span>매수는 당일 수익률이 음수여야 1~3단계 진입이 가능합니다. 이후 3개월 수익률 또는 60일선 이격도로 단계를 판정하고, 52주 신저가 ±5% 이내면 10점을 가산하고, 단계별 공포·탐욕지수가 낮을수록 최대 5점을 추가합니다. 공포·탐욕 적용 구간은 1단계 45→30, 2단계 35→20, 3단계 25→10이며 각 구간의 낮은 끝값에서 5점입니다. 당일 하락에 대한 별도 가산점은 없습니다. 매도는 당일 상승 및 최근 1년 수익률 0% 이상을 필수 조건으로 하고 52주 신고가 ±10% 이내면 10점, 공포·탐욕지수는 단계별로 높을수록 최대 5점을 가산합니다. 매도 공포·탐욕 구간은 1단계 55→70, 2단계 65→80, 3단계 75→90입니다. 당일 상승 가산점은 없습니다.</span></div>
            <div><b>추천 수량</b><span>현금성 자산 10%를 50거래일에 나눈 기본 예산에 최고 점수 보너스를 적용해 최대 2배까지 탄력 배정</span></div>
          </div>
          <div className="score-band-list">
            <span><i className="wait" />0~29.9점 · 당일 주문 보류</span>
            <span><i className="stage-one" />30~59점 · 점수 구간</span>
            <span><i className="stage-two" />60~84점 · 점수 구간</span>
            <span><i className="stage-three" />85~100점 · 점수 구간</span>
          </div>
          <p className="rebalance-budget-note"><b>분할 원칙:</b> 보유 주식 90%, 현금성 자산 10%를 가정하고 현금 10%를 약 50거래일에 걸쳐 사용하는 금액을 기본 일일 예산으로 삼습니다. 다만 최고 리밸런싱 점수가 높을수록 예산을 탄력적으로 늘려, 매우 드문 100점 기회에는 기본 예산의 최대 2배까지 사용할 수 있습니다. 매수·매도 조건이 없으면 예산을 쓰지 않습니다. 가산점은 단계별 상한을 넘지 않습니다. 매수 3단계는 지표 강도에 따라 기본 70~85점이며 최고 기본 85점에 52주 저점 근접 +10점과 공포·탐욕 최대 +5점을 더해 최고 100점입니다. 공포·탐욕지수가 없으면 공포·탐욕 가산점은 0점이며 당일 하락은 필수 진입 조건이므로 별도 가산점이 없습니다. 매도 3단계는 지표 강도에 따라 기본 70~85점이며 최고 기본 85점에 52주 고점 근접 +10점과 공포·탐욕 최대 +5점을 더해 최고 100점입니다. 당일 상승은 필수 진입 조건이며 별도 가산점은 없습니다.</p>
        </section>

        <div className="criteria-grid">
          <article className="criteria-group buy">
            <div className="criteria-group-heading">
              <strong>매수 기준</strong>
              <span>현재 비중이 목표 비중보다 낮고 당일 수익률이 0% 미만일 때</span>
            </div>
            <div className="criteria-level"><i>1</i><p><b>1단계 · 보수적 분할매수</b><span>당일 수익률이 0% 미만인 것이 필수 전제이며, 현재 비중이 목표보다 낮고 최근 3개월 수익률이 -10% 이하 또는 60일선 이격도가 -10% 이하일 때입니다. 52주 신저가 ±5% 이내면 +10점, 공포·탐욕지수는 45 이하부터 30 이하까지 낮아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="criteria-level"><i>2</i><p><b>2단계 · 우선순위 확대</b><span>당일 수익률이 0% 미만인 것이 필수 전제이며, 현재 비중이 목표보다 낮고 최근 3개월 수익률이 -20% 이하 또는 60일선 이격도가 -20% 이하일 때입니다. 52주 신저가 ±5% 이내면 +10점, 공포·탐욕지수는 35 이하부터 20 이하까지 낮아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="criteria-level"><i>3</i><p><b>3단계 · 최우선 분할매수</b><span>당일 수익률이 0% 미만인 것이 필수 전제이며, 현재 비중이 목표보다 낮고 최근 3개월 수익률이 -30% 이하 또는 60일선 이격도가 -30% 이하일 때입니다. 52주 신저가 ±5% 이내면 +10점, 공포·탐욕지수는 25 이하부터 10 이하까지 낮아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="buy-rsi-visual" aria-label="매수 단계별 공포·탐욕 점수 기준과 3단계 100점 구성">
              <strong className="buy-rsi-visual-title">매수 단계별 시장 공포·탐욕지수 가산점</strong>
              <div className="buy-rsi-table-wrap">
                <table className="buy-rsi-table">
                  <thead><tr><th scope="col">매수 단계</th><th scope="col">점수 증가 구간</th><th scope="col">+5점 조건</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">1단계</th><td>공포·탐욕 45 → 30</td><td>공포·탐욕 ≤ 30</td></tr>
                    <tr><th scope="row">2단계</th><td>공포·탐욕 35 → 20</td><td>공포·탐욕 ≤ 20</td></tr>
                    <tr><th scope="row">3단계</th><td>공포·탐욕 25 → 10</td><td>공포·탐욕 ≤ 10</td></tr>
                  </tbody>
                </table>
              </div>
              <strong className="buy-rsi-visual-title">매수 3단계 최고 점수 <span>100점</span></strong>
              <div className="buy-rsi-score-bar" aria-label="기본 85점, 52주 저점 근접 10점, 공포·탐욕 5점">
                <span className="buy-rsi-base" /><span className="buy-rsi-low" /><span className="buy-rsi-bonus" />
              </div>
              <div className="buy-rsi-score-legend">
                <span><i className="buy-rsi-base" />기본 <b>85점</b></span>
                <span><i className="buy-rsi-low" />52주 저점 <b>+10점</b></span>
                <span><i className="buy-rsi-bonus" />공포·탐욕 <b>+5점</b></span>
              </div>
              <p className="buy-rsi-visual-note">당일 하락은 매수 진입의 필수 조건이며 가산점은 없습니다. 공포·탐욕지수가 낮아질수록 단계별 구간 안에서 0~5점이 추가됩니다.</p>
            </div>
          </article>

          <article className="criteria-group sell">
            <div className="criteria-group-heading">
              <strong>매도 기준</strong>
              <span>현재 비중이 목표 비중보다 높을 때</span>
            </div>
            <div className="criteria-level"><i>1</i><p><b>1단계 · 보수적 분할매도</b><span>당일 수익률이 0% 초과인 것이 필수 전제이며, 현재 비중이 목표보다 높고 최근 1년 누적 수익률이 0% 이상 100% 미만일 때입니다. 수익률이 음수이거나 데이터가 없으면 당일 상승하더라도 매도 0단계로 판정하고 점수 및 주문 수량은 0입니다. 52주 신고가 ±10% 이내면 +10점, 공포·탐욕지수는 55부터 70 이상까지 높아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="criteria-level"><i>2</i><p><b>2단계 · 우선순위 확대</b><span>당일 수익률이 0% 초과인 것이 필수 전제이며, 현재 비중이 목표보다 높고 최근 1년 누적 수익률이 100% 이상일 때입니다. 52주 신고가 ±10% 이내면 +10점, 공포·탐욕지수는 65부터 80 이상까지 높아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="criteria-level"><i>3</i><p><b>3단계 · 최우선 분할매도</b><span>당일 수익률이 0% 초과인 것이 필수 전제이며, 현재 비중이 목표보다 높고 최근 1년 누적 수익률이 200% 이상일 때입니다. 52주 신고가 ±10% 이내면 +10점, 공포·탐욕지수는 75부터 90 이상까지 높아질수록 최대 +5점을 가산합니다.</span></p></div>
            <div className="sell-rsi-visual" aria-label="매도 단계별 공포·탐욕 점수 기준과 3단계 100점 구성">
              <strong className="buy-rsi-visual-title">매도 단계별 시장 공포·탐욕지수 가산점</strong>
              <div className="buy-rsi-table-wrap">
                <table className="buy-rsi-table">
                  <thead><tr><th>매도 단계</th><th>공포·탐욕 점수 증가 구간</th><th>공포·탐욕 +5점 조건</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">1단계</th><td>공포·탐욕 55 → 70</td><td>공포·탐욕 ≥ 70</td></tr>
                    <tr><th scope="row">2단계</th><td>공포·탐욕 65 → 80</td><td>공포·탐욕 ≥ 80</td></tr>
                    <tr><th scope="row">3단계</th><td>공포·탐욕 75 → 90</td><td>공포·탐욕 ≥ 90</td></tr>
                  </tbody>
                </table>
              </div>
              <strong className="buy-rsi-visual-title">매도 3단계 최고 점수 <span>100점</span></strong>
              <div className="buy-rsi-score-bar" aria-label="기본 85점, 52주 고점 근접 10점, 공포·탐욕 5점">
                <span className="buy-rsi-base" /><span className="buy-rsi-low" /><span className="buy-rsi-bonus" />
              </div>
              <div className="buy-rsi-score-legend">
                <span><i className="buy-rsi-base" />기본 <b>85점</b></span>
                <span><i className="buy-rsi-low" />52주 고점 <b>+10점</b></span>
                <span><i className="buy-rsi-bonus" />공포·탐욕 <b>+5점</b></span>
              </div>
              <p className="buy-rsi-visual-note">당일 상승은 매도 진입의 필수 조건이며 가산점은 없습니다. 공포·탐욕지수가 높아질수록 단계별 구간 안에서 0~5점이 추가됩니다.</p>
            </div>
          </article>
        </div>
        </div>}
      </section>

      <section className="rebalance-table-card card">
        <div className="section-heading">
          <div><span>PRIORITY LIST</span><h2>리밸런싱 우선순위</h2></div>
          <small>{loading ? "시장 데이터 계산 중…" : `${rows.length}개 종목`}</small>
        </div>

        <div className="rebalance-table-scroll">
          <table className="rebalance-table">
            <thead>
              <tr>
                <th>순위</th>
                <th>종목</th>
                <th>현재 비중</th>
                <th>목표 비중</th>
                <th>괴리</th>
                <th>매수·매도 단계</th>
                <th>리밸런싱 점수</th>
                <th>추천 주문 수량</th>
                <th>참고 지표</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const signedGap = row.targetAllocation - row.holding.allocation;
                return (
                  <tr key={row.holding.ticker}>
                    <td className="rebalance-rank-cell"><span className={`rank-number ${index < 3 ? `rank-medal-${index + 1}` : ""}`}>{index + 1}</span></td>
                    <td className="rebalance-asset-cell">
                      <div className="rebalance-asset">
                        <b>{row.holding.ticker}</b>
                        <span>{row.holding.companyName}</span>
                      </div>
                    </td>
                    <td className="rebalance-current-cell">
                      <span className="mobile-cell-label">현재 비중</span>
                      <b>{row.holding.allocation.toFixed(2)}%</b>
                    </td>
                    <td className="rebalance-target-cell">
                      <span className="mobile-cell-label">목표 비중</span>
                      <div className="target-input">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={row.targetAllocation}
                          onChange={(event) => updateTarget(row.holding.ticker, Number(event.target.value))}
                          aria-label={`${row.holding.ticker} 목표 비중`}
                        />
                        <span className="target-value-mirror" aria-hidden="true">{row.targetAllocation}</span>
                        <span>%</span>
                      </div>
                    </td>
                    <td className="rebalance-gap-cell">
                      <span className="mobile-cell-label">괴리</span>
                      <b className={signedGap > 0 ? "gap-buy" : signedGap < 0 ? "gap-sell" : ""}>
                        {signedGap > 0 ? "+" : ""}{signedGap.toFixed(2)}%p
                      </b>
                    </td>
                    <td className="rebalance-signal-cell">
                      <span className="mobile-cell-label">매수·매도 단계</span>
                      <SignalBadge side={row.side} level={row.level} />
                    </td>
                    <td className="rebalance-score-cell">
                      <span className="mobile-cell-label">리밸런싱 점수</span>
                      <ScoreBadge score={row.score} />
                    </td>
                    <td className="rebalance-order-cell">
                      <span className="mobile-cell-label">추천 주문 수량</span>
                      <div className={`order-recommendation ${row.side.toLowerCase()}`}>
                        <strong>{row.side === "BALANCED" || row.recommendedShares <= 0 ? "오늘 주문 보류" : `${row.side === "BUY" ? "오늘 매수" : "오늘 매도"} ${row.recommendedShares.toFixed(1)}주`}</strong>
                        <span>당일 배정 ${row.dailyBudgetUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} · 목표까지 {row.fullAdjustmentShares.toFixed(1)}주</span>
                      </div>
                    </td>
                    <td className="rebalance-metric-cell">
                      <span className="mobile-cell-label">참고 지표</span>
                      <div className="metric-copy">
                        {row.side === "BUY" ? (
                          <>
                            <span className={
                              finite(row.metric?.return1Day)
                                ? row.metric.return1Day < 0
                                  ? "metric-down"
                                  : row.metric.return1Day > 0
                                    ? "metric-up"
                                    : ""
                                : ""
                            }>
                              당일 {formatPercent(row.metric?.return1Day)}
                            </span>
                            <span>3개월 {formatPercent(row.metric?.return3Month)}</span>
                            <span>60일선 {finite(row.metric?.price) && finite(row.metric?.sma60) && row.metric!.sma60! > 0
                              ? formatPercent((row.metric!.price! / row.metric!.sma60! - 1) * 100) : "—"}</span>
                            <span>공포·탐욕 {finite(fearGreed) ? fearGreed.toFixed(1) : "—"}</span>
                            <span>52주 신저가 {finite(row.metric?.price) && finite(row.metric?.low52Week) && row.metric!.low52Week! > 0
                              ? formatPercent((row.metric!.price! / row.metric!.low52Week! - 1) * 100) : "—"}</span>
                          </>
                        ) : row.side === "SELL" ? (
                          <>
                            <span>1년 {formatPercent(row.metric?.return1Year, 0)}</span>
                            <span>52주 고점 {finite(row.metric?.price) && finite(row.metric?.high52Week) && row.metric!.high52Week! > 0
                              ? formatPercent((row.metric!.price! / row.metric!.high52Week! - 1) * 100)
                              : "—"}</span>
                          </>
                        ) : <span>목표 비중과 일치</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={9}><div className="rebalance-empty">포트폴리오에 종목을 먼저 추가해 주세요.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Mobile-specific cards: independent layout avoids the legacy table's cascading rules. */}
      <section className="rebalance-mobile-list" aria-label="모바일 리밸런싱 우선순위">
        <div className="rebalance-mobile-heading">
          <strong>리밸런싱 우선순위</strong>
          <span>{loading ? "시장 데이터 계산 중…" : `${rows.length}개 종목`}</span>
        </div>
        {rows.map((row, index) => {
          const signedGap = row.targetAllocation - row.holding.allocation;
          const market = row.metric;
          const distance60 = finite(market?.price) && finite(market?.sma60) && market.sma60 > 0
            ? (market.price / market.sma60 - 1) * 100 : null;
          const distance52Low = finite(market?.price) && finite(market?.low52Week) && market.low52Week > 0
            ? (market.price / market.low52Week - 1) * 100 : null;
          const distance52High = finite(market?.price) && finite(market?.high52Week) && market.high52Week > 0
            ? (market.price / market.high52Week - 1) * 100 : null;
          // SELL only outlines its three entry/proximity conditions.
          const buyDropThreshold = row.level === 3 ? -30 : row.level === 2 ? -20 : -10;
          const buyFearThreshold = row.level === 3 ? 25 : row.level === 2 ? 35 : 45;
          const commonSentiment = finite(fearGreed) ? fearGreed.toFixed(1) : "—";
          const metricItems = row.side === "SELL"
            ? [
                { label: "당일", value: formatPercent(market?.return1Day), matched: finite(market?.return1Day) && market.return1Day > 0 },
                { label: "52주 고점", value: formatPercent(distance52High), matched: finite(distance52High) && Math.abs(distance52High) <= 10 },
                { label: "공포·탐욕", value: commonSentiment, matched: false },
                { label: "1년", value: formatPercent(market?.return1Year, 0), matched: row.level > 0 && finite(market?.return1Year) && (row.level === 3 ? market.return1Year >= 200 : row.level === 2 ? market.return1Year >= 100 : market.return1Year >= 0 && market.return1Year < 100) },
                { label: "3개월", value: formatPercent(market?.return3Month), matched: false },
                { label: "60일선", value: formatPercent(distance60), matched: false },
              ]
            : [
                { label: "당일", value: formatPercent(market?.return1Day), matched: row.side === "BUY" && finite(market?.return1Day) && market.return1Day < 0 },
                { label: "52주 신저가", value: formatPercent(distance52Low), matched: row.side === "BUY" && finite(distance52Low) && Math.abs(distance52Low) <= 5 },
                { label: "공포·탐욕", value: commonSentiment, matched: row.side === "BUY" && row.level > 0 && finite(fearGreed) && fearGreed <= buyFearThreshold },
                { label: "1년", value: formatPercent(market?.return1Year, 0), matched: false },
                { label: "3개월", value: formatPercent(market?.return3Month), matched: row.side === "BUY" && row.level > 0 && finite(market?.return3Month) && market.return3Month <= buyDropThreshold },
                { label: "60일선", value: formatPercent(distance60), matched: row.side === "BUY" && row.level > 0 && finite(distance60) && distance60 <= buyDropThreshold },
              ];
          return (
            <article className="rebalance-mobile-card" key={row.holding.ticker}>
              <div className="mobile-card-heading">
                <span className={`mobile-card-rank ${index < 3 ? `rank-medal-${index + 1}` : ""}`}>{index + 1}</span>
                <div className="mobile-card-security">
                  <b>{row.holding.ticker}</b>
                  <span title={row.holding.companyName}>{row.holding.companyName}</span>
                </div>
                <div className="mobile-card-score" aria-label={`리밸런싱 점수 ${row.score}점`}>
                  <span>리밸런싱 점수</span>
                  <ScoreBadge score={row.score} />
                </div>
              </div>
              <div className="mobile-card-allocations">
                <div className="mobile-card-allocation">
                  <span>현재 비중</span>
                  <b>{row.holding.allocation.toFixed(2)}%</b>
                </div>
                <div className="mobile-card-allocation">
                  <label htmlFor={`mobile-target-${row.holding.ticker}`}>목표 비중</label>
                  <div className="mobile-card-target-input">
                    <input
                      id={`mobile-target-${row.holding.ticker}`}
                      type="number" min="0" max="100" step="0.1"
                      value={row.targetAllocation}
                      onChange={(event) => updateTarget(row.holding.ticker, Number(event.target.value))}
                      aria-label={`${row.holding.ticker} 목표 비중`}
                    />
                    <span className="target-value-mirror" aria-hidden="true">{row.targetAllocation}</span>
                    <span>%</span>
                  </div>
                </div>
                <div className="mobile-card-allocation mobile-card-gap">
                  <span>괴리</span>
                  <b className={signedGap > 0 ? "gap-buy" : signedGap < 0 ? "gap-sell" : ""}>
                    {signedGap > 0 ? "+" : ""}{signedGap.toFixed(2)}%p
                  </b>
                </div>
              </div>
              <div className="mobile-card-action">
                <div className={`mobile-card-order ${row.side === "BALANCED" || row.level === 0 || row.recommendedShares <= 0 ? "balanced" : row.side.toLowerCase()}`} data-trade-side={row.side === "BALANCED" || row.level === 0 || row.recommendedShares <= 0 ? "HOLD" : row.side}>
                  <strong>{row.side === "BALANCED" || row.recommendedShares <= 0
                    ? "오늘 주문 보류"
                    : `${row.side === "BUY" ? "오늘 매수" : "오늘 매도"} ${row.recommendedShares.toFixed(1)}주`}</strong>
                  <span>배정 ${row.dailyBudgetUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}달러 · 목표까지 {row.fullAdjustmentShares.toFixed(1)}주</span>
                </div>
                <div className={`mobile-card-stage mobile-stage-${row.side.toLowerCase()} mobile-stage-level-${row.level}`}>
                  <div className="mobile-stage-bars" aria-label={row.level > 0 ? `${row.level}단계` : "단계 조건 미충족"}>
                    {[1, 2, 3].map((stage) => (
                      <i key={stage} className={`mobile-stage-bar stage-${stage}${stage <= row.level ? " active" : ""}`} />
                    ))}
                  </div>
                  <b className="mobile-stage-label">{levelLabel(row.side, row.level)}</b>
                </div>
              </div>
              <div className="mobile-card-metrics" aria-label="참고 지표">
                {metricItems.map((item) => (
                  <div className={`mobile-card-metric${item.matched ? row.side === "SELL" ? " metric-matched-sell" : " metric-matched-buy" : ""}`} key={item.label}>
                    <span className="mobile-metric-label">{item.label}</span>
                    <span className="mobile-metric-applicability" aria-label={`매수 ${["당일", "52주 신저가", "공포·탐욕", "3개월", "60일선"].includes(item.label) ? "적용" : "미적용"}, 매도 ${["당일", "52주 고점", "공포·탐욕", "1년"].includes(item.label) ? "적용" : "미적용"}`}>
                      {["당일", "52주 신저가", "공포·탐욕", "3개월", "60일선"].includes(item.label) && <i className="metric-dot-buy" title="매수 적용" />}
                      {["당일", "52주 고점", "공포·탐욕", "1년"].includes(item.label) && <i className="metric-dot-sell" title="매도 적용" />}
                    </span>
                    <b>{item.value}</b>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
        {!rows.length && <div className="rebalance-mobile-empty">포트폴리오에 종목을 먼저 추가해 주세요.</div>}
      </section>

      <style jsx>{`
        .rebalancing-page { display:grid; gap:18px; }
        /* Clean, independent mobile layout. Desktop table stays unchanged. */
        .rebalance-mobile-list { display:none; }
        @media (max-width:720px) {
          .rebalance-table-card { display:none !important; }
          .rebalance-mobile-list { display:flex; flex-direction:column; gap:5px; min-width:0; }
          .rebalance-mobile-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 4px 7px; }
          .rebalance-mobile-heading strong { color:#0f172a; font-size:15px; }
          .rebalance-mobile-heading span { color:#64748b; font-size:11px; font-weight:700; }
          .rebalance-mobile-card {
            display:grid; grid-template-columns:minmax(0,1fr); gap:5px;
            min-width:0; padding:8px 9px; border:1px solid #e2e8f0;
            border-radius:11px; background:#fff; box-sizing:border-box;
          }
          .mobile-card-heading { display:grid; grid-template-columns:22px minmax(0,1fr) auto; align-items:center; gap:7px; min-height:24px; }
          .mobile-card-rank { display:grid; place-items:center; width:22px; height:22px; background:#f1f5f9; border-radius:6px; color:#303846; font-size:10px; font-weight:900; }
          .mobile-card-security { display:flex; align-items:baseline; gap:6px; min-width:0; overflow:hidden; }
          .mobile-card-security b { flex:none; font-size:12px; line-height:1.1; color:#0f172a; }
          .mobile-card-security span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#303846; font-size:10px; line-height:1.1; }
          .mobile-card-score { display:flex; align-items:center; gap:5px; }
          .mobile-card-score > span { white-space:nowrap; color:#303846; font-size:9px; font-weight:750; }
          .mobile-card-score :global(.rebalance-score) { display:flex; align-items:center; justify-content:center; flex-wrap:nowrap; gap:1px; width:54px; height:25px; padding:0 3px; border-radius:7px; box-sizing:border-box; white-space:nowrap; }
          .mobile-card-score :global(.rebalance-score) strong { font-size:12px; line-height:1; }
          .mobile-card-score :global(.rebalance-score) span { font-size:8px; line-height:1; }
          .mobile-card-allocations { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:8px; min-height:27px; }
          .mobile-card-allocation { display:flex; align-items:center; justify-content:flex-start; gap:5px; min-width:0; white-space:nowrap; }
          .mobile-card-allocation > span,.mobile-card-allocation > label { flex:none; color:#303846; font-size:10px; font-weight:750; }
          .mobile-card-allocation > b { font-size:11px; line-height:1.2; }
          .mobile-card-gap { justify-content:flex-end; }
          .mobile-card-target-input { display:flex; align-items:center; width:61px; height:25px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; }
          .mobile-card-target-input input { min-width:0; width:44px; height:23px; padding:0 2px 0 4px; border:0; outline:0; background:transparent; box-sizing:border-box; text-align:center; color:#0f172a; font-size:11px; font-weight:850; font-family:inherit; }
          .mobile-card-target-input span { font-size:10px; color:#303846; }
          .mobile-card-action { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(95px,1fr); align-items:center; gap:7px; min-height:27px; }
          .mobile-card-order { display:flex; align-items:center; gap:5px; min-width:0; min-height:26px; padding:4px 6px; border:1px solid #ef1b2d; border-radius:7px; background:#fff0f2; box-sizing:border-box; }
          .mobile-card-order strong { flex:none; color:#ef1b2d; font-size:10px; line-height:1.1; white-space:nowrap; }
          .mobile-card-order span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#303846; font-size:9px; font-weight:700; }
          .mobile-card-order.sell { background:#eef5ff; border-color:#0066ff; }
          .mobile-card-order.sell strong { color:#0066ff; }
          .mobile-card-order.balanced { background:#f3f4f6; border-color:#cbd5e1; }
          .mobile-card-order.balanced strong { color:#303846; }
          .mobile-card-stage { min-width:0; }
          .mobile-card-stage :global(.signal-badge) { display:flex; flex-direction:row; align-items:center; justify-content:flex-end; min-width:0; width:100%; gap:6px; }
          .mobile-card-stage :global(.signal-stage-bar) { flex:none; width:37px; display:grid; grid-template-columns:repeat(3,1fr); gap:2px; }
          .mobile-card-stage :global(.signal-stage-bar) i { height:6px; }
          .mobile-card-stage :global(.signal-badge) b { color:#303846; font-size:10px; line-height:1.1; white-space:nowrap; }
          .mobile-card-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:4px; }
          .rebalance-mobile-card .mobile-card-metrics:has(.mobile-card-metric:nth-child(6)) { grid-template-columns:repeat(3,minmax(0,1fr)); }
          .mobile-card-metric { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; min-width:0; min-height:30px; padding:4px 1px; border:1px solid #e7ebf0; border-radius:6px; background:#f8fafc; box-sizing:border-box; }
          .mobile-card-metric span { color:#303846; font-size:9px; font-weight:750; line-height:1; white-space:nowrap; }
          .mobile-card-metric b { font-size:10px; color:#303846; font-weight:850; line-height:1; white-space:nowrap; }
          .rebalance-mobile-empty { padding:30px 12px; text-align:center; color:#64748b; }
        }
        @media (max-width:360px) {
          .rebalance-mobile-card { padding:7px 6px; gap:4px; }
          .mobile-card-heading { gap:4px; }
          .mobile-card-score > span { display:none; }
          .mobile-card-allocations { gap:4px; }
          .mobile-card-allocation { gap:3px; }
          .mobile-card-allocation > span,.mobile-card-allocation > label { font-size:9px; }
          .mobile-card-allocation > b { font-size:10px; }
          .mobile-card-target-input { width:53px; }
          .mobile-card-target-input input { width:38px; font-size:10px; }
          .mobile-card-action { grid-template-columns:minmax(0,1.4fr) minmax(85px,1fr); gap:4px; }
          .mobile-card-stage :global(.signal-stage-bar) { width:26px; }
          .mobile-card-stage :global(.signal-badge) b { font-size:9px; }
        }


        /* Mobile cards: typography and signal color refinement only.
           Preserve layout, metrics, calculations and all input behavior. */
        @media (max-width:720px) {
          /* One shared text size; the ticker alone is slightly larger. */
          .rebalance-mobile-card,
          .rebalance-mobile-card .mobile-card-rank,
          .rebalance-mobile-card .mobile-card-security span,
          .rebalance-mobile-card .mobile-card-score > span,
          .rebalance-mobile-card .mobile-card-allocation > span,
          .rebalance-mobile-card .mobile-card-allocation > label,
          .rebalance-mobile-card .mobile-card-allocation > b,
          .rebalance-mobile-card .mobile-card-target-input input,
          .rebalance-mobile-card .mobile-card-target-input span,
          .rebalance-mobile-card .mobile-card-order strong,
          .rebalance-mobile-card .mobile-card-order span,
          .rebalance-mobile-card .mobile-card-metric span,
          .rebalance-mobile-card .mobile-card-metric b {
            font-size:10px !important;
          }
          .rebalance-mobile-card .mobile-card-security b {
            font-size:12px !important;
          }
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score) strong,
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score) span,
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge) b {
            font-size:10px !important;
            line-height:1.1 !important;
          }
          /* Gold text for the score; no colored score background/border. */
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score),
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score.low),
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score.medium),
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score.high),
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score.very-high) {
            color:#b8860b !important;
            background:transparent !important;
            border-color:transparent !important;
          }
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score) strong,
          .rebalance-mobile-card .mobile-card-score :global(.rebalance-score) span {
            color:#b8860b !important;
            font-weight:900 !important;
            opacity:1 !important;
          }
          /* Outside the score and trade stage, use neutral text and styling. */
          .rebalance-mobile-card .mobile-card-gap > b,
          .rebalance-mobile-card .mobile-card-gap > b.gap-buy,
          .rebalance-mobile-card .mobile-card-gap > b.gap-sell {
            color:#334155 !important;
          }
          /* BUY: orange -> orange-red -> deep red. */
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-1) b { color:#f97316 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-2) b { color:#ea580c !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-3) b { color:#b91c1c !important; }
          /* SELL: sky blue -> deeper sky blue -> deep blue. */
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-1) b { color:#38bdf8 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-2) b { color:#0284c7 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-3) b { color:#1d4ed8 !important; }
          /* Color the accompanying three-step bars consistently. */
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-1 .signal-stage-bar i.active) { background:#f97316 !important; border-color:#f97316 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-2 .signal-stage-bar i.active) { background:#ea580c !important; border-color:#ea580c !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.buy.level-3 .signal-stage-bar i.active) { background:#b91c1c !important; border-color:#b91c1c !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-1 .signal-stage-bar i.active) { background:#38bdf8 !important; border-color:#38bdf8 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-2 .signal-stage-bar i.active) { background:#0284c7 !important; border-color:#0284c7 !important; }
          .rebalance-mobile-card .mobile-card-stage :global(.signal-badge.sell.level-3 .signal-stage-bar i.active) { background:#1d4ed8 !important; border-color:#1d4ed8 !important; }
        }

        /* 2026-10 mobile action corrections only: keep previous layout otherwise. */
        @media (max-width:720px) {
          .rebalance-mobile-card .mobile-card-action {
            grid-template-columns:minmax(0,1fr) 88px !important;
            gap:5px !important;
          }
          .rebalance-mobile-card .mobile-card-order {
            display:flex !important;
            flex-wrap:wrap !important;
            align-content:center !important;
            column-gap:5px !important;
            row-gap:2px !important;
            width:100% !important;
            min-width:0 !important;
            background:#fff0f2 !important;
            border:1px solid #ef1b2d !important;
          }
          .rebalance-mobile-card .mobile-card-order.sell {
            background:#eef5ff !important;
            border-color:#0066ff !important;
          }
          .rebalance-mobile-card .mobile-card-order.balanced {
            background:#f3f4f6 !important;
            border-color:#cbd5e1 !important;
          }
          .rebalance-mobile-card .mobile-card-order strong { color:#ef1b2d !important; }
          .rebalance-mobile-card .mobile-card-order.sell strong { color:#0066ff !important; }
          .rebalance-mobile-card .mobile-card-order.balanced strong { color:#303846 !important; }
          .rebalance-mobile-card .mobile-card-order span {
            flex:1 1 auto !important;
            min-width:0 !important;
            overflow:visible !important;
            text-overflow:clip !important;
            white-space:normal !important;
            overflow-wrap:break-word !important;
            line-height:1.25 !important;
          }
          /* Stage bars and label are local elements, so stage colors cannot be overridden
             by legacy global signal-badge styling. */
          .rebalance-mobile-card .mobile-card-stage {
            display:flex !important;
            width:88px !important;
            min-width:0 !important;
            align-items:center !important;
            justify-content:flex-end !important;
            gap:4px !important;
          }
          .rebalance-mobile-card .mobile-stage-bars {
            display:grid;
            grid-template-columns:repeat(3,minmax(0,1fr));
            flex:0 0 21px;
            gap:2px;
          }
          .rebalance-mobile-card .mobile-stage-bar {
            display:block;
            height:6px;
            border-radius:999px;
            background:#e2e8f0;
            border:1px solid #dbe3ed;
            box-sizing:border-box;
          }
          .rebalance-mobile-card .mobile-stage-label {
            font-size:10px;
            font-weight:850;
            line-height:1.1;
            white-space:nowrap;
            color:#64748b;
          }
          .rebalance-mobile-card .mobile-stage-buy.mobile-stage-level-1 .mobile-stage-label { color:#f97316; }
          .rebalance-mobile-card .mobile-stage-buy.mobile-stage-level-2 .mobile-stage-label { color:#ea580c; }
          .rebalance-mobile-card .mobile-stage-buy.mobile-stage-level-3 .mobile-stage-label { color:#b91c1c; }
          .rebalance-mobile-card .mobile-stage-sell.mobile-stage-level-1 .mobile-stage-label { color:#38bdf8; }
          .rebalance-mobile-card .mobile-stage-sell.mobile-stage-level-2 .mobile-stage-label { color:#0284c7; }
          .rebalance-mobile-card .mobile-stage-sell.mobile-stage-level-3 .mobile-stage-label { color:#1d4ed8; }
          .rebalance-mobile-card .mobile-stage-buy .mobile-stage-bar.stage-1.active { background:#f97316; border-color:#f97316; }
          .rebalance-mobile-card .mobile-stage-buy .mobile-stage-bar.stage-2.active { background:#ea580c; border-color:#ea580c; }
          .rebalance-mobile-card .mobile-stage-buy .mobile-stage-bar.stage-3.active { background:#b91c1c; border-color:#b91c1c; }
          .rebalance-mobile-card .mobile-stage-sell .mobile-stage-bar.stage-1.active { background:#38bdf8; border-color:#38bdf8; }
          .rebalance-mobile-card .mobile-stage-sell .mobile-stage-bar.stage-2.active { background:#0284c7; border-color:#0284c7; }
          .rebalance-mobile-card .mobile-stage-sell .mobile-stage-bar.stage-3.active { background:#1d4ed8; border-color:#1d4ed8; }
        }
        @media (max-width:360px) {
          .rebalance-mobile-card .mobile-card-action { grid-template-columns:minmax(0,1fr) 82px !important; }
          .rebalance-mobile-card .mobile-card-stage { width:82px !important; }
          .rebalance-mobile-card .mobile-stage-label { font-size:9px; }
        }

        .rebalancing-hero { margin-bottom:0; }
        .target-total {
          min-width:150px; padding:14px 18px; border:1px solid #e2e8f0; border-radius:16px;
          background:#fff; display:flex; flex-direction:column; align-items:flex-end; gap:4px;
        }
        .target-total span { color:#64748b; font-size:11px; font-weight:800; letter-spacing:.08em; }
        .target-total strong { color:#e87722; font-size:24px; }
        .target-total.complete strong { color:#e87722; }
        .criteria-card { padding:22px; }
        .criteria-toggle-header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .criteria-toggle-header .criteria-title { margin-bottom:0; min-width:0; }
        .criteria-collapsible-content { margin-top:16px; }
        .criteria-toggle-button {
          display:inline-flex; align-items:center; justify-content:center;
          flex-shrink:0; min-height:36px; padding:8px 12px;
          background:#fff7ed; border:1px solid #ffd2ad; border-radius:10px;
          color:#861f41; font:inherit; font-size:12px; font-weight:800;
          cursor:pointer; white-space:nowrap;
        }
        .criteria-toggle-button:hover { background:#ffedd5; }
        .criteria-toggle-button:focus-visible { outline:2px solid #e87722; outline-offset:3px; }

        @media (max-width:480px) {
          .criteria-card { padding:13px; }
          .criteria-toggle-header { gap:8px; }
          .criteria-toggle-header .criteria-title h2 { font-size:13px; }
          .criteria-toggle-button { min-height:32px; padding:7px 9px; font-size:11px; }
        }
        .criteria-title { margin-bottom:16px; }
        .criteria-title > span { color:#94a3b8; font-size:10px; font-weight:900; letter-spacing:.12em; }
        .criteria-title h2 { margin:5px 0 0; color:#0f172a; font-size:17px; }
        .rebalance-score-criteria {
          margin-bottom:14px; padding:16px; border:1px solid #ffd2ad; border-radius:15px;
          background:linear-gradient(180deg,#fff7ed 0%,#ffffff 100%);
        }
        .score-criteria-heading { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
        .score-criteria-heading strong { color:#0f172a; font-size:14px; }
        .score-criteria-heading span { color:#64748b; font-size:11px; line-height:1.45; }
        .score-criteria-formula { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; align-items:start; }
        .score-criteria-formula > div {
          min-height:0; height:auto; padding:11px 12px; border:1px solid #e2e8f0; border-radius:11px;
          background:#fff; display:flex; flex-direction:column; gap:6px; align-self:start;
        }
        .score-criteria-formula b { color:#1e3a8a; font-size:11px; }
        .score-criteria-formula span { color:#64748b; font-size:10px; line-height:1.45; }
        .score-band-list { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; margin-top:10px; }
        .score-band-list span {
          display:flex; align-items:center; gap:7px; padding:9px 10px; border:1px solid #e2e8f0;
          border-radius:10px; background:#fff; color:#475569; font-size:10px; font-weight:800;
        }
        .score-band-list i { width:28px; height:8px; border-radius:999px; background:#cbd5e1; }
        .score-band-list i.stage-one { background:#ff9d42; }
        .score-band-list i.stage-two { background:#e87722; }
        .score-band-list i.stage-three { background:#861f41; }
        .criteria-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        .criteria-group,.score-formula { border:1px solid #e2e8f0; border-radius:15px; padding:16px; background:#fff; }
        .criteria-group.buy,.criteria-group.sell { border-color:#ffd2ad; }
        .criteria-group-heading { display:flex; flex-direction:column; gap:4px; padding-bottom:12px; margin-bottom:10px; border-bottom:1px solid #f1f5f9; }
        .criteria-group-heading strong { font-size:14px; }
        .criteria-group.buy .criteria-group-heading strong { color:#ef1b2d; }
        .criteria-group.sell .criteria-group-heading strong { color:#0066ff; }
        .criteria-group-heading span { color:#64748b; font-size:11px; }
        .criteria-level { display:flex; gap:10px; align-items:flex-start; margin-top:10px; }
        .criteria-level i {
          flex:0 0 22px; width:22px; height:22px; border-radius:7px; display:grid; place-items:center;
          font-style:normal; font-size:11px; font-weight:900; color:#fff;
        }
        .criteria-group.buy .criteria-level i { background:#ef1b2d; }
        .criteria-group.sell .criteria-level i { background:#0066ff; }
        .criteria-level p { margin:0; display:flex; flex-direction:column; gap:3px; }
        .criteria-level b { color:#0f172a; font-size:11px; }
        .criteria-level span { color:#64748b; font-size:10px; line-height:1.4; }
        .rebalance-table-card { padding:22px; }
        .section-heading small { color:#64748b; font-weight:700; }
        .rebalance-table-scroll { overflow-x:auto; }
        .rebalance-table { width:100%; min-width:1040px; border-collapse:collapse; }
        .rebalance-table th {
          padding:12px 10px; border-bottom:1px solid #e2e8f0; text-align:left;
          color:#64748b; font-size:10px; letter-spacing:.08em; text-transform:uppercase;
        }
        .rebalance-table td { padding:14px 10px; border-bottom:1px solid #f1f5f9; vertical-align:middle; }
        .mobile-cell-label { display:none; }
        .rebalance-table tbody tr:hover { background:#f8fafc; }
        .rank-number {
          width:28px; height:28px; border-radius:9px; display:grid; place-items:center;
          background:#f1f5f9; color:#475569; font-size:12px; font-weight:900;
        }
        /* Same first-three rank medals as Portfolio Holdings. All later ranks unchanged. */
        .rank-number.rank-medal-1, .mobile-card-rank.rank-medal-1 { background:#D4A017 !important; color:#fff !important; }
        .rank-number.rank-medal-2, .mobile-card-rank.rank-medal-2 { background:#8C98A8 !important; color:#fff !important; }
        .rank-number.rank-medal-3, .mobile-card-rank.rank-medal-3 { background:#B87333 !important; color:#fff !important; }
        .rebalance-asset { display:flex; flex-direction:column; gap:3px; }
        .rebalance-asset b { color:#0f172a; font-size:14px; }
        .rebalance-asset span { max-width:180px; color:#303846; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .target-input {
          width:88px; height:36px; display:flex; align-items:center; border:1px solid #cbd5e1;
          border-radius:10px; overflow:hidden; background:#fff;
        }
        .target-input input { width:64px; border:0; outline:0; padding:0 8px; font-weight:800; color:#0f172a; background:transparent; }
        .target-input span { color:#64748b; font-size:12px; }
        .gap-buy { color:#0066ff; }
        .gap-sell { color:#ef1b2d; }
        td small { display:block; margin-top:4px; color:#303846; font-size:10px; }
        .signal-badge { min-width:132px; display:flex; flex-direction:column; gap:7px; }
        .signal-badge b { font-size:11px; color:#303846; white-space:nowrap; }
        .signal-badge.buy.level-1 b,.signal-badge.buy.level-2 b,.signal-badge.buy.level-3 b { color:#0066ff; }
        .signal-badge.sell.level-1 b,.signal-badge.sell.level-2 b,.signal-badge.sell.level-3 b { color:#ef1b2d; }
        .signal-stage-bar { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; width:112px; }
        .signal-stage-bar i { height:10px; border-radius:999px; background:#e2e8f0; border:1px solid #dbe3ed; }
        .signal-badge.buy .signal-stage-bar .stage-1.active { background:#74a9ff; border-color:#74a9ff; }
        .signal-badge.buy .signal-stage-bar .stage-2.active { background:#0066ff; border-color:#0066ff; }
        .signal-badge.buy .signal-stage-bar .stage-3.active { background:#003cff; border-color:#003cff; }
        .signal-badge.sell .signal-stage-bar .stage-1.active { background:#ff9aa5; border-color:#ff9aa5; }
        .signal-badge.sell .signal-stage-bar .stage-2.active { background:#ff4757; border-color:#ff4757; }
        .signal-badge.sell .signal-stage-bar .stage-3.active { background:#ef1b2d; border-color:#ef1b2d; }
        .rebalance-score {
          width:82px; height:48px; border-radius:13px; display:flex; align-items:baseline;
          justify-content:center; gap:3px; border:1px solid transparent;
        }
        .rebalance-score strong { font-size:22px; }
        .rebalance-score span { font-size:9px; font-weight:800; opacity:.7; }
        .rebalance-score.low { background:#f8fafc; border-color:#e2e8f0; color:#64748b; }
        .rebalance-score.medium { background:#fff1e6; border-color:#ffb36d; color:#861f41; }
        .rebalance-score.high { background:#ffd2ad; border-color:#ff9d42; color:#861f41; }
        .rebalance-score.very-high { background:#861f41; border-color:#861f41; color:#fff; }
        .order-recommendation { min-width:145px; padding:11px 12px; border:2px solid #0066ff; border-radius:12px; background:#eef5ff; display:flex; flex-direction:column; gap:4px; }
        .order-recommendation strong { color:#0066ff; font-size:14px; }
        .order-recommendation.sell { border-color:#ef1b2d; background:#fff0f2; }
        .order-recommendation.sell strong { color:#ef1b2d; }
        .order-recommendation.balanced { border-color:#6b7280; background:#f3f4f6; }
        .order-recommendation span { color:#4b1b2a; font-size:9px; font-weight:800; line-height:1.35; }
        .metric-copy { display:flex; flex-direction:column; gap:5px; min-width:110px; }
        .metric-copy span { color:#303846; font-size:11px; white-space:nowrap; }
        .metric-copy .metric-down { color:#0066ff; font-weight:900; }
        .metric-copy .metric-up { color:#ef1b2d; font-weight:900; }
        .rebalance-empty { padding:54px; text-align:center; color:#64748b; }
        @media (max-width:1180px) {
          .score-criteria-formula { grid-template-columns:1fr; }
          .score-band-list { grid-template-columns:1fr 1fr; }
          .target-total { min-width:130px; }

          .rebalance-table-card {
            padding:16px;
          }
          .rebalance-table-scroll {
            overflow-x:visible;
          }
          .rebalance-table {
            display:block;
            width:100%;
            min-width:0;
          }
          .rebalance-table thead {
            display:none;
          }
          .rebalance-table tbody {
            display:grid;
            width:100%;
            gap:12px;
          }
          .rebalance-table tbody tr {
            display:grid;
            width:100%;
            grid-template-columns:42px minmax(145px,1.35fr) minmax(92px,.7fr) minmax(100px,.78fr) minmax(105px,.82fr);
            grid-template-areas:
              "rank asset score order order"
              "rank current target gap metric"
              "rank signal signal order metric";
            gap:11px 12px;
            align-items:center;
            padding:14px;
            border:1px solid #e2e8f0;
            border-radius:15px;
            background:#fff;
            box-sizing:border-box;
          }
          .rebalance-table tbody tr:hover {
            background:#fff;
            border-color:#cbd5e1;
          }
          .rebalance-table tbody td {
            min-width:0;
            padding:0;
            border:0;
          }
          .rebalance-rank-cell { grid-area:rank; align-self:stretch; display:flex; align-items:flex-start; }
          .rebalance-asset-cell { grid-area:asset; }
          .rebalance-current-cell { grid-area:current; }
          .rebalance-target-cell { grid-area:target; }
          .rebalance-gap-cell { grid-area:gap; }
          .rebalance-signal-cell { grid-area:signal; }
          .rebalance-score-cell { grid-area:score; justify-self:end; }
          .rebalance-order-cell { grid-area:order; justify-self:stretch; }
          .rebalance-metric-cell { grid-area:metric; align-self:stretch; }

          .mobile-cell-label {
            display:block;
            margin-bottom:5px;
            color:#94a3b8;
            font-size:9px;
            font-weight:900;
            letter-spacing:.07em;
            text-transform:uppercase;
          }
          .rebalance-asset span {
            max-width:100%;
          }
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-metric-cell {
            display:flex;
            min-width:0;
            flex-direction:column;
            align-items:flex-start;
          }
          .rebalance-gap-cell small {
            margin-top:3px;
          }
          .rebalance-score-cell {
            display:flex;
            align-items:center;
            gap:9px;
          }
          .rebalance-score-cell .mobile-cell-label {
            margin:0;
          }
          .rebalance-score {
            width:76px;
            height:44px;
          }
          .rebalance-score strong {
            font-size:20px;
          }
          .rebalance-signal-cell {
            padding-top:10px !important;
            border-top:1px solid #f1f5f9 !important;
          }
          .signal-badge {
            width:100%;
            min-width:0;
            display:grid;
            grid-template-columns:minmax(120px,1fr) auto;
            align-items:center;
            gap:10px;
          }
          .signal-stage-bar {
            width:100%;
            max-width:270px;
          }
          .signal-badge b {
            text-align:right;
          }
          .metric-copy {
            min-width:0;
          }
          .metric-copy span {
            white-space:normal;
          }
          .rebalance-empty {
            grid-column:1 / -1;
          }
        }

        @media (max-width:720px) {
          .criteria-grid { grid-template-columns:1fr; }
          .score-band-list { grid-template-columns:1fr; }
          .rebalancing-hero {
            align-items:flex-start;
            gap:12px;
          }
          .target-total {
            width:100%;
            min-width:0;
            align-items:flex-start;
            box-sizing:border-box;
          }

          .rebalance-table-card {
            padding:12px;
          }
          .rebalance-table tbody tr {
            grid-template-columns:34px minmax(0,1fr) minmax(76px,.52fr);
            grid-template-areas:
              "rank asset score"
              "order order order"
              "current target gap"
              "signal signal signal"
              "metric metric metric";
            gap:12px 10px;
            padding:13px;
          }
          .rank-number {
            width:28px;
            height:28px;
          }
          .rebalance-asset b {
            font-size:13px;
          }
          .rebalance-asset span {
            max-width:170px;
            font-size:10px;
          }
          .rebalance-score-cell {
            flex-direction:column;
            align-items:flex-end;
            gap:3px;
          }
          .rebalance-score-cell .mobile-cell-label {
            text-align:right;
            font-size:8px;
          }
          .rebalance-score {
            width:68px;
            height:42px;
          }
          .rebalance-score strong {
            font-size:19px;
          }
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:12px;
          }
          .target-input {
            width:100%;
            max-width:82px;
            height:34px;
          }
          .target-input input {
            width:56px;
            min-width:0;
            padding:0 6px;
            box-sizing:border-box;
          }
          .rebalance-order-cell,
          .rebalance-signal-cell,
          .rebalance-metric-cell {
            padding-top:10px !important;
            border-top:1px solid #f1f5f9 !important;
          }
          .signal-badge {
            grid-template-columns:1fr;
            gap:7px;
          }
          .signal-stage-bar {
            max-width:none;
          }
          .signal-badge b {
            text-align:left;
          }
          .order-recommendation { width:100%; min-width:0; box-sizing:border-box; }
          .metric-copy {
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:6px;
          }
          .metric-copy span {
            padding:7px 8px;
            border-radius:8px;
            background:#f8fafc;
            font-size:10px;
          }
        }

        @media (max-width:420px) {
          .rebalance-table tbody tr {
            grid-template-columns:30px minmax(0,1fr) 68px;
            gap:11px 8px;
            padding:11px;
          }
          .rebalance-asset span {
            max-width:125px;
          }
          .mobile-cell-label {
            font-size:8px;
          }
          .target-input {
            max-width:74px;
          }
          .target-input input {
            width:49px;
            font-size:11px;
          }
          .rebalance-score {
            width:62px;
          }
        }

        /* ===== Compact rebalancing rows =====
           Only vertical density is reduced. Scoring, buy/sell logic,
           target inputs, ordering and displayed metrics are unchanged. */

        /* Desktop table: closer to Portfolio Holdings row density */
        @media (min-width:1181px) {
          .rebalance-table td {
            padding-top:9px !important;
            padding-bottom:9px !important;
          }

          .rebalance-score {
            height:40px !important;
          }

          .order-recommendation {
            padding-top:7px !important;
            padding-bottom:7px !important;
            gap:2px !important;
          }

          .signal-badge {
            gap:4px !important;
          }

          .metric-copy {
            gap:3px !important;
          }
        }

        /* Tablet/card layout: reduce each security card's vertical footprint */
        @media (max-width:1180px) {
          .rebalance-table tbody {
            gap:8px !important;
          }

          .rebalance-table tbody tr {
            gap:7px 10px !important;
            padding:10px 12px !important;
            border-radius:13px !important;
          }

          .mobile-cell-label {
            margin-bottom:3px !important;
          }

          .rebalance-score {
            height:38px !important;
          }

          .rebalance-score-cell {
            gap:5px !important;
          }

          .rebalance-signal-cell {
            padding-top:6px !important;
          }

          .signal-badge {
            gap:6px !important;
          }

          .order-recommendation {
            padding:7px 10px !important;
            gap:2px !important;
          }

          .metric-copy {
            gap:3px !important;
          }
        }

        /* Mobile: substantially tighter vertically, while keeping all information */
        @media (max-width:720px) {
          .rebalance-table-card {
            padding:10px !important;
          }

          .rebalance-table tbody {
            gap:7px !important;
          }

          .rebalance-table tbody tr {
            gap:7px 9px !important;
            padding:9px 10px !important;
          }

          .rank-number {
            width:26px !important;
            height:26px !important;
          }

          .rebalance-asset {
            gap:1px !important;
          }

          .rebalance-score-cell {
            gap:1px !important;
          }

          .rebalance-score {
            height:34px !important;
          }

          .target-input {
            height:31px !important;
          }

          .rebalance-order-cell,
          .rebalance-signal-cell,
          .rebalance-metric-cell {
            padding-top:6px !important;
          }

          .order-recommendation {
            padding:6px 9px !important;
            border-radius:10px !important;
          }

          .signal-badge {
            gap:5px !important;
          }

          .metric-copy {
            gap:4px !important;
          }

          .metric-copy span {
            padding:5px 7px !important;
          }
        }

        @media (max-width:420px) {
          .rebalance-table tbody tr {
            gap:6px 7px !important;
            padding:8px 9px !important;
          }

          .rebalance-score {
            height:32px !important;
          }

          .order-recommendation {
            padding:5px 8px !important;
          }

          .metric-copy span {
            padding:4px 6px !important;
          }
        }


        /* ===== Ultra-compact mobile rebalancing rows =====
           Goal: ticker and the core numbers share the same first line.
           No scoring / order / metric data is removed. */
        @media (max-width:720px) {
          .rebalance-table-card {
            padding:7px !important;
          }

          .rebalance-table tbody {
            gap:5px !important;
          }

          .rebalance-table tbody tr {
            display:grid !important;
            grid-template-columns:24px minmax(82px,1.35fr) 54px 64px 58px 58px !important;
            grid-template-areas:
              "rank asset current target gap score"
              "rank order order signal signal score"
              "rank metric metric metric metric metric" !important;
            gap:4px 5px !important;
            align-items:center !important;
            min-height:0 !important;
            padding:7px 8px !important;
            border-radius:11px !important;
          }

          .rebalance-table tbody td {
            min-width:0 !important;
            min-height:0 !important;
          }

          .rebalance-rank-cell {
            align-self:stretch !important;
            align-items:flex-start !important;
            padding-top:1px !important;
          }

          .rank-number {
            width:22px !important;
            min-width:22px !important;
            height:22px !important;
            font-size:9px !important;
          }

          .rebalance-asset-cell,
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            align-self:center !important;
          }

          .rebalance-asset {
            display:flex !important;
            min-width:0 !important;
            flex-direction:column !important;
            gap:0 !important;
          }

          .rebalance-asset b {
            font-size:12px !important;
            line-height:1.05 !important;
          }

          .rebalance-asset span {
            max-width:100% !important;
            margin-top:2px !important;
            overflow:hidden !important;
            font-size:8px !important;
            line-height:1.05 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          /* Tiny labels keep alignment without creating another visual row. */
          .mobile-cell-label {
            margin:0 0 2px !important;
            font-size:6.8px !important;
            line-height:1 !important;
            letter-spacing:.035em !important;
            white-space:nowrap !important;
          }

          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell {
            justify-content:center !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:10px !important;
            line-height:1.05 !important;
            white-space:nowrap !important;
          }

          .target-input {
            width:60px !important;
            max-width:60px !important;
            height:25px !important;
            border-radius:7px !important;
          }

          .target-input input {
            width:42px !important;
            min-width:0 !important;
            height:23px !important;
            padding:0 3px !important;
            font-size:10px !important;
            line-height:1 !important;
          }

          .target-input span {
            font-size:9px !important;
          }

          .rebalance-score-cell {
            display:flex !important;
            flex-direction:column !important;
            align-items:flex-end !important;
            gap:1px !important;
          }

          .rebalance-score-cell .mobile-cell-label {
            text-align:right !important;
          }

          .rebalance-score {
            width:54px !important;
            height:31px !important;
            border-radius:9px !important;
          }

          .rebalance-score strong {
            font-size:16px !important;
            line-height:1 !important;
          }

          /* Second line: order and signal sit side-by-side. */
          .rebalance-order-cell,
          .rebalance-signal-cell {
            padding-top:4px !important;
            border-top:1px solid #f1f5f9 !important;
          }

          .rebalance-order-cell .mobile-cell-label,
          .rebalance-signal-cell .mobile-cell-label {
            display:none !important;
          }

          .order-recommendation {
            width:100% !important;
            min-width:0 !important;
            min-height:0 !important;
            padding:4px 6px !important;
            gap:0 !important;
            border-radius:8px !important;
          }

          .order-recommendation strong {
            font-size:9px !important;
            line-height:1.1 !important;
            white-space:nowrap !important;
          }

          .order-recommendation span {
            margin-top:1px !important;
            overflow:hidden !important;
            font-size:7px !important;
            line-height:1.05 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          .rebalance-signal-cell {
            align-self:stretch !important;
          }

          .signal-badge {
            display:grid !important;
            grid-template-columns:minmax(0,1fr) auto !important;
            gap:4px !important;
            align-items:center !important;
            min-height:27px !important;
          }

          .signal-stage-bar {
            width:100% !important;
            max-width:none !important;
            height:5px !important;
          }

          .signal-badge b {
            font-size:8px !important;
            line-height:1 !important;
            text-align:right !important;
            white-space:nowrap !important;
          }

          /* Third line: metrics are one compact horizontal strip instead of a tall grid. */
          .rebalance-metric-cell {
            padding-top:4px !important;
            border-top:1px solid #f1f5f9 !important;
            align-self:center !important;
          }

          .rebalance-metric-cell > .mobile-cell-label {
            display:none !important;
          }

          .metric-copy {
            display:flex !important;
            width:100% !important;
            min-width:0 !important;
            gap:4px !important;
            overflow-x:auto !important;
            overflow-y:hidden !important;
            scrollbar-width:none !important;
            -webkit-overflow-scrolling:touch !important;
          }

          .metric-copy::-webkit-scrollbar {
            display:none !important;
          }

          .metric-copy span {
            flex:0 0 auto !important;
            min-width:0 !important;
            padding:3px 5px !important;
            border-radius:6px !important;
            font-size:7.5px !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }
        }

        @media (max-width:420px) {
          .rebalance-table tbody tr {
            grid-template-columns:22px minmax(72px,1.25fr) 48px 58px 52px 52px !important;
            gap:4px !important;
            padding:6px 6px !important;
          }

          .rebalance-asset b {
            font-size:11px !important;
          }

          .rebalance-asset span {
            font-size:7.5px !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:9px !important;
          }

          .target-input {
            width:54px !important;
          }

          .target-input input {
            width:37px !important;
            font-size:9px !important;
          }

          .rebalance-score {
            width:49px !important;
            height:29px !important;
          }

          .rebalance-score strong {
            font-size:15px !important;
          }
        }


        /* ===== Refined compact mobile rebalancing layout =====
           Consistent typography + fixed column alignment + condensed metrics.
           No scoring / trading logic is changed. */
        @media (max-width:720px) {
          .rebalance-table-card {
            padding:7px !important;
          }

          .rebalance-table tbody {
            gap:5px !important;
          }

          .rebalance-table tbody tr {
            display:grid !important;
            grid-template-columns:
              24px
              minmax(78px,1.35fr)
              52px
              58px
              54px
              54px !important;
            grid-template-areas:
              "rank asset current target gap score"
              "rank order order signal signal score"
              "rank metric metric metric metric metric" !important;
            gap:4px 5px !important;
            align-items:center !important;
            min-height:0 !important;
            padding:7px 8px !important;
            border-radius:11px !important;
          }

          /* Shared text system */
          .rebalance-table tbody td,
          .rebalance-table tbody td b,
          .rebalance-table tbody td strong,
          .rebalance-table tbody td span,
          .rebalance-table tbody td input {
            font-family:inherit !important;
          }

          .mobile-cell-label {
            margin:0 0 2px !important;
            color:#8b95a4 !important;
            font-size:7px !important;
            font-weight:800 !important;
            line-height:1 !important;
            letter-spacing:.025em !important;
            text-transform:uppercase !important;
            white-space:nowrap !important;
          }

          .rebalance-table tbody td > b,
          .target-input input {
            font-size:10px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* Rank */
          .rebalance-rank-cell {
            align-self:stretch !important;
            display:flex !important;
            align-items:flex-start !important;
            padding-top:1px !important;
          }

          .rank-number {
            width:22px !important;
            min-width:22px !important;
            height:22px !important;
            font-size:9px !important;
            font-weight:900 !important;
          }

          /* Ticker / company */
          .rebalance-asset {
            display:flex !important;
            min-width:0 !important;
            flex-direction:column !important;
            gap:1px !important;
          }

          .rebalance-asset b {
            font-size:11px !important;
            font-weight:900 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .rebalance-asset span {
            max-width:100% !important;
            margin:0 !important;
            overflow:hidden !important;
            color:#8b95a4 !important;
            font-size:7.5px !important;
            font-weight:700 !important;
            line-height:1 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          /* Current / target / gap */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell {
            display:flex !important;
            min-width:0 !important;
            flex-direction:column !important;
            align-items:flex-start !important;
            justify-content:center !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:10px !important;
            font-weight:850 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .target-input {
            display:flex !important;
            width:56px !important;
            max-width:56px !important;
            height:24px !important;
            align-items:center !important;
            border-radius:7px !important;
          }

          .target-input input {
            width:39px !important;
            min-width:0 !important;
            height:22px !important;
            padding:0 3px !important;
            box-sizing:border-box !important;
          }

          .target-input span {
            font-size:8px !important;
            font-weight:800 !important;
          }

          /* Score: same vertical rhythm as first row */
          .rebalance-score-cell {
            display:flex !important;
            flex-direction:column !important;
            align-items:flex-end !important;
            justify-content:center !important;
            gap:2px !important;
          }

          .rebalance-score-cell .mobile-cell-label {
            margin:0 !important;
            text-align:right !important;
          }

          .rebalance-score {
            width:50px !important;
            height:30px !important;
            border-radius:8px !important;
          }

          .rebalance-score strong {
            font-size:15px !important;
            font-weight:900 !important;
            line-height:1 !important;
          }

          /* Row 2: order + signal, aligned to the same baseline */
          .rebalance-order-cell,
          .rebalance-signal-cell {
            padding-top:4px !important;
            border-top:1px solid #f1f5f9 !important;
            align-self:stretch !important;
            display:flex !important;
            align-items:center !important;
          }

          .rebalance-order-cell > .mobile-cell-label,
          .rebalance-signal-cell > .mobile-cell-label {
            display:none !important;
          }

          .order-recommendation {
            display:grid !important;
            width:100% !important;
            min-width:0 !important;
            min-height:28px !important;
            grid-template-columns:auto minmax(0,1fr) !important;
            align-items:center !important;
            gap:5px !important;
            padding:4px 6px !important;
            border-radius:8px !important;
            box-sizing:border-box !important;
          }

          .order-recommendation strong {
            font-size:8.5px !important;
            font-weight:900 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .order-recommendation span {
            margin:0 !important;
            overflow:hidden !important;
            font-size:7px !important;
            font-weight:700 !important;
            line-height:1 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          .signal-badge {
            display:grid !important;
            width:100% !important;
            min-width:0 !important;
            min-height:28px !important;
            grid-template-columns:minmax(0,1fr) auto !important;
            align-items:center !important;
            gap:5px !important;
          }

          .signal-stage-bar {
            width:100% !important;
            max-width:none !important;
            height:5px !important;
          }

          .signal-badge b {
            font-size:8px !important;
            font-weight:850 !important;
            line-height:1 !important;
            text-align:right !important;
            white-space:nowrap !important;
          }

          /* Row 3: all reference metrics in ONE compact information area */
          .rebalance-metric-cell {
            display:block !important;
            min-width:0 !important;
            padding-top:4px !important;
            border-top:1px solid #f1f5f9 !important;
          }

          .rebalance-metric-cell > .mobile-cell-label {
            display:none !important;
          }

          .metric-copy {
            display:flex !important;
            width:100% !important;
            min-width:0 !important;
            min-height:18px !important;
            align-items:center !important;
            gap:0 !important;
            padding:3px 6px !important;
            overflow:hidden !important;
            border-radius:7px !important;
            background:#f8fafc !important;
            box-sizing:border-box !important;
          }

          .metric-copy span {
            display:inline !important;
            flex:0 0 auto !important;
            margin:0 !important;
            padding:0 !important;
            border:0 !important;
            border-radius:0 !important;
            background:transparent !important;
            font-size:7.5px !important;
            font-weight:750 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .metric-copy span + span::before {
            content:" · ";
            margin:0 4px !important;
            color:#a8b0bd !important;
            font-weight:700 !important;
          }
        }

        @media (max-width:420px) {
          .rebalance-table tbody tr {
            grid-template-columns:
              22px
              minmax(70px,1.25fr)
              46px
              54px
              48px
              50px !important;
            gap:4px !important;
            padding:6px !important;
          }

          .rebalance-asset b {
            font-size:10.5px !important;
          }

          .rebalance-asset span {
            font-size:7px !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input {
            font-size:9px !important;
          }

          .target-input {
            width:51px !important;
          }

          .target-input input {
            width:35px !important;
          }

          .rebalance-score {
            width:47px !important;
            height:28px !important;
          }

          .rebalance-score strong {
            font-size:14px !important;
          }

          .metric-copy {
            padding-left:5px !important;
            padding-right:5px !important;
          }

          .metric-copy span {
            font-size:7px !important;
          }
        }


        /* ===== Mobile rebalance layout v2: strict rows + aligned columns ===== */
        @media (max-width:720px) {
          .rebalance-table-card {
            padding:8px !important;
          }

          .rebalance-table tbody {
            gap:6px !important;
          }

          .rebalance-table tbody tr {
            display:grid !important;
            grid-template-columns:
              24px
              minmax(86px,1.45fr)
              54px
              60px
              56px
              56px !important;
            grid-template-areas:
              "rank asset current target gap score"
              "rank order order signal signal signal"
              "rank metric metric metric metric metric" !important;
            gap:6px 6px !important;
            align-items:start !important;
            min-height:0 !important;
            padding:8px 9px !important;
            border-radius:12px !important;
            box-sizing:border-box !important;
          }

          .rebalance-table tbody td {
            min-width:0 !important;
            min-height:0 !important;
            padding:0 !important;
          }

          /* ----- TOP ROW: all values top-aligned ----- */
          .rebalance-rank-cell,
          .rebalance-asset-cell,
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            align-self:start !important;
          }

          .rebalance-rank-cell {
            display:flex !important;
            align-items:flex-start !important;
            justify-content:flex-start !important;
            padding-top:1px !important;
          }

          .rank-number {
            width:22px !important;
            min-width:22px !important;
            height:22px !important;
            font-size:9px !important;
            font-weight:900 !important;
          }

          .rebalance-asset {
            display:flex !important;
            min-width:0 !important;
            flex-direction:column !important;
            gap:2px !important;
            padding-top:1px !important;
          }

          .rebalance-asset b {
            font-size:11px !important;
            font-weight:900 !important;
            line-height:1 !important;
          }

          .rebalance-asset span {
            max-width:100% !important;
            margin:0 !important;
            overflow:hidden !important;
            color:#8b95a4 !important;
            font-size:7.5px !important;
            font-weight:700 !important;
            line-height:1.05 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            display:flex !important;
            min-width:0 !important;
            flex-direction:column !important;
            align-items:flex-start !important;
            justify-content:flex-start !important;
            gap:3px !important;
            padding-top:0 !important;
          }

          .mobile-cell-label {
            display:block !important;
            margin:0 !important;
            color:#8b95a4 !important;
            font-size:6.8px !important;
            font-weight:850 !important;
            line-height:1 !important;
            letter-spacing:.02em !important;
            text-transform:uppercase !important;
            white-space:nowrap !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:10px !important;
            font-weight:850 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .target-input {
            display:flex !important;
            width:57px !important;
            max-width:57px !important;
            height:24px !important;
            align-items:center !important;
            border-radius:7px !important;
          }

          .target-input input {
            width:40px !important;
            min-width:0 !important;
            height:22px !important;
            padding:0 3px !important;
            box-sizing:border-box !important;
            font-size:9.5px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          .target-input span {
            font-size:8px !important;
            font-weight:800 !important;
          }

          .rebalance-score-cell {
            align-items:flex-end !important;
          }

          .rebalance-score-cell .mobile-cell-label {
            text-align:right !important;
          }

          .rebalance-score {
            width:51px !important;
            height:29px !important;
            border-radius:8px !important;
          }

          .rebalance-score strong {
            font-size:14px !important;
            font-weight:900 !important;
            line-height:1 !important;
          }

          /* ----- SECOND ROW: order and signal are separated from top row ----- */
          .rebalance-order-cell,
          .rebalance-signal-cell {
            display:flex !important;
            min-width:0 !important;
            align-items:center !important;
            align-self:stretch !important;
            padding-top:6px !important;
            border-top:1px solid #edf1f5 !important;
          }

          .rebalance-order-cell > .mobile-cell-label,
          .rebalance-signal-cell > .mobile-cell-label {
            display:none !important;
          }

          .order-recommendation {
            display:grid !important;
            width:100% !important;
            min-width:0 !important;
            min-height:30px !important;
            grid-template-columns:auto minmax(0,1fr) !important;
            align-items:center !important;
            gap:6px !important;
            padding:5px 7px !important;
            border-radius:8px !important;
            box-sizing:border-box !important;
          }

          .order-recommendation strong {
            font-size:8.5px !important;
            font-weight:900 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .order-recommendation span {
            margin:0 !important;
            overflow:hidden !important;
            font-size:7px !important;
            font-weight:700 !important;
            line-height:1 !important;
            text-overflow:ellipsis !important;
            white-space:nowrap !important;
          }

          .signal-badge {
            display:grid !important;
            width:100% !important;
            min-width:0 !important;
            min-height:30px !important;
            grid-template-columns:minmax(0,1fr) auto !important;
            align-items:center !important;
            gap:6px !important;
            padding:0 !important;
          }

          .signal-stage-bar {
            width:100% !important;
            max-width:none !important;
            height:6px !important;
          }

          .signal-badge b {
            font-size:8.5px !important;
            font-weight:850 !important;
            line-height:1 !important;
            text-align:right !important;
            white-space:nowrap !important;
          }

          /* ----- THIRD ROW: reference metrics as neat individual boxes ----- */
          .rebalance-metric-cell {
            display:block !important;
            min-width:0 !important;
            padding-top:6px !important;
            border-top:1px solid #edf1f5 !important;
          }

          .rebalance-metric-cell > .mobile-cell-label {
            display:none !important;
          }

          .metric-copy {
            display:grid !important;
            width:100% !important;
            min-width:0 !important;
            grid-template-columns:repeat(4,minmax(0,1fr)) !important;
            gap:5px !important;
            padding:0 !important;
            background:transparent !important;
            overflow:visible !important;
          }

          .metric-copy span {
            display:flex !important;
            min-width:0 !important;
            min-height:24px !important;
            margin:0 !important;
            padding:4px 5px !important;
            align-items:center !important;
            justify-content:center !important;
            border:1px solid #e7ebf0 !important;
            border-radius:7px !important;
            background:#f8fafc !important;
            color:#303846 !important;
            font-size:7.2px !important;
            font-weight:800 !important;
            line-height:1.05 !important;
            text-align:center !important;
            white-space:normal !important;
            box-sizing:border-box !important;
          }

          .metric-copy span + span::before {
            content:none !important;
          }
        }

        @media (max-width:480px) {
          .rebalance-table tbody tr {
            grid-template-columns:
              22px
              minmax(72px,1.3fr)
              48px
              55px
              50px
              50px !important;
            gap:5px !important;
            padding:7px !important;
          }

          .rebalance-asset b {
            font-size:10.5px !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input {
            font-size:9px !important;
          }

          .rebalance-score {
            width:47px !important;
            height:28px !important;
          }

          .rebalance-score strong {
            font-size:13px !important;
          }

          /* If 4 metric boxes become too narrow, switch to 2x2 only. */
          .metric-copy {
            grid-template-columns:repeat(2,minmax(0,1fr)) !important;
            gap:4px !important;
          }

          .metric-copy span {
            min-height:22px !important;
            font-size:7.2px !important;
          }
        }


        /* ===== Mobile rebalance layout v3: tighter top row + no internal divider lines ===== */
        @media (max-width:720px) {
          .rebalance-table tbody tr {
            grid-template-columns:
              22px
              minmax(72px,1.30fr)
              48px
              54px
              50px
              50px !important;
            grid-template-areas:
              "rank asset current target gap score"
              "rank order order signal signal signal"
              "rank metric metric metric metric metric" !important;
            column-gap:5px !important;
            row-gap:5px !important;
            padding:7px 8px !important;
          }

          /* Pull the numeric columns left and keep every top-row item inside row 1. */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            align-self:start !important;
            justify-self:stretch !important;
            min-width:0 !important;
            padding-top:0 !important;
          }

          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell {
            align-items:flex-start !important;
          }

          .rebalance-score-cell {
            align-items:flex-end !important;
            justify-content:flex-start !important;
            height:auto !important;
            min-height:0 !important;
          }

          .rebalance-score {
            width:46px !important;
            min-width:46px !important;
            height:26px !important;
            min-height:26px !important;
            max-height:26px !important;
            border-radius:7px !important;
          }

          .rebalance-score strong {
            font-size:13px !important;
            line-height:1 !important;
          }

          .target-input {
            width:51px !important;
            max-width:51px !important;
            height:23px !important;
          }

          .target-input input {
            width:35px !important;
            height:21px !important;
            font-size:9px !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            font-size:9.5px !important;
          }

          /* Remove all internal gray divider lines.
             Only the outer card border remains as the guide. */
          .rebalance-order-cell,
          .rebalance-signal-cell,
          .rebalance-metric-cell {
            border-top:0 !important;
          }

          .rebalance-order-cell,
          .rebalance-signal-cell {
            padding-top:2px !important;
          }

          .rebalance-metric-cell {
            padding-top:2px !important;
          }

          /* Keep the second row clearly separate by spacing, not divider lines. */
          .order-recommendation,
          .signal-badge {
            min-height:28px !important;
          }

          /* Reference boxes remain individual and tidy. */
          .metric-copy {
            gap:4px !important;
          }

          .metric-copy span {
            min-height:22px !important;
            padding:4px !important;
          }
        }

        @media (max-width:480px) {
          .rebalance-table tbody tr {
            grid-template-columns:
              20px
              minmax(66px,1.25fr)
              44px
              50px
              46px
              46px !important;
            column-gap:4px !important;
            row-gap:4px !important;
            padding:6px 7px !important;
          }

          .rank-number {
            width:20px !important;
            min-width:20px !important;
            height:20px !important;
          }

          .rebalance-asset b {
            font-size:10px !important;
          }

          .rebalance-asset span {
            font-size:7px !important;
          }

          .rebalance-score {
            width:43px !important;
            min-width:43px !important;
            height:25px !important;
            min-height:25px !important;
            max-height:25px !important;
          }

          .rebalance-score strong {
            font-size:12px !important;
          }

          .target-input {
            width:47px !important;
            max-width:47px !important;
          }

          .target-input input {
            width:32px !important;
          }
        }


        /* ===== Mobile top-row value alignment + non-wrapping score ===== */
        @media (max-width:720px) {
          /* Every top-row metric uses the same label/value rhythm. */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            display:grid !important;
            min-width:0 !important;
            grid-template-rows:10px 28px !important;
            align-items:start !important;
            align-content:start !important;
            gap:2px !important;
            padding:0 !important;
          }

          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell {
            justify-items:start !important;
          }

          .rebalance-score-cell {
            justify-items:end !important;
          }

          .rebalance-current-cell > .mobile-cell-label,
          .rebalance-target-cell > .mobile-cell-label,
          .rebalance-gap-cell > .mobile-cell-label,
          .rebalance-score-cell > .mobile-cell-label {
            display:flex !important;
            height:10px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:flex-start !important;
            font-size:6.8px !important;
            font-weight:850 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          /* Same numeric font size / weight / vertical center. */
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong {
            font-size:10px !important;
            font-weight:900 !important;
            line-height:1 !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            display:flex !important;
            height:28px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:center !important;
            white-space:nowrap !important;
          }

          .target-input {
            display:flex !important;
            width:51px !important;
            max-width:51px !important;
            height:28px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:center !important;
            border-radius:7px !important;
          }

          .target-input input {
            width:35px !important;
            min-width:35px !important;
            height:26px !important;
            padding:0 3px !important;
            text-align:center !important;
            box-sizing:border-box !important;
          }

          .target-input span {
            display:flex !important;
            height:26px !important;
            align-items:center !important;
            font-size:8px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* Score stays entirely on ONE line: 100/100. */
          .rebalance-score {
            display:flex !important;
            width:52px !important;
            min-width:52px !important;
            max-width:52px !important;
            height:28px !important;
            min-height:28px !important;
            max-height:28px !important;
            flex-wrap:nowrap !important;
            align-items:center !important;
            justify-content:center !important;
            gap:1px !important;
            margin:0 !important;
            padding:0 3px !important;
            box-sizing:border-box !important;
            overflow:hidden !important;
            white-space:nowrap !important;
            border-radius:7px !important;
          }

          .rebalance-score strong,
          .rebalance-score span {
            display:inline-block !important;
            flex:0 0 auto !important;
            margin:0 !important;
            padding:0 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .rebalance-score strong {
            font-size:10px !important;
          }

          .rebalance-score span {
            font-size:7px !important;
            font-weight:850 !important;
          }
        }

        @media (max-width:480px) {
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong {
            font-size:9px !important;
          }

          .rebalance-score {
            width:48px !important;
            min-width:48px !important;
            max-width:48px !important;
          }

          .rebalance-score span {
            font-size:6.5px !important;
          }
        }


        /* ===== Mobile top-row vertical centering + unified value scale ===== */
        @media (max-width:720px) {
          /* Keep the four top metrics in the same two-row rhythm:
             label row + value row, both vertically centered. */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            display:grid !important;
            grid-template-rows:12px 28px !important;
            align-items:center !important;
            align-content:center !important;
            row-gap:2px !important;
          }

          .rebalance-current-cell > .mobile-cell-label,
          .rebalance-target-cell > .mobile-cell-label,
          .rebalance-gap-cell > .mobile-cell-label,
          .rebalance-score-cell > .mobile-cell-label {
            display:flex !important;
            height:12px !important;
            align-items:center !important;
            justify-content:flex-start !important;
            margin:0 !important;
            padding:0 !important;
            line-height:1 !important;
          }

          .rebalance-score-cell > .mobile-cell-label {
            justify-content:flex-end !important;
            width:100% !important;
          }

          /* The value row is also centered vertically for all four columns. */
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .rebalance-target-cell > .target-input,
          .rebalance-score-cell > .rebalance-score {
            align-self:center !important;
            margin:0 !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            display:flex !important;
            height:28px !important;
            align-items:center !important;
          }

          .target-input {
            height:28px !important;
            align-items:center !important;
          }

          /* Unified primary value size:
             current %, target %, gap %, rebalance score all match. */
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong {
            font-size:9.5px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          .rebalance-score span {
            font-size:7px !important;
            font-weight:800 !important;
            line-height:1 !important;
          }

          /* Make the score box visually equivalent to the other numeric fields,
             not an oversized focal element. */
          .rebalance-score {
            width:49px !important;
            min-width:49px !important;
            max-width:49px !important;
            height:27px !important;
            min-height:27px !important;
            max-height:27px !important;
            gap:1px !important;
            padding:0 2px !important;
            border-radius:7px !important;
          }

          /* Buy/Sell stage text should not dominate the row. */
          .signal-badge b {
            font-size:7.5px !important;
            font-weight:850 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          .signal-badge {
            min-height:26px !important;
            gap:4px !important;
          }

          .signal-stage-bar {
            height:5px !important;
          }
        }

        @media (max-width:480px) {
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong {
            font-size:9px !important;
          }

          .rebalance-score {
            width:47px !important;
            min-width:47px !important;
            max-width:47px !important;
            height:26px !important;
            min-height:26px !important;
            max-height:26px !important;
          }

          .rebalance-score span {
            font-size:6.5px !important;
          }

          .signal-badge b {
            font-size:7px !important;
          }
        }


        /* ===== FINAL mobile top-metric alignment =====
           Four columns use one identical label/value system.
           Buy/Sell stage and rebalance score use the same value font scale. */
        @media (max-width:720px) {

          /* CURRENT / TARGET / GAP / SCORE: identical 42px vertical structure */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            display:grid !important;
            height:42px !important;
            min-height:42px !important;
            max-height:42px !important;
            grid-template-rows:14px 28px !important;
            align-items:center !important;
            justify-items:center !important;
            align-content:center !important;
            justify-content:stretch !important;
            row-gap:0 !important;
            margin:0 !important;
            padding:0 !important;
          }

          /* All four headings centered directly above their values */
          .rebalance-current-cell > .mobile-cell-label,
          .rebalance-target-cell > .mobile-cell-label,
          .rebalance-gap-cell > .mobile-cell-label,
          .rebalance-score-cell > .mobile-cell-label {
            display:flex !important;
            width:100% !important;
            height:14px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:center !important;
            justify-content:center !important;
            color:#8b95a4 !important;
            font-size:6.8px !important;
            font-weight:850 !important;
            line-height:1 !important;
            letter-spacing:.015em !important;
            text-align:center !important;
            white-space:nowrap !important;
          }

          /* Same value size / weight / line-height across all four columns */
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong,
          .signal-badge b {
            font-size:9px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            display:flex !important;
            width:100% !important;
            height:28px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:center !important;
            justify-content:center !important;
            text-align:center !important;
            white-space:nowrap !important;
          }

          /* Target input centered exactly like the plain numeric values */
          .rebalance-target-cell > .target-input {
            align-self:center !important;
            justify-self:center !important;
          }

          .target-input {
            display:flex !important;
            width:50px !important;
            max-width:50px !important;
            height:26px !important;
            margin:0 !important;
            padding:0 !important;
            align-items:center !important;
            justify-content:center !important;
            border-radius:7px !important;
          }

          .target-input input {
            width:34px !important;
            min-width:34px !important;
            height:24px !important;
            margin:0 !important;
            padding:0 2px !important;
            text-align:center !important;
            box-sizing:border-box !important;
          }

          .target-input span {
            display:flex !important;
            height:24px !important;
            align-items:center !important;
            justify-content:center !important;
            font-size:7px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* Score no longer visually larger than the other numbers */
          .rebalance-score-cell {
            align-items:center !important;
            justify-items:center !important;
          }

          .rebalance-score {
            display:flex !important;
            width:48px !important;
            min-width:48px !important;
            max-width:48px !important;
            height:26px !important;
            min-height:26px !important;
            max-height:26px !important;
            margin:0 !important;
            padding:0 2px !important;
            flex-wrap:nowrap !important;
            align-items:center !important;
            justify-content:center !important;
            gap:1px !important;
            border-radius:7px !important;
            box-sizing:border-box !important;
            white-space:nowrap !important;
          }

          .rebalance-score strong {
            display:inline !important;
            margin:0 !important;
            padding:0 !important;
            font-size:9px !important;
          }

          .rebalance-score span {
            display:inline !important;
            margin:0 !important;
            padding:0 !important;
            font-size:6.5px !important;
            font-weight:800 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }

          /* Buy/Sell stage text matches the other numeric/value text scale */
          .signal-badge {
            min-height:26px !important;
            align-items:center !important;
            gap:4px !important;
          }

          .signal-badge b {
            margin:0 !important;
            padding:0 !important;
            font-size:9px !important;
            font-weight:850 !important;
            line-height:1 !important;
            text-align:right !important;
            white-space:nowrap !important;
          }

          .signal-stage-bar {
            height:5px !important;
          }
        }

        @media (max-width:480px) {
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .rebalance-score strong,
          .signal-badge b {
            font-size:8.5px !important;
          }

          .rebalance-score {
            width:46px !important;
            min-width:46px !important;
            max-width:46px !important;
          }

          .rebalance-score span {
            font-size:6px !important;
          }
        }


        /* ===== FINAL mobile typography system =====
           Rule: inside each rebalance card, every visible value/text uses ONE
           font size, except:
           1) company full name under ticker
           2) CURRENT / TARGET / GAP / REBALANCING SCORE labels
        */
        @media (max-width:720px) {
          /* One universal content size */
          .rebalance-table tbody tr,
          .rebalance-table tbody tr b,
          .rebalance-table tbody tr strong,
          .rebalance-table tbody tr span,
          .rebalance-table tbody tr input {
            font-size:9px !important;
            line-height:1 !important;
          }

          /* Ticker is part of the normal content scale */
          .rebalance-asset b {
            font-size:9px !important;
            font-weight:900 !important;
            line-height:1 !important;
          }

          /* EXCEPTION 1: company full name remains smaller */
          .rebalance-asset span {
            font-size:7px !important;
            font-weight:700 !important;
            line-height:1 !important;
          }

          /* EXCEPTION 2: four top headings remain smaller */
          .rebalance-current-cell > .mobile-cell-label,
          .rebalance-target-cell > .mobile-cell-label,
          .rebalance-gap-cell > .mobile-cell-label,
          .rebalance-score-cell > .mobile-cell-label {
            font-size:6.8px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* All four values are exactly the same scale */
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .target-input span,
          .rebalance-score strong,
          .rebalance-score span {
            font-size:9px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* Score text 100/100 uses identical type, no tiny suffix */
          .rebalance-score {
            width:55px !important;
            min-width:55px !important;
            max-width:55px !important;
            height:27px !important;
            min-height:27px !important;
            max-height:27px !important;
            gap:0 !important;
            padding:0 3px !important;
          }

          .rebalance-score strong,
          .rebalance-score span {
            display:inline-block !important;
            flex:0 0 auto !important;
            margin:0 !important;
            padding:0 !important;
            white-space:nowrap !important;
          }

          /* BUY/SELL stage text exactly matches every other value */
          .signal-badge b {
            font-size:9px !important;
            font-weight:850 !important;
            line-height:1 !important;
          }

          /* Recommendation text: both lines use the same font size */
          .order-recommendation strong,
          .order-recommendation span {
            font-size:9px !important;
            line-height:1.05 !important;
          }

          /* Reference metric boxes use the same font size */
          .metric-copy span {
            font-size:9px !important;
            font-weight:800 !important;
            line-height:1 !important;
          }

          /* Percent symbol in target input also matches */
          .target-input span {
            font-size:9px !important;
          }

          /* Preserve the successful centered top-row alignment */
          .rebalance-current-cell,
          .rebalance-target-cell,
          .rebalance-gap-cell,
          .rebalance-score-cell {
            height:42px !important;
            min-height:42px !important;
            max-height:42px !important;
            grid-template-rows:14px 28px !important;
            align-items:center !important;
            align-content:center !important;
          }

          .rebalance-current-cell > b,
          .rebalance-gap-cell > b {
            height:28px !important;
            align-items:center !important;
            justify-content:center !important;
          }

          .rebalance-target-cell > .target-input,
          .rebalance-score-cell > .rebalance-score {
            align-self:center !important;
            justify-self:center !important;
          }
        }

        /* Mobile header spacing: align the target summary with the cards below. */
        @media (max-width:720px) {
          .rebalancing-page {
            gap:8px !important;
          }
          .rebalancing-hero {
            margin-bottom:0 !important;
            box-sizing:border-box !important;
          }
          /* The shared .hero has 18px horizontal padding on mobile.
             Extend only the target box to the same outer edges as the cards. */
          .rebalancing-hero .target-total {
            width:calc(100% + 36px) !important;
            max-width:none !important;
            margin-left:-18px !important;
            margin-right:-18px !important;
            box-sizing:border-box !important;
          }
        }

        @media (max-width:480px) {
          /* Do NOT independently shrink stage/score on small phones.
             Keep the exact same visual scale system. */
          .rebalance-table tbody tr,
          .rebalance-table tbody tr b,
          .rebalance-table tbody tr strong,
          .rebalance-table tbody tr span,
          .rebalance-table tbody tr input,
          .rebalance-current-cell > b,
          .rebalance-gap-cell > b,
          .target-input input,
          .target-input span,
          .rebalance-score strong,
          .rebalance-score span,
          .signal-badge b,
          .order-recommendation strong,
          .order-recommendation span,
          .metric-copy span,
          .rebalance-asset b {
            font-size:9px !important;
          }

          .rebalance-asset span {
            font-size:7px !important;
          }

          .rebalance-current-cell > .mobile-cell-label,
          .rebalance-target-cell > .mobile-cell-label,
          .rebalance-gap-cell > .mobile-cell-label,
          .rebalance-score-cell > .mobile-cell-label {
            font-size:6.8px !important;
          }

          .rebalance-score {
            width:55px !important;
            min-width:55px !important;
            max-width:55px !important;
          }
        }

      
        /* Unified mobile vertical rhythm: the four section boundaries share 7px. */
        @media (max-width:760px) {
          .rebalancing-page { row-gap:7px !important; }
          .rebalancing-page > .rebalancing-hero {
            display:flex !important;
            flex-direction:column !important;
            gap:7px !important;
            margin:0 !important;
            padding-top:0 !important;
            padding-bottom:0 !important;
          }
          .rebalancing-hero > div:first-child { margin:0 !important; }
          .rebalancing-hero > div:first-child > p { margin-bottom:0 !important; }
          .rebalancing-page > .criteria-card { margin-top:0 !important; }
          .rebalancing-page > .rebalancing-hero .target-total { margin-top:0 !important; margin-bottom:0 !important; }
          .rebalancing-hero .target-total {
            padding-top:11px !important;
            padding-bottom:11px !important;
          }
        }

        /* Scoring Criteria only: 8px padding above the first label and below
           the second label in the collapsed header. Keep the toggle vertically
           centered without altering its horizontal position or behavior. */
        .rebalancing-page > .criteria-card {
          padding-top:8px !important;
          padding-bottom:8px !important;
          padding-left:18px !important;
        }
        .rebalancing-page > .criteria-card > .criteria-toggle-header {
          align-items:center !important;
        }

        /* Target total only: 18px left, 8px above title and below value. */
        .rebalancing-hero .target-total {
          padding-left:18px !important;
          padding-top:8px !important;
          padding-bottom:8px !important;
        }

        /* Match the actual first-label line box in both orange summary cards.
           Shared explicit line-height prevents the target label's font metrics
           from visually shifting its top inset relative to Scoring Criteria. */
        .rebalancing-hero .target-total > span,
        .rebalancing-page > .criteria-card .criteria-title > span {
          display:block !important;
          margin-top:0 !important;
          padding-top:0 !important;
          line-height:14px !important;
        }
        .rebalancing-hero .target-total {
          padding-top:8px !important;
        }
        .rebalancing-page > .criteria-card {
          padding-top:8px !important;
        }

        /* Tighter spacing ONLY between the three expanded Scoring Criteria cards. */
        .rebalancing-page .criteria-collapsible-content > .rebalance-score-criteria {
          margin-bottom:7px !important;
        }
        .rebalancing-page .criteria-collapsible-content > .criteria-grid {
          gap:7px !important;
        }

        /* Orange outline for the three requested rebalancing card types.
           Keep the original 1px thickness and all existing spacing. */
        .rebalancing-hero .target-total,
        .rebalancing-page > .criteria-card,
        .rebalance-mobile-card {
          border:1px solid #e87722 !important;
        }
        @media (min-width:721px) and (max-width:1180px) {
          .rebalance-table tbody tr { border-color:#e87722 !important; }
          .rebalance-table tbody tr:hover { border-color:#e87722 !important; }
        }

        /* Align the two rebalancing summary cards with the collapsed
           Portfolio Leaders / Portfolio Allocation heading insets.
           Change only text-to-border insets, not card-to-card spacing. */
        .rebalancing-page > .rebalancing-hero .target-total,
        .rebalancing-page > .criteria-card {
          box-sizing:border-box !important;
          padding-top:8px !important;
          padding-bottom:8px !important;
          padding-left:18px !important;
          padding-right:18px !important;
        }
        .rebalancing-page > .rebalancing-hero .target-total {
          align-items:flex-start !important;
        }
        .rebalancing-page > .rebalancing-hero .target-total > span,
        .rebalancing-page > .criteria-card .criteria-title > span {
          margin-top:0 !important;
          padding-top:0 !important;
          line-height:14px !important;
        }
        .rebalancing-page > .criteria-card > .criteria-toggle-header {
          align-items:center !important;
        }


        /* Match Portfolio Leaders / Top Holdings typography only.
           Keep Scoring Criteria padding, border and toggle unchanged. */
        .rebalancing-page > .criteria-card .criteria-title > span {
          font-size:10px !important;
          font-weight:900 !important;
          letter-spacing:.12em !important;
        }
        .rebalancing-page > .criteria-card .criteria-title > h2 {
          font-size:15px !important;
          font-weight:800 !important;
          line-height:1.15 !important;
        }

        /* iOS Safari: keep the REAL editable input at 16px to prevent focus zoom.
           A non-interactive mirror shows the original 9px typography without
           transforming/scaling the focused input (which can re-trigger zoom). */
        .target-value-mirror { display:none; }
        @media (max-width:720px) {
          .target-input,
          .mobile-card-target-input { position:relative !important; }
          .target-input input,
          .mobile-card-target-input input {
            font-size:16px !important;
            transform:none !important;
            position:relative !important;
            z-index:2 !important;
            color:transparent !important;
            -webkit-text-fill-color:transparent !important;
            caret-color:#0f172a !important;
          }
          .target-input .target-value-mirror,
          .mobile-card-target-input .target-value-mirror {
            display:flex !important;
            position:absolute !important;
            left:2px !important;
            top:0 !important;
            bottom:0 !important;
            width:calc(100% - 15px) !important;
            align-items:center !important;
            justify-content:center !important;
            pointer-events:none !important;
            z-index:3 !important;
            color:#0f172a !important;
            font-family:inherit !important;
            font-size:9px !important;
            font-weight:850 !important;
            line-height:1 !important;
            white-space:nowrap !important;
          }
          .mobile-card-target-input .target-value-mirror {
            font-size:10px !important;
          }
        }

`}</style>

      {/* Match the two upper Rebalancing cards to the Portfolio Leaders / Top Holdings visual language.
          This is intentionally scoped; the scoring rules and expanded inner cards are unchanged. */}
      <style jsx global>{`
        .app-shell.app-rebalancing-active .rebalancing-page > .rebalancing-hero .target-total,
        .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card {
          box-sizing: border-box !important;
          border: 1px solid #e87722 !important;
          border-radius: 16px !important;
          background: #ffffff !important;
          padding: 8px 18px !important;
          min-height: 0 !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .rebalancing-hero .target-total {
          display: flex !important;
          flex-direction: column !important;
          align-items: flex-start !important;
          justify-content: flex-start !important;
          gap: 0 !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .rebalancing-hero .target-total > span,
        .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card .criteria-title > span {
          display: block !important;
          padding: 0 !important;
          margin: 0 !important;
          color: #e87722 !important;
          font-size: 10px !important;
          font-weight: 900 !important;
          letter-spacing: .12em !important;
          line-height: 14px !important;
          text-transform: uppercase !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .rebalancing-hero .target-total > strong {
          display: block !important;
          padding: 0 !important;
          margin: 5px 0 0 !important;
          color: #861f41 !important;
          font-size: 22px !important;
          font-weight: 950 !important;
          letter-spacing: -.03em !important;
          line-height: 1.15 !important;
          text-align: left !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card > .criteria-toggle-header {
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 12px !important;
          min-height: 0 !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card .criteria-title {
          flex: 1 1 auto !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card .criteria-toggle-button {
          flex: 0 0 auto !important;
          align-self: center !important;
          min-height: 36px !important;
          padding: 8px 12px !important;
          border: 1px solid #ffd2ad !important;
          border-radius: 10px !important;
          background: #fff7ed !important;
          color: #861f41 !important;
          font-size: 11px !important;
          font-weight: 800 !important;
          white-space: nowrap !important;
        }
        @media (max-width: 760px) {
          .app-shell.app-rebalancing-active .rebalancing-page > .rebalancing-hero .target-total {
            /* Keep the existing card-width alignment with the cards below. */
            padding: 8px 18px !important;
          }
          .app-shell.app-rebalancing-active .rebalancing-page > .criteria-card .criteria-title > h2 {
            overflow-wrap: anywhere !important;
          }
        }


        /* Buy-only visual reference; no effect on signal calculations or sell criteria. */
        .rebalancing-page .buy-rsi-visual,
        .rebalancing-page .sell-rsi-visual {
          display:flex; flex-direction:column; gap:9px; margin-top:15px;
          padding:12px; border:1px solid #ffd2ad; border-radius:11px; background:#fffaf5;
          min-width:0;
        }
        .rebalancing-page .buy-rsi-visual-title { color:#210a13; font-size:11px; font-weight:900; }
        .rebalancing-page .buy-rsi-visual-title > span { color:#1e3a8a; margin-left:5px; }
        .rebalancing-page .buy-rsi-table-wrap { overflow-x:auto; width:100%; }
        .rebalancing-page .buy-rsi-table { width:100%; border-collapse:collapse; font-size:10px; text-align:left; }
        .rebalancing-page .buy-rsi-table th, .rebalancing-page .buy-rsi-table td {
          padding:7px 6px; border-bottom:1px solid #f3e4d9; white-space:nowrap;
        }
        .rebalancing-page .buy-rsi-table thead th { color:#861f41; font-weight:900; background:#fff3e9; }
        .rebalancing-page .buy-rsi-table tbody th { color:#210a13; font-weight:850; }
        .rebalancing-page .buy-rsi-table tbody td { color:#475569; }
        .rebalancing-page .buy-rsi-table tbody tr:last-child th,
        .rebalancing-page .buy-rsi-table tbody tr:last-child td { border-bottom:0; }
        .rebalancing-page .buy-rsi-score-bar { display:flex; overflow:hidden; height:12px; border-radius:999px; }
        .rebalancing-page .buy-rsi-score-bar .buy-rsi-base { width:85%; background:#861f41; }
        .rebalancing-page .buy-rsi-score-bar .buy-rsi-low { width:10%; background:#e87722; }
        .rebalancing-page .buy-rsi-score-bar .buy-rsi-bonus { width:5%; background:#2563eb; }
        .rebalancing-page .buy-rsi-score-legend { display:flex; flex-wrap:wrap; gap:6px 12px; }
        .rebalancing-page .buy-rsi-score-legend > span { display:inline-flex; gap:4px; align-items:center; color:#475569; font-size:10px; }
        .rebalancing-page .buy-rsi-score-legend b { color:#210a13; font-weight:900; }
        .rebalancing-page .buy-rsi-score-legend i { width:8px; height:8px; display:inline-block; border-radius:2px; }
        .rebalancing-page .buy-rsi-score-legend .buy-rsi-base { background:#861f41; }
        .rebalancing-page .buy-rsi-score-legend .buy-rsi-low { background:#e87722; }
        .rebalancing-page .buy-rsi-score-legend .buy-rsi-bonus { background:#2563eb; }
        .rebalancing-page .buy-rsi-visual-note { margin:0; color:#64748b; font-size:10px; line-height:1.5; }
        /* Scoring Criteria only: improve readability of secondary explanatory text.
           Keep headings, signal colors, layout, and calculation styles unchanged. */
        .rebalancing-page .criteria-collapsible-content .score-criteria-heading > span,
        .rebalancing-page .criteria-collapsible-content .score-criteria-formula span,
        .rebalancing-page .criteria-collapsible-content .criteria-group-heading > span,
        .rebalancing-page .criteria-collapsible-content .criteria-level p > span,
        .rebalancing-page .criteria-collapsible-content .rebalance-budget-note,
        .rebalancing-page .criteria-collapsible-content .buy-rsi-visual-note {
          color:#334155 !important;
        }
        .rebalancing-page .criteria-collapsible-content .score-band-list > span,
        .rebalancing-page .criteria-collapsible-content .buy-rsi-table tbody td,
        .rebalancing-page .criteria-collapsible-content .buy-rsi-score-legend > span {
          color:#334155 !important;
        }

      `}</style>
      {/* Match the actual two-line Portfolio Leaders heading; avoid legacy label-specific line heights. */}
      <style jsx global>{`
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .rebalancing-hero > .target-total,
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .criteria-card {
          box-sizing: border-box !important;
          padding: 12px 18px !important;
          border: 1px solid #e87722 !important;
          border-radius: 16px !important;
          background: #fff !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page .rebalancing-portfolio-heading-copy {
          display: flex !important;
          flex-direction: column !important;
          align-items: flex-start !important;
          gap: 5px !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page .rebalancing-portfolio-heading-copy > span {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          color: #e87722 !important;
          font-size: 10px !important;
          font-weight: 900 !important;
          line-height: 1.35 !important;
          letter-spacing: .12em !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page .rebalancing-portfolio-heading-copy > h2 {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          color: #210a13 !important;
          font-size: 15px !important;
          font-weight: 950 !important;
          line-height: 1.15 !important;
          letter-spacing: -.03em !important;
          text-align: left !important;
        }
        /* Make only the Target Allocation Total label visibly bolder. */
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .rebalancing-hero .target-total .rebalancing-portfolio-heading-copy > span {
          font-size: 10px !important;
          font-weight: 900 !important;
          font-synthesis: weight;
        }
        /* Only the two requested text changes. */
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .rebalancing-hero .target-total .rebalancing-portfolio-heading-copy > h2 {
          color: #861f41 !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .criteria-card .criteria-title.rebalancing-portfolio-heading-copy > h2 {
          font-size: 15px !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .criteria-card > .criteria-toggle-header {
          align-items: center !important;
        }
        .app-shell.app-rebalancing-active > .page-wrap .rebalancing-page > .criteria-card > .criteria-toggle-header > .criteria-toggle-button {
          align-self: center !important;
        }
        /* Mobile trade colors and indicator-condition outlines only. */
        @media (max-width:720px) {
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.buy {
            background:#fff0f2 !important;
            border-color:#ef1b2d !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.buy strong { color:#ef1b2d !important; }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.sell {
            background:#eef5ff !important;
            border-color:#0066ff !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.sell strong { color:#0066ff !important; }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric.metric-matched-buy { border-color:#ef1b2d !important; }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric.metric-matched-sell { border-color:#0066ff !important; }
          /* A dot indicates an applicable signal category, not a triggered condition.
             Red = buy, blue = sell; the colored border remains the trigger state. */
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric .mobile-metric-label {
            display:inline-flex !important; align-items:center; justify-content:center;
            gap:4px; max-width:100%; white-space:nowrap;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-metric-applicability {
            display:inline-flex !important; align-items:center; gap:2px; flex:none;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-metric-applicability i {
            display:block; width:5px; height:5px; flex:0 0 5px;
            border-radius:50%; box-sizing:border-box;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-metric-applicability .metric-dot-buy { background:#ef1b2d; }
          .rebalancing-page .rebalance-mobile-card .mobile-metric-applicability .metric-dot-sell { background:#0066ff; }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.sell {
            background:#eef5ff !important; border:1px solid #0066ff !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.sell strong { color:#0066ff !important; }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.buy {
            background:#fff0f2 !important; border:1px solid #ef1b2d !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-order.buy strong { color:#ef1b2d !important; }
        }
        /* Explicit trade-side state: overrides legacy dashboard styles that inverted buy/sell. */
        @media (max-width:720px) {
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="SELL"] {
            background:#eef5ff !important; border-color:#0066ff !important;
          }
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="SELL"] strong { color:#0066ff !important; }
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="BUY"] {
            background:#fff0f2 !important; border-color:#ef1b2d !important;
          }
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="BUY"] strong { color:#ef1b2d !important; }
        }
        /* Mobile: all six indicator boxes on one row. */
        @media (max-width:720px) {
          .rebalancing-page .rebalance-mobile-card .mobile-card-metrics,
          .rebalancing-page .rebalance-mobile-card .mobile-card-metrics:has(.mobile-card-metric:nth-child(6)) {
            display:grid !important;
            grid-template-columns:repeat(6,minmax(0,1fr)) !important;
            gap:3px !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric {
            position:relative !important;
            min-width:0 !important;
            padding:5px 8px 5px 2px !important;
            gap:3px !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric .mobile-metric-label {
            font-size:8px !important;
            line-height:1.2 !important;
            white-space:normal !important;
            overflow-wrap:anywhere !important;
            word-break:keep-all !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric > b {
            font-size:9px !important;
            line-height:1.15 !important;
            white-space:nowrap !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric .mobile-metric-label {
            display:block !important;
            max-width:100% !important;
            text-align:center !important;
          }
          .rebalancing-page .rebalance-mobile-card .mobile-card-metric .mobile-metric-applicability {
            position:absolute !important;
            right:2px !important;
            top:50% !important;
            transform:translateY(-50%) !important;
            display:flex !important;
            flex-direction:column !important;
            align-items:center !important;
            gap:3px !important;
          }
          /* A held order has neutral colors even when the underlying side is BUY/SELL. */
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="HOLD"] {
            background:#f3f4f6 !important;
            border:1px solid #cbd5e1 !important;
          }
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-action .mobile-card-order[data-trade-side="HOLD"] strong {
            color:#475569 !important;
          }
        }
      `}</style>
      {/* Override the legacy 9px !important mobile input rules at the final,
          highest-specificity layer. iOS Safari focus zoom is triggered by the
          computed font-size of the actual focused input, not by its mirror. */}
      <style jsx global>{`
        @media (max-width:720px) {
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-target-input input,
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-table-card .rebalance-target-cell .target-input input {
            font-size:16px !important;
            -webkit-text-size-adjust:100% !important;
            text-size-adjust:100% !important;
            transform:none !important;
            color:transparent !important;
            -webkit-text-fill-color:transparent !important;
            caret-color:#0f172a !important;
          }
          /* Preserve the original 9px/10px apparent numeric size. */
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-mobile-list .rebalance-mobile-card .mobile-card-target-input .target-value-mirror {
            font-size:10px !important;
          }
          .app-shell.app-rebalancing-active .rebalancing-page .rebalance-table-card .rebalance-target-cell .target-input .target-value-mirror {
            font-size:9px !important;
          }
        }
      `}</style>
    </section>
  );
}
