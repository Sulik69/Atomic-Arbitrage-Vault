"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

export function useDevnetStatus() {
  const { connection } = useConnection();
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");
  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const ping = async () => {
      const started = performance.now();
      try {
        await connection.getLatestBlockhash("confirmed");
        if (active) {
          setLatency(Math.round(performance.now() - started));
          setStatus("online");
        }
      } catch {
        if (active) {
          setLatency(null);
          setStatus("offline");
        }
      }
    };
    void ping();
    const timer = window.setInterval(ping, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connection]);
  return { status, latency };
}
