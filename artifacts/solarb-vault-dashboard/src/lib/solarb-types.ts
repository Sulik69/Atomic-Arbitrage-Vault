export type VaultMetrics = {
  principalUsdc: number;
  yieldUsdc: number;
  apyPercent: number;
  walletUsdc: number;
  vaultTvlUsdc: number;
};

export type Opportunity = {
  id: string;
  pair: string;
  orcaPrice: number;
  raydiumPrice: number;
  netSpreadPercent: number;
  status: "Monitoring" | "Executing" | "Captured";
};

export type RecentTrade = {
  id: string;
  pair: string;
  profitUsdc: number;
  timestamp: string;
  signature?: string;
  source: "demo" | "chain";
};

export type VaultActionState = {
  status: "idle" | "simulating" | "executing" | "success" | "error";
  message?: string;
};
