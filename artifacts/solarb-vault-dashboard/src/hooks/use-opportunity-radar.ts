"use client";

import type { Opportunity } from "@/lib/solarb-types";

const demoOpportunities: Opportunity[] = [
  { id: "sol-usdc", pair: "SOL / USDC", orcaPrice: 146.328, raydiumPrice: 147.012, netSpreadPercent: 0.417, status: "Monitoring" },
  { id: "jup-usdc", pair: "JUP / USDC", orcaPrice: 0.8231, raydiumPrice: 0.8252, netSpreadPercent: 0.184, status: "Monitoring" },
  { id: "ray-usdc", pair: "RAY / USDC", orcaPrice: 1.042, raydiumPrice: 1.049, netSpreadPercent: 0.332, status: "Captured" },
];

export function useOpportunityRadar() {
  return { data: demoOpportunities, isLoading: false, source: "DEMO" as const };
}
