import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The 16:00 New York close is 20:00 UTC in EDT and 21:00 UTC in EST.
function nyCloseInstant(session: string): number {
  const date = new Date(`${session}T20:00:00.000Z`);
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
  }).format(date));
  return Date.parse(`${session}T${hour === 16 ? "20" : "21"}:00:00.000Z`) / 1000;
}

let cached = new Map<string, number>();
export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session") ?? "";
  if (!/^20\d\d-\d\d-\d\d$/.test(session) || !Number.isFinite(Date.parse(session))) {
    return NextResponse.json({ error: "Invalid NY market session" }, { status: 400 });
  }
  const target = nyCloseInstant(session);
  if (target > Date.now() / 1000) return NextResponse.json({ error: "Session not closed" }, { status: 400 });
  if (cached.has(session)) return NextResponse.json({ session, rate: cached.get(session) }, { headers: { "Cache-Control": "no-store" } });
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      // Hourly historical USD/KRW FX samples, with the NY-close hour as the anchor.
      const url = `https://${host}/v8/finance/chart/USDKRW%3DX?period1=${target - 2 * 86400}&period2=${target + 86400}&interval=60m`;
      const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4500) });
      if (!res.ok) continue;
      const json = await res.json();
      const series = json?.chart?.result?.[0];
      const times: number[] = series?.timestamp ?? [];
      const closes: Array<number | null> = series?.indicators?.quote?.[0]?.close ?? [];
      // Use the closest preceding recorded quote, never a live/current FX rate.
      const samples = times.map((t,i) => ({ t, v: closes[i] })).filter(x => x.t <= target && x.t >= target - 7200 && typeof x.v === "number" && Number.isFinite(x.v) && x.v > 0).sort((a,b) => b.t - a.t);
      if (!samples.length) continue;
      const rate = Number(samples[0].v);
      cached.set(session, rate);
      return NextResponse.json({ session, rate, sampleTime: samples[0].t, note: "Last available FX observation before NY close" }, { headers: { "Cache-Control": "no-store" } });
    } catch { /* Try another host. */ }
  }
  return NextResponse.json({ error: "Historical closing FX unavailable; reference value not estimated" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
