"use client";

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import type { VaultMetrics } from "@/lib/solarb-types";

const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const demoMetrics: VaultMetrics = {
  principalUsdc: 12842.76,
  yieldUsdc: 184.29,
  apyPercent: 8.74,
  walletUsdc: 2468.12,
  vaultTvlUsdc: 84219.63,
};

export function useVaultMetrics() {
  const { connection } = useConnection();
  const { connected, publicKey } = useWallet();
  const [liveWalletUsdc, setLiveWalletUsdc] = useState<number | null>(null);
  const [walletBalanceError, setWalletBalanceError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!connected || !publicKey) {
      setLiveWalletUsdc(null);
      setWalletBalanceError(false);
      return () => { cancelled = true; };
    }

    setLiveWalletUsdc(null);
    setWalletBalanceError(false);
    let requestInFlight = false;
    const refreshBalance = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const { value } = await connection.getParsedTokenAccountsByOwner(
          publicKey,
          { programId: TOKEN_PROGRAM_ID },
          "confirmed",
        );
        const total = value.reduce((sum, { account }) => {
          const parsed = account.data.parsed as {
            info?: {
              mint?: string;
              tokenAmount?: { uiAmountString?: string };
            };
          };
          const info = parsed.info;
          if (info?.mint !== DEVNET_USDC_MINT.toBase58()) return sum;
          const amount = Number(info.tokenAmount?.uiAmountString ?? "0");
          return Number.isFinite(amount) ? sum + amount : sum;
        }, 0);
        if (!cancelled) {
          setLiveWalletUsdc(total);
          setWalletBalanceError(false);
        }
      } catch {
        if (!cancelled) setWalletBalanceError(true);
      } finally {
        requestInFlight = false;
      }
    };

    void refreshBalance();
    const timer = window.setInterval(() => { void refreshBalance(); }, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connected, connection, publicKey]);

  const walletUsdc = connected
    ? liveWalletUsdc ?? 0
    : demoMetrics.walletUsdc;
  return {
    data: { ...demoMetrics, walletUsdc },
    isLoading: false,
    source: "DEMO" as const,
    walletBalanceSource: connected ? "DEVNET" as const : "DEMO" as const,
    walletBalanceLoading: connected && liveWalletUsdc === null && !walletBalanceError,
    walletBalanceError,
  };
}
