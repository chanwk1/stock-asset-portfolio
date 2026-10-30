import type { PortfolioHolding } from "../data/portfolio-data";
import { getSupabaseBrowserClient } from "../lib/supabase";

type PortfolioRow = { user_id: string; holdings: PortfolioHolding[] | null; updated_at: string };

export async function loadCloudPortfolio(userId: string): Promise<PortfolioHolding[] | null> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("portfolios")
    .select("user_id, holdings, updated_at")
    .eq("user_id", userId)
    .maybeSingle<PortfolioRow>();
  if (error) throw error;
  return Array.isArray(data?.holdings) ? data.holdings : null;
}

export async function saveCloudPortfolio(userId: string, holdings: PortfolioHolding[]) {
  const { error } = await getSupabaseBrowserClient().from("portfolios").upsert(
    { user_id: userId, holdings, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}
