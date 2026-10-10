"use client";

import type { RecentTrade } from "@/lib/solarb-types";

const demoTrades: RecentTrade[] = [
  { id: "trade-01", pair: "SOL / USDC", profitUsdc: 2.847, timestamp: "2m ago", source: "demo" },
  { id: "trade-02", pair: "JUP / USDC", profitUsdc: 0.614, timestamp: "8m ago", source: "demo" },
  { id: "trade-03", pair: "SOL / USDC", profitUsdc: 1.203, timestamp: "19m ago", source: "demo" },
];

export function useRecentTransactions() {
  return { data: demoTrades, isLoading: false, source: "DEMO" as const };
}
