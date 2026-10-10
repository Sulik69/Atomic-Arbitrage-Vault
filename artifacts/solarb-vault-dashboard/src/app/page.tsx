"use client";

import { useState } from "react";
import { Activity, ArrowDownToLine, ArrowUpRight, Check, CircleHelp, Clock3, Coins, ExternalLink, Layers3, LockKeyhole, RefreshCw, ShieldCheck, TriangleAlert, Wallet, Zap } from "lucide-react";
import { getHealthCheckQueryKey, useHealthCheck } from "@workspace/api-client-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useVaultMetrics } from "@/hooks/use-vault-metrics";
import { useOpportunityRadar } from "@/hooks/use-opportunity-radar";
import { useRecentTransactions } from "@/hooks/use-recent-transactions";
import { useDevnetStatus } from "@/hooks/use-devnet-status";
import type { VaultActionState } from "@/lib/solarb-types";

function money(value: number, digits = 2) {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function DashboardPage() {
  const metrics = useVaultMetrics();
  const opportunities = useOpportunityRadar();
  const trades = useRecentTransactions();
  const devnet = useDevnetStatus();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const wallet = useWallet();
  const [amount, setAmount] = useState("");
  const [amountBasis, setAmountBasis] = useState<"deposit" | "withdraw">("deposit");
  const [action, setAction] = useState<VaultActionState>({ status: "idle" });

  const amountLimit = amountBasis === "deposit"
    ? metrics.data.walletUsdc
    : metrics.data.principalUsdc + metrics.data.yieldUsdc;
  const setPercent = (percent: number) => setAmount((amountLimit * percent).toFixed(2));
  const previewAction = (kind: "deposit" | "withdraw") => {
    if (action.status === "simulating" || action.status === "executing") return;
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setAction({ status: "error", message: "Enter a USDC amount greater than zero to preview this action." });
      return;
    }
    const available = kind === "deposit"
      ? metrics.data.walletUsdc
      : metrics.data.principalUsdc + metrics.data.yieldUsdc;
    if (parsedAmount > available + 0.000001) {
      setAction({
        status: "error",
        message: `The preview amount exceeds the ${kind === "deposit" ? "available wallet USDC" : "displayed vault position"}.`,
      });
      return;
    }
    setAction({ status: "simulating", message: `${kind === "deposit" ? "Deposit" : "Withdrawal"} preview: checking local inputs…` });
    window.setTimeout(() => {
      setAction({ status: "executing", message: "Preview sequence running locally. No wallet signature requested." });
      window.setTimeout(() => {
        setAction({
          status: "success",
          message: `${kind === "deposit" ? "Deposit" : "Withdrawal"} preview complete — preview only; no transaction sent and no funds moved.`,
        });
      }, 900);
    }, 700);
  };

  const healthStatus = health.isPending ? "Checking API" : health.isError ? "API unavailable" : `API ${health.data?.status ?? "healthy"}`;

  return (
    <div className="app-shell min-h-screen">
      <header className="topbar">
        <div className="brand" aria-label="SolArb Zero-Loss Flash Vault">
          <div className="brand-mark"><Activity size={18} strokeWidth={2.6} /></div>
          <div><div className="brand-name">SolArb</div><div className="brand-sub">Zero-Loss Flash Vault</div></div>
        </div>
        <div className="topbar-right">
          <span className="network-pill" data-testid="status-network">
            <Layers3 size={13} />
            <i className={`health-dot ${devnet.status === "offline" ? "off" : devnet.status === "checking" ? "checking" : ""}`} aria-label={`Devnet RPC ${devnet.status}`} />
            SOLANA DEVNET
          </span>
          <span className="health-pill" data-testid="status-api-health"><i className={`health-dot ${health.isError ? "off" : ""}`} />{healthStatus}</span>
          <span className="demo-pill" data-testid="badge-demo">DEMO DATA</span>
          <WalletMultiButton aria-label={wallet.connected ? "Connected wallet menu" : "Connect Phantom or Solflare wallet"} />
        </div>
      </header>

      <main className="main">
        <div className="page-heading fade-up">
          <div>
            <div className="eyebrow">CONTROL ROOM / DEVNET</div>
            <h1>Vault overview</h1>
            <p className="page-desc">Transparent monitoring. Atomic execution architecture. No custody.</p>
          </div>
          <div className="heading-meta">
            <div className="rpc-status" data-testid="status-devnet-rpc">
              {devnet.status === "online" ? <span className="live-dot" /> : devnet.status === "offline" ? <TriangleAlert size={13} className="health-error" /> : <RefreshCw size={13} />}
              <span>{devnet.status === "online" ? "RPC LIVE" : devnet.status === "offline" ? "RPC OFFLINE" : "PINGING RPC"}</span>
              {devnet.latency !== null && <span className="rpc-latency">{devnet.latency} ms</span>}
            </div>
          </div>
        </div>

        <div className="overview-grid fade-up">
          <section className="panel vault-panel" aria-labelledby="vault-metrics-title">
            <div className="section-top">
              <h2 className="section-title" id="vault-metrics-title"><ShieldCheck size={15} /> Vault performance</h2>
              <span className="small-label">LOCAL SAMPLE · DEMO</span>
            </div>
            <div className="vault-metrics">
              <div className="metric">
                <div className="metric-label">Your deposited principal <CircleHelp size={11} aria-label="Mock principal value, not on-chain" /></div>
                <div className="metric-value" data-testid="metric-principal">${money(metrics.data.principalUsdc)}<span className="metric-unit"> USDC</span></div>
                <div className="metric-foot">Demo vault balance</div>
              </div>
              <div className="metric">
                <div className="metric-label">Accumulated yield</div>
                <div className="metric-value positive" data-testid="metric-yield">+${money(metrics.data.yieldUsdc)}<span className="metric-unit"> USDC</span></div>
                <div className="metric-foot">Illustrative, not realized</div>
              </div>
              <div className="metric">
                <div className="metric-label">Dynamic APY</div>
                <div className="metric-value positive" data-testid="metric-apy">{metrics.data.apyPercent.toFixed(2)}<span className="metric-unit">%</span></div>
                <div className="metric-foot">Indicative demo estimate</div>
              </div>
            </div>
            <div className="vault-foot"><span>Vault TVL <strong data-testid="metric-tvl">${money(metrics.data.vaultTvlUsdc)} USDC</strong></span><span>Wallet <strong data-testid="metric-wallet-balance">${money(metrics.data.walletUsdc)} USDC · {metrics.walletBalanceSource}</strong></span></div>
          </section>

          <section className="panel deposit-panel" aria-labelledby="actions-title">
            <div className="section-top">
              <h2 className="section-title" id="actions-title"><Coins size={15} /> Vault actions</h2>
              <span className="small-label">PREVIEW MODE</span>
            </div>
            <div className="amount-basis" role="group" aria-label="Choose the balance for percentage shortcuts">
              <button
                className={amountBasis === "deposit" ? "selected" : ""}
                type="button"
                aria-pressed={amountBasis === "deposit"}
                onClick={() => { setAmountBasis("deposit"); setAmount(""); setAction({ status: "idle" }); }}
                data-testid="button-basis-deposit"
              >Deposit · wallet</button>
              <button
                className={amountBasis === "withdraw" ? "selected" : ""}
                type="button"
                aria-pressed={amountBasis === "withdraw"}
                onClick={() => { setAmountBasis("withdraw"); setAmount(""); setAction({ status: "idle" }); }}
                data-testid="button-basis-withdraw"
              >Withdraw · vault</button>
            </div>
            <label className="input-label" htmlFor="usdc-amount">
              <span>{amountBasis === "deposit" ? "USDC amount · wallet balance" : "USDC amount · vault position"}</span>
              <span>{metrics.walletBalanceLoading ? "Reading Devnet…" : metrics.walletBalanceError ? "Devnet balance unavailable" : `${metrics.walletBalanceSource} · $${money(amountBasis === "deposit" ? metrics.data.walletUsdc : metrics.data.principalUsdc + metrics.data.yieldUsdc)}`}</span>
            </label>
            <div className="input-wrap">
              <input id="usdc-amount" className="amount-input" type="number" min="0" max={amountLimit} step="0.000001" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} aria-label="USDC amount for vault action" data-testid="input-usdc-amount" />
              <span className="input-unit">USDC</span>
            </div>
            <div className="amount-controls" aria-label={`Set amount based on ${amountBasis === "deposit" ? "wallet balance" : "vault position"}`}>
              {[25, 50, 75].map((percent) => <button key={percent} type="button" onClick={() => setPercent(percent / 100)} aria-label={`Use ${percent}% of ${amountBasis === "deposit" ? "wallet balance" : "vault position"}`} data-testid={`button-amount-${percent}`}>{percent}%</button>)}
              <button type="button" onClick={() => setPercent(1)} aria-label={`Use maximum ${amountBasis === "deposit" ? "wallet balance" : "vault position"}`} data-testid="button-amount-max">MAX</button>
            </div>
            <div className="available-line"><span>Wallet connection</span><strong>{wallet.connected ? `${wallet.publicKey?.toBase58().slice(0, 4)}…${wallet.publicKey?.toBase58().slice(-4)}` : "Not connected"}</strong></div>
            <div className="available-line"><span>Available to {amountBasis}</span><strong>{metrics.walletBalanceLoading ? "Checking Devnet…" : `$${money(amountLimit)} USDC`}</strong></div>
            <div className="action-buttons">
              <button className="primary-action hover:brightness-110 focus-visible:ring-2 focus-visible:ring-emerald-300" type="button" onClick={() => previewAction("deposit")} disabled={action.status === "simulating" || action.status === "executing"} data-testid="button-deposit"><Zap size={14} /> Deposit to Auto-Pilot</button>
              <button className="secondary-action hover:brightness-110 focus-visible:ring-2 focus-visible:ring-cyan-300" type="button" onClick={() => previewAction("withdraw")} disabled={action.status === "simulating" || action.status === "executing"} data-testid="button-withdraw"><ArrowDownToLine size={14} /> Instant Withdraw</button>
            </div>
            <div className={`action-message ${action.status === "error" ? "error" : ""}`} role="status" aria-live="polite" data-testid="status-vault-action">
              <strong>{action.status.toUpperCase()}</strong> · {action.message ?? "Ready for a local preview. No transaction will be sent."}
            </div>
            <div className="available-line"><span><LockKeyhole size={10} style={{ verticalAlign: "-2px" }} /> Local preview only</span><span>No transaction will be sent</span></div>
          </section>
        </div>

        <div className="content-grid fade-up">
          <section className="panel opportunities-panel" aria-labelledby="opportunities-title">
            <div className="section-heading">
              <div><h2 id="opportunities-title">Opportunity radar</h2><p>Cross-venue price observations · indicative demo feed</p></div>
              <span className="demo-pill">MOCK FEED</span>
            </div>
            <div className="column-head"><span>Pair</span><span>Orca</span><span>Raydium</span><span>Net spread</span><span>Status</span></div>
            {opportunities.data.map((opportunity) => (
              <div className={`opportunity-row ${opportunity.netSpreadPercent > 0.3 ? "highlight" : ""}`} key={opportunity.id} data-testid={`row-opportunity-${opportunity.id}`}>
                <div className="pair-name"><span className="coin-stack"><Coins size={12} /></span><span>{opportunity.pair}<span className="pair-sub">DEVNET · MOCK</span></span></div>
                <span className="price">${opportunity.orcaPrice.toFixed(opportunity.orcaPrice >= 1 ? 3 : 4)}</span>
                <span className="price">${opportunity.raydiumPrice.toFixed(opportunity.raydiumPrice >= 1 ? 3 : 4)}</span>
                <span className={`spread ${opportunity.netSpreadPercent <= 0.3 ? "low" : ""}`} data-testid={`text-spread-${opportunity.id}`}>{opportunity.netSpreadPercent > 0 ? "+" : ""}{opportunity.netSpreadPercent.toFixed(3)}%</span>
                <span className={`status ${opportunity.status.toLowerCase()}`} data-testid={`status-opportunity-${opportunity.id}`}><i className={opportunity.status === "Monitoring" ? "live-dot" : ""} />{opportunity.status}</span>
              </div>
            ))}
            <div className="threshold-note">Net spread above <strong>0.30%</strong> is highlighted. Mock prices are not live executable quotes; no pools or program are configured.</div>
          </section>

          <div className="right-stack">
            <section className="panel route-panel" aria-labelledby="route-title">
              <div className="section-heading"><div><div className="route-title-row"><h2 id="route-title">Atomic route loop</h2><button className="help-tip transition-colors hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-300" type="button" title="Atomic Execution: Guaranteed Zero Loss on Revert" aria-label="Atomic Execution: Guaranteed Zero Loss on Revert"><CircleHelp size={13} /></button></div><p>Intended execution path · not deployed</p></div><span className="demo-pill">NOT LIVE</span></div>
              <div className="route" aria-label="User Vault to Orca to Raydium to Profit Verified and Deposited">
                <div className="route-step"><div className="route-icon"><Wallet size={12} /></div><span>User Vault</span></div>
                <div className="route-step"><div className="route-icon"><ArrowUpRight size={13} /></div><span>Orca</span></div>
                <div className="route-step"><div className="route-icon"><ArrowUpRight size={13} /></div><span>Raydium</span></div>
                <div className="route-step"><div className="route-icon"><Check size={13} /></div><span>Profit verified<br />& deposited</span></div>
              </div>
              <p className="route-caption"><strong>Atomic means all-or-nothing:</strong> the intended transaction reverts if the complete route cannot verify profit, so a partial swap cannot settle. This is the design explanation only; the Anchor program is not deployed and previews send nothing.</p>
            </section>

            <section className="panel activity-panel" aria-labelledby="activity-title">
              <div className="section-heading"><div><h2 id="activity-title">Recent arb activity</h2><p>Latest vault observations</p></div><span className="demo-pill">DEMO</span></div>
              {trades.data.length === 0 ? <div className="empty-activity">No activity recorded yet.</div> : trades.data.map((trade) => (
                <div className="trade-row" key={trade.id} data-testid={`row-trade-${trade.id}`}>
                  <div><div className="trade-pair">{trade.pair}</div><div className="trade-time"><Clock3 size={10} style={{ verticalAlign: "-2px" }} /> &nbsp;{trade.timestamp}</div></div>
                  <div><div className="trade-profit">+${money(trade.profitUsdc, 3)}</div><div className="trade-source">{trade.source === "chain" && trade.signature ? <a href={`https://solscan.io/tx/${trade.signature}?cluster=devnet`} target="_blank" rel="noreferrer">SOLSCAN <ExternalLink size={9} /></a> : "SIMULATED · DEMO"}</div></div>
                </div>
              ))}
              <div className="activity-footer">Sample history only — no signatures or on-chain fills represented.</div>
            </section>
          </div>
        </div>
        <footer className="footer">
          <span>SolArb · ZERO-LOSS FLASH VAULT · DEVNET CONTROL SURFACE</span>
          <span><a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer" data-testid="link-solana-explorer">DEVNET EXPLORER <ExternalLink size={9} /></a> &nbsp;·&nbsp; {devnet.latency === null ? "RPC PING —" : `RPC PING ${devnet.latency} MS`}</span>
        </footer>
      </main>
    </div>
  );
}
