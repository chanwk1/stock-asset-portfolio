"use client";

import { useEffect, useRef, useState } from "react";

type StartTab = "portfolio" | "rebalancing" | "market-map";
type DisplayCurrency = "USD" | "KRW";
type Density = "comfortable" | "compact";
type RefreshInterval = 15 | 30 | 60 | 300;

type AppSettings = {
  startTab: StartTab;
  displayCurrency: DisplayCurrency;
  density: Density;
  refreshInterval: RefreshInterval;
  showLogos: boolean;
};

const SETTINGS_KEY = "stock-portfolio-app-settings-v1";
const PORTFOLIO_KEYS = [
  "stock-portfolio-data-v1",
  "stock-portfolio-target-allocations-v1",
  "stock-portfolio-app-settings-v1",
];

const DEFAULT_SETTINGS: AppSettings = {
  startTab: "portfolio",
  displayCurrency: "USD",
  density: "comfortable",
  refreshInterval: 60,
  showLogos: true,
};

function readSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function SettingsTab({
  holdingsCount,
  onNavigate,
}: {
  holdingsCount: number;
  onNavigate: (tab: StartTab) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSettings(readSettings());

    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const saveSettings = () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new Event("stock-portfolio-settings-changed"));
    document.documentElement.dataset.density = settings.density;
    setSaved(true);
    setMessage("설정이 이 기기에 저장되었습니다.");
    window.setTimeout(() => setMessage(""), 2500);
  };

  const exportData = () => {
    const payload = {
      app: "Stock Asset Portfolio",
      version: 1,
      exportedAt: new Date().toISOString(),
      localStorage: Object.fromEntries(
        Object.keys(window.localStorage).map((key) => [
          key,
          window.localStorage.getItem(key),
        ]),
      ),
    };

    downloadJson(
      payload,
      `stock-asset-portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    setMessage("백업 파일을 내보냈습니다.");
  };

  const importData = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as {
        localStorage?: Record<string, string | null>;
      };

      if (!payload.localStorage || typeof payload.localStorage !== "object") {
        throw new Error("Invalid backup");
      }

      for (const [key, value] of Object.entries(payload.localStorage)) {
        if (typeof value === "string") {
          window.localStorage.setItem(key, value);
        }
      }

      setSettings(readSettings());
      setMessage("백업 데이터를 복원했습니다. 페이지를 새로고침합니다.");
      window.setTimeout(() => window.location.reload(), 1000);
    } catch {
      setMessage("올바른 백업 파일이 아닙니다.");
    }
  };

  const resetSettings = () => {
    window.localStorage.removeItem(SETTINGS_KEY);
    setSettings(DEFAULT_SETTINGS);
    document.documentElement.dataset.density = DEFAULT_SETTINGS.density;
    setSaved(false);
    setMessage("앱 설정을 기본값으로 되돌렸습니다.");
  };

  const resetAllData = () => {
    const confirmed = window.confirm(
      "포트폴리오, 목표 비중, 앱 설정을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.",
    );
    if (!confirmed) return;

    PORTFOLIO_KEYS.forEach((key) => window.localStorage.removeItem(key));
    setMessage("모든 로컬 데이터를 삭제했습니다.");
    window.setTimeout(() => window.location.reload(), 900);
  };

  const installApp = async () => {
    if (installPrompt?.prompt) {
      await installPrompt.prompt();
      setInstallPrompt(null);
      return;
    }

    setMessage(
      "브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택하세요.",
    );
  };

  return (
    <section className="settings-page">
      <section className="hero settings-hero">
        <div>
          <span>APPLICATION SETTINGS</span>
          <div className="settings-title-lines">
            <h1>Settings & Data</h1>
            <h1 className="settings-title-reference" aria-hidden="true">Allocation Intelligence Map</h1>
          </div>
          <p>
            앱의 기본 동작과 표시 방식을 설정하고, 포트폴리오 데이터를
            백업하거나 다른 기기로 옮길 수 있습니다.
          </p>
        </div>
      </section>

      {message && <div className="settings-toast">{message}</div>}

      <section className="settings-grid">
        <article className="settings-card card settings-general-card">
          <div className="settings-card-heading">
            <span>GENERAL</span>
            <h2>기본 환경</h2>
          </div>

          <label className="settings-row">
            <div>
              <strong>시작 화면</strong>
              <span>앱을 열었을 때 먼저 표시할 탭</span>
            </div>
            <select
              value={settings.startTab}
              onChange={(event) =>
                updateSetting("startTab", event.target.value as StartTab)
              }
            >
              <option value="portfolio">Portfolio</option>
              <option value="rebalancing">Rebalancing</option>
              <option value="market-map">Market Map</option>
            </select>
          </label>

          <label className="settings-row">
            <div>
              <strong>표시 통화</strong>
              <span>포트폴리오 금액의 기본 표시 단위</span>
            </div>
            <select
              value={settings.displayCurrency}
              onChange={(event) =>
                updateSetting(
                  "displayCurrency",
                  event.target.value as DisplayCurrency,
                )
              }
            >
              <option value="USD">USD ($)</option>
              <option value="KRW">KRW (₩)</option>
            </select>
          </label>

          <label className="settings-row">
            <div>
              <strong>데이터 새로고침</strong>
              <span>시장 데이터를 다시 요청하는 주기</span>
            </div>
            <select
              value={settings.refreshInterval}
              onChange={(event) =>
                updateSetting(
                  "refreshInterval",
                  Number(event.target.value) as RefreshInterval,
                )
              }
            >
              <option value={15}>15초</option>
              <option value={30}>30초</option>
              <option value={60}>1분</option>
              <option value={300}>5분</option>
            </select>
          </label>

          <label className="settings-row">
            <div>
              <strong>화면 밀도</strong>
              <span>종목이 많은 화면의 세로 간격</span>
            </div>
            <select
              value={settings.density}
              onChange={(event) =>
                updateSetting("density", event.target.value as Density)
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>

          <div className="settings-switch-row">
            <div>
              <strong>기업 로고 표시</strong>
              <span>포트폴리오의 Top Holdings와 Holdings에서 기업 로고 표시</span>
            </div>
            <button
              className={`settings-switch ${settings.showLogos ? "on" : ""}`}
              onClick={() => updateSetting("showLogos", !settings.showLogos)}
              aria-label="기업 로고 표시 전환"
            >
              <i />
            </button>
          </div>

          <div className="settings-actions">
            <button className="settings-secondary" onClick={resetSettings}>
              기본값 복원
            </button>
            <button className="settings-primary" onClick={saveSettings}>
              {saved ? "저장됨" : "설정 저장"}
            </button>
          </div>
        </article>

        <article className="settings-card card">
          <div className="settings-card-heading">
            <span>DATA MANAGEMENT</span>
            <h2>백업 및 복원</h2>
          </div>

          <div className="settings-feature">
            <div className="settings-feature-icon">↓</div>
            <div>
              <strong>전체 데이터 내보내기</strong>
              <p>
                현재 브라우저에 저장된 포트폴리오와 목표 비중, 설정을 하나의
                JSON 파일로 저장합니다.
              </p>
              <button onClick={exportData}>백업 파일 다운로드</button>
            </div>
          </div>

          <div className="settings-feature">
            <div className="settings-feature-icon">↑</div>
            <div>
              <strong>백업 데이터 불러오기</strong>
              <p>
                다른 컴퓨터나 휴대전화에서 이전에 내보낸 백업 파일을
                불러옵니다.
              </p>
              <button onClick={() => fileInputRef.current?.click()}>
                백업 파일 선택
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importData(file);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          <div className="settings-feature">
            <div className="settings-feature-icon">⌂</div>
            <div>
              <strong>앱으로 설치</strong>
              <p>
                지원되는 브라우저에서는 웹사이트를 독립 실행 앱처럼 설치할 수
                있습니다.
              </p>
              <button onClick={installApp}>이 기기에 설치</button>
            </div>
          </div>
        </article>

        <article className="settings-card card settings-full-card danger-card">
          <div className="settings-card-heading">
            <span>DANGER ZONE</span>
            <h2>데이터 초기화</h2>
          </div>
          <div className="danger-row">
            <div>
              <strong>모든 로컬 데이터 삭제</strong>
              <p>
                이 브라우저에 저장된 포트폴리오, 목표 비중, 앱 설정을 모두
                삭제합니다. 먼저 백업 파일을 내려받는 것이 좋습니다.
              </p>
            </div>
            <button onClick={resetAllData}>전체 데이터 삭제</button>
          </div>
        </article>
      </section>

      <style jsx global>{`
        .settings-page { display:flex; flex-direction:column; gap:18px; padding-bottom:30px; }
        .settings-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:28px; padding:22px 20px 12px; border:0; border-radius:0; background:transparent; box-shadow:none; }
        .settings-overview { padding:14px; border:1px solid #e4e9f2; background:#fff; box-shadow:0 12px 34px rgba(30,64,175,.045); }
        .settings-hero > div:first-child { max-width:660px; }
        .settings-hero > div:first-child > span,.settings-card-heading > span { color:#4263eb; font-size:11px; font-weight:900; letter-spacing:.16em; }
        .settings-hero > div:first-child > span:first-child { font-weight:800; }
        .settings-hero h1 { margin:7px 0 8px; color:#111827; font-size:32px; letter-spacing:-.045em; }
        .settings-hero p { margin:0; color:#475569; font-size:14px; line-height:1.65; }
        .settings-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; min-width:0; }
        .settings-summary > div { padding:14px 15px; border:1px solid rgba(148,163,184,.22); border-radius:15px; background:rgba(255,255,255,.82); }
        .settings-summary span { display:block; color:#8a96a9; font-size:9px; font-weight:850; text-transform:uppercase; }
        .settings-summary strong { display:block; margin-top:6px; color:#1f2a3d; font-size:17px; }
        .settings-toast { position:sticky; top:76px; z-index:40; align-self:center; padding:10px 16px; border-radius:12px; background:#182235; color:#fff; font-size:11px; font-weight:800; box-shadow:0 12px 28px rgba(15,23,42,.2); }
        .settings-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
        .settings-card { overflow:hidden; padding:22px; border:1px solid #e4e9f2; background:#fff; box-shadow:0 12px 34px rgba(30,64,175,.045); }
        .settings-full-card { grid-column:1/-1; }
        .settings-card-heading { margin-bottom:16px; }
        .settings-card-heading h2 { margin:5px 0 0; color:#182235; font-size:20px; letter-spacing:-.025em; }
        .settings-row,.settings-switch-row { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:15px 0; border-bottom:1px solid #edf0f5; }
        .settings-row > div,.settings-switch-row > div { min-width:0; }
        .settings-row strong,.settings-switch-row strong { display:block; color:#263249; font-size:12px; }
        .settings-row span,.settings-switch-row span { display:block; margin-top:4px; color:#475569; font-size:10px; line-height:1.45; }
        .settings-row select { width:158px; padding:9px 11px; border:1px solid #dce3ed; border-radius:11px; background:#f8fafc; color:#344157; font-size:11px; font-weight:750; outline:none; }
        .settings-switch { position:relative; width:44px; height:25px; flex:0 0 auto; border:0; border-radius:99px; background:#cbd3df; cursor:pointer; transition:.2s ease; }
        .settings-switch i { position:absolute; left:3px; top:3px; width:19px; height:19px; border-radius:50%; background:#fff; box-shadow:0 2px 7px rgba(15,23,42,.2); transition:.2s ease; }
        .settings-switch.on { background:#4169e1; }
        .settings-switch.on i { transform:translateX(19px); }
        .settings-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:18px; }
        .settings-actions button,.settings-feature button,.danger-row button { border:0; border-radius:11px; font-size:10px; font-weight:900; cursor:pointer; }
        .settings-primary { padding:10px 16px; background:#4169e1; color:#fff; box-shadow:0 9px 20px rgba(65,105,225,.22); }
        .settings-secondary { padding:10px 14px; background:#eef2f8; color:#66748a; }
        .settings-feature { display:grid; grid-template-columns:42px 1fr; gap:13px; padding:16px 0; border-bottom:1px solid #edf0f5; }
        .settings-feature:last-child { border-bottom:0; }
        .settings-feature-icon { display:flex; align-items:center; justify-content:center; width:42px; height:42px; border-radius:13px; background:#edf3ff; color:#4169e1; font-size:20px; font-weight:500; }
        .settings-feature strong { color:#253148; font-size:12px; }
        .settings-feature p { margin:5px 0 10px; color:#475569; font-size:10px; line-height:1.55; }
        .settings-feature button { padding:8px 11px; background:#eef3ff; color:#4169e1; }
        .settings-shortcuts { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
        .settings-shortcuts button { position:relative; overflow:hidden; min-height:120px; padding:18px; border:1px solid #e3e8f1; border-radius:17px; background:linear-gradient(145deg,#fff,#f7f9fd); text-align:left; cursor:pointer; transition:.18s ease; }
        .settings-shortcuts button:hover { transform:translateY(-2px); border-color:#b9c9f8; box-shadow:0 12px 28px rgba(65,105,225,.09); }
        .settings-shortcuts span { display:block; color:#9aa8bd; font-size:10px; font-weight:900; }
        .settings-shortcuts strong { display:block; margin-top:15px; color:#1f2b42; font-size:17px; }
        .settings-shortcuts small { display:block; margin-top:5px; color:#8a96a8; font-size:10px; }
        .danger-card { border-color:#f1d6d6; }
        .danger-card .settings-card-heading > span { color:#d14343; }
        .danger-row { display:flex; align-items:center; justify-content:space-between; gap:24px; }
        .danger-row strong { color:#522a2a; font-size:12px; }
        .danger-row p { max-width:720px; margin:5px 0 0; color:#6b3a44; font-size:10px; line-height:1.55; }
        .danger-row button { flex:0 0 auto; padding:10px 14px; background:#fff0f0; color:#c93c3c; }
        html[data-density="compact"] .holding-card,
        html[data-density="compact"] .rebalance-row { padding-top:12px!important; padding-bottom:12px!important; }
        @media (max-width:900px) {
          .settings-grid { grid-template-columns:1fr; }
          .settings-full-card { grid-column:auto; }
          .settings-hero { align-items:flex-start; flex-direction:column; }
          .settings-summary { width:100%; min-width:0; }
        }
        @media (max-width:640px) {
          .settings-hero { padding:18px 10px 10px; border-radius:0; }
          .settings-overview { padding:10px; }
          .settings-hero h1 { font-size:25px; }
          .settings-summary { grid-template-columns:repeat(3,1fr); gap:6px; }
          .settings-summary > div { padding:10px 8px; }
          .settings-summary strong { font-size:13px; }
          .settings-card { padding:17px; }
          .settings-row { align-items:flex-start; flex-direction:column; gap:9px; }
          .settings-row select { width:100%; }
          .settings-shortcuts { grid-template-columns:1fr; }
          .settings-shortcuts button { min-height:95px; }
          .danger-row { align-items:flex-start; flex-direction:column; }
        }
        /* Match the Market Map title container; no ad-hoc negative margins. */
        .app-shell.app-settings-active .settings-page > .hero.settings-hero {
          box-sizing:border-box !important;
          width:100% !important;
          margin:0 !important;
          padding:0 8px !important;
          border:0 !important;
          border-radius:0 !important;
          background:transparent !important;
          box-shadow:none !important;
        }
        .app-shell.app-settings-active .settings-page > .hero.settings-hero > div:first-child {
          margin:0 !important;
          padding:0 !important;
          text-align:left !important;
        }
        .app-shell.app-settings-active .settings-page > .hero.settings-hero > div:first-child > span:first-child {
          display:block !important;
          margin:0 !important;
          padding:0 !important;
          color:#2563eb !important;
          line-height:1.2 !important;
        }
        .app-shell.app-settings-active .settings-page > .hero.settings-hero h1 {
          display:block !important;
          margin:4px 0 0 !important;
          padding:0 !important;
          color:#4b1026 !important;
          text-align:left !important;
        }
        .app-shell.app-settings-active .settings-page > .settings-overview,
        .app-shell.app-settings-active .settings-page .settings-grid > .settings-card {
          border:1px solid #e87722 !important;
        }
        @media (max-width:760px) {
          .app-shell.app-settings-active .settings-page {
            width:100% !important;
            margin:0 !important;
            padding-left:0 !important;
            padding-right:0 !important;
            row-gap:7px !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero {
            height:auto !important;
            min-height:0 !important;
            padding-top:0 !important;
            padding-bottom:0 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero h1 {
            font-size:30px !important;
            line-height:1.08 !important;
            letter-spacing:-.045em !important;
          }
        }
        /* Reference parity: the same content box as Market Map, without
           component-specific horizontal insets or intrinsic flex shrinkage. */
        .app-shell.app-settings-active > .page-wrap.settings-page-wrap {
          box-sizing:border-box !important;
        }
        .app-shell.app-settings-active > .page-wrap.settings-page-wrap > .settings-page {
          display:flex !important;
          flex-direction:column !important;
          align-items:stretch !important;
          box-sizing:border-box !important;
          width:100% !important;
          max-width:100% !important;
          min-width:0 !important;
          margin:0 !important;
          padding-left:0 !important;
          padding-right:0 !important;
        }
        .app-shell.app-settings-active .settings-page > .settings-overview,
        .app-shell.app-settings-active .settings-page > .settings-grid {
          box-sizing:border-box !important;
          width:100% !important;
          max-width:100% !important;
          min-width:0 !important;
          flex:0 0 auto !important;
          margin-left:0 !important;
          margin-right:0 !important;
        }
        @media (max-width:760px) {
          /* Match the final Market Map heading override: eyebrow metrics,
             two-line title sizing and 7px section gap. */
          .app-shell.app-settings-active > .page-wrap.settings-page-wrap {
            padding-top:7px !important;
            padding-left:12px !important;
            padding-right:12px !important;
          }
          .app-shell.app-settings-active .settings-page { gap:7px !important; }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero {
            display:block !important;
            width:100% !important;
            min-height:0 !important;
            margin:0 !important;
            padding:0 8px !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero > div:first-child {
            width:100% !important;
            max-width:680px !important;
            margin:0 !important;
            padding:0 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero > div:first-child > span:first-child {
            display:block !important;
            margin:0 !important;
            padding:0 !important;
            color:#2563eb !important;
            font-size:10px !important;
            font-weight:800 !important;
            letter-spacing:.12em !important;
            line-height:1.2 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero h1 {
            display:block !important;
            margin:4px 0 0 !important;
            padding:0 !important;
            font-size:30px !important;
            line-height:1.08 !important;
            color:#4b1026 !important;
          }
          .app-shell.app-settings-active .settings-page > .hero.settings-hero + .settings-overview {
            margin-top:0 !important;
          }
        }
        /* Match Market Map's actual heading height at every viewport width.
           The visually hidden reference wraps exactly like the Market Map title,
           rather than reserving two lines arbitrarily at a fixed breakpoint. */
        .app-shell.app-settings-active .settings-title-lines {
          display:grid !important;
          grid-template-columns:minmax(0,1fr) !important;
          align-items:start !important;
          min-width:0 !important;
        }
        .app-shell.app-settings-active .settings-title-lines > h1 {
          grid-area:1 / 1 !important;
          min-height:0 !important;
          font-size:inherit;
        }
        .app-shell.app-settings-active .settings-title-lines > .settings-title-reference {
          visibility:hidden !important;
          pointer-events:none !important;
          height:auto !important;
        }
        /* Match the Market Map All Categories card: its heading begins 8px below
           the card's top edge. Do not alter horizontal padding or card geometry. */
        .app-shell.app-settings-active .settings-grid > .settings-card.card {
          padding-top:8px !important;
        }
        /* With the overview removed, the General card occupies its full-width first-row slot. */
        .app-shell.app-settings-active .settings-grid > .settings-general-card {
          grid-column:1 / -1;
          width:100%;
          min-width:0;
          box-sizing:border-box;
        }
        /* Compact only the General Settings card. Keep every other layout untouched. */
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child > .settings-card-heading {
          margin-bottom:9px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row,
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-switch-row {
          gap:8px !important;
          padding-top:9px !important;
          padding-bottom:9px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row select {
          width:128px !important;
          min-width:0 !important;
          height:34px !important;
          padding:4px 8px !important;
          font-size:11px !important;
          line-height:1.2 !important;
          flex:0 0 auto !important;
          box-sizing:border-box !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row span,
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-switch-row span {
          margin-top:2px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-actions {
          padding-top:10px !important;
        }
        /* Compact only Backup & Restore and Data Reset content.
           Preserve the card's 8px top inset and existing exterior geometry. */
        .app-shell.app-settings-active .settings-grid > .settings-card:nth-child(2) > .settings-card-heading,
        .app-shell.app-settings-active .settings-grid > .danger-card > .settings-card-heading {
          margin-bottom:8px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:nth-child(2) .settings-feature {
          grid-template-columns:36px minmax(0,1fr) !important;
          gap:9px !important;
          padding-top:9px !important;
          padding-bottom:9px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:nth-child(2) .settings-feature-icon {
          width:36px !important;
          height:36px !important;
        }
        .app-shell.app-settings-active .settings-grid > .settings-card:nth-child(2) .settings-feature p {
          margin-top:3px !important;
          margin-bottom:6px !important;
          line-height:1.4 !important;
        }
        .app-shell.app-settings-active .settings-grid > .danger-card .danger-row {
          gap:10px !important;
        }
        .app-shell.app-settings-active .settings-grid > .danger-card .danger-row p {
          margin-top:3px !important;
          line-height:1.4 !important;
        }
        @media (max-width:640px) {
          .app-shell.app-settings-active .settings-grid > .danger-card .danger-row {
            gap:8px !important;
          }
        }
        @media (max-width:640px) {
          /* Replace the old full-width stacked selects with compact right-side controls. */
          .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row {
            display:grid !important;
            grid-template-columns:minmax(0,1fr) 112px !important;
            align-items:center !important;
            column-gap:8px !important;
          }
          .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row > div {
            min-width:0 !important;
          }
          .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-row select {
            width:112px !important;
            max-width:112px !important;
            height:32px !important;
            padding:3px 6px !important;
            justify-self:end !important;
          }
          .app-shell.app-settings-active .settings-grid > .settings-card:first-child .settings-switch-row {
            align-items:center !important;
          }
        }
      `}</style>
    </section>
  );
}
