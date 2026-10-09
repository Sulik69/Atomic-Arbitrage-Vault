import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

const ORCA_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
);
const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey(
  "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
);
const DEVNET_RPC = "https://api.devnet.solana.com";
const Q64 = 1n << 64n;
const ORCA_POOL_DATA_MIN_LENGTH = 245;
const ORCA_SQRT_PRICE_OFFSET = 65;
const ORCA_MINT_A_OFFSET = 101;
const ORCA_VAULT_A_OFFSET = 133;
const ORCA_MINT_B_OFFSET = 181;
const ORCA_VAULT_B_OFFSET = 213;
const COMPUTE_UNIT_LIMIT = 1_200_000;

type Config = {
  rpcUrl: string;
  walletPath: string;
  idlPath: string;
  usdcMint: PublicKey;
  intermediateMint: PublicKey;
  orcaWhirlpool: PublicKey;
  orcaTickArrays: [PublicKey, PublicKey, PublicKey];
  raydiumAmmConfig: PublicKey;
  raydiumPoolState: PublicKey;
  raydiumInputVault: PublicKey;
  raydiumOutputVault: PublicKey;
  raydiumObservationState: PublicKey;
  amountIn: bigint;
  minProfit: bigint;
  slippageBps: bigint;
  estimateHaircutBps: bigint;
  pollIntervalMs: number;
  maxPriorityFeeMicroLamports: bigint;
};

type TokenAccountData = {
  mint: PublicKey;
  amount: bigint;
};

type WhirlpoolSnapshot = {
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  sqrtPriceX64: bigint;
};

type VaultStateView = {
  botAuthority: PublicKey;
  usdcMint: PublicKey;
  usdcVault: PublicKey;
  paused: boolean;
};

type AnchorMethodBuilder = {
  accounts(accounts: Record<string, PublicKey>): {
    instruction(): Promise<TransactionInstruction>;
  };
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function publicKeyEnv(name: string): PublicKey {
  return new PublicKey(requiredEnv(name));
}

function positiveBigIntEnv(name: string): bigint {
  const raw = requiredEnv(name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be greater than zero`);
  return value;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safely representable integer`);
  }
  return value;
}

function loadConfig(): Config {
  const slippageBps = BigInt(nonNegativeIntEnv("SLIPPAGE_BPS", 100));
  const estimateHaircutBps = BigInt(
    nonNegativeIntEnv("ESTIMATE_HAIRCUT_BPS", 200),
  );
  if (slippageBps >= 10_000n) throw new Error("SLIPPAGE_BPS must be below 10000");
  if (estimateHaircutBps >= 10_000n) {
    throw new Error("ESTIMATE_HAIRCUT_BPS must be below 10000");
  }

  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEVNET_RPC,
    walletPath: resolve(expandHome(
      process.env.ANCHOR_WALLET?.trim() || "~/.config/solana/id.json",
    )),
    idlPath: resolve(
      process.cwd(),
      process.env.ARB_IDL_PATH?.trim() || "../target/idl/arbitrage_vault.json",
    ),
    usdcMint: publicKeyEnv("USDC_MINT"),
    intermediateMint: publicKeyEnv("INTERMEDIATE_MINT"),
    orcaWhirlpool: publicKeyEnv("ORCA_WHIRLPOOL"),
    orcaTickArrays: [
      publicKeyEnv("ORCA_TICK_ARRAY_0"),
      publicKeyEnv("ORCA_TICK_ARRAY_1"),
      publicKeyEnv("ORCA_TICK_ARRAY_2"),
    ],
    raydiumAmmConfig: publicKeyEnv("RAYDIUM_AMM_CONFIG"),
    raydiumPoolState: publicKeyEnv("RAYDIUM_POOL_STATE"),
    raydiumInputVault: publicKeyEnv("RAYDIUM_INPUT_VAULT"),
    raydiumOutputVault: publicKeyEnv("RAYDIUM_OUTPUT_VAULT"),
    raydiumObservationState: publicKeyEnv("RAYDIUM_OBSERVATION_STATE"),
    amountIn: positiveBigIntEnv("TRADE_AMOUNT_USDC"),
    minProfit: positiveBigIntEnv("MIN_PROFIT_USDC"),
    slippageBps,
    estimateHaircutBps,
    pollIntervalMs: nonNegativeIntEnv("POLL_INTERVAL_MS", 5_000),
    maxPriorityFeeMicroLamports: BigInt(
      nonNegativeIntEnv("MAX_PRIORITY_FEE_MICROLAMPORTS", 100_000),
    ),
  };
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) {
    return resolve(process.env.HOME ?? "", path.slice(2));
  }
  return path;
}

function loadKeypair(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every(
      (value) =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255,
    )
  ) {
    throw new Error("ANCHOR_WALLET must point to a Solana keypair JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function readPubkey(data: Buffer, offset: number): PublicKey {
  const end = offset + 32;
  if (data.length < end) throw new Error("Pool account data is truncated");
  return new PublicKey(data.subarray(offset, end));
}

async function readWhirlpool(
  connection: Connection,
  key: PublicKey,
): Promise<WhirlpoolSnapshot> {
  const account = await connection.getAccountInfo(key, "confirmed");
  if (!account) throw new Error(`Orca Whirlpool not found: ${key.toBase58()}`);
  if (!account.owner.equals(ORCA_PROGRAM_ID)) {
    throw new Error("ORCA_WHIRLPOOL is not owned by the expected Orca program");
  }
  if (account.data.length < ORCA_POOL_DATA_MIN_LENGTH) {
    throw new Error("Orca Whirlpool account data is shorter than the expected layout");
  }

  const sqrtPriceX64 =
    account.data.readBigUInt64LE(ORCA_SQRT_PRICE_OFFSET) |
    (account.data.readBigUInt64LE(ORCA_SQRT_PRICE_OFFSET + 8) << 64n);
  return {
    mintA: readPubkey(account.data, ORCA_MINT_A_OFFSET),
    vaultA: readPubkey(account.data, ORCA_VAULT_A_OFFSET),
    mintB: readPubkey(account.data, ORCA_MINT_B_OFFSET),
    vaultB: readPubkey(account.data, ORCA_VAULT_B_OFFSET),
    sqrtPriceX64,
  };
}

async function readTokenAccount(
  connection: Connection,
  key: PublicKey,
): Promise<TokenAccountData> {
  const account = await connection.getAccountInfo(key, "confirmed");
  if (!account) throw new Error(`SPL token account not found: ${key.toBase58()}`);
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`${key.toBase58()} is not a classic SPL Token account`);
  }
  const decoded = AccountLayout.decode(account.data);
  return {
    mint: decoded.mint,
    amount: BigInt(decoded.amount.toString()),
  };
}

function quoteOrcaSpot(
  amountIn: bigint,
  sqrtPriceX64: bigint,
  usdcIsMintA: boolean,
): bigint {
  const sqrtSquared = sqrtPriceX64 * sqrtPriceX64;
  if (usdcIsMintA) {
    return (amountIn * sqrtSquared) / (Q64 * Q64);
  }
  return (amountIn * Q64 * Q64) / sqrtSquared;
}

function quoteCpmmSpot(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (amountIn * reserveOut) / reserveIn;
}

function deriveVaultState(programId: PublicKey, usdcMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdcMint.toBuffer()],
    programId,
  )[0];
}

function deriveOrcaOracle(whirlpool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), whirlpool.toBuffer()],
    ORCA_PROGRAM_ID,
  )[0];
}

function deriveRaydiumAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    RAYDIUM_CPMM_PROGRAM_ID,
  )[0];
}

async function readVaultState(
  program: Program<Idl>,
  address: PublicKey,
): Promise<VaultStateView> {
  const accounts = program.account as unknown as {
    vaultState: {
      fetch(address: PublicKey): Promise<VaultStateView>;
    };
  };
  return accounts.vaultState.fetch(address);
}

async function getPriorityFee(
  connection: Connection,
  config: Config,
): Promise<bigint> {
  const samples = await connection.getRecentPrioritizationFees({
    lockedWritableAccounts: [config.orcaWhirlpool, config.raydiumPoolState],
  });
  if (samples.length === 0) {
    throw new Error("RPC returned no recent prioritization-fee samples");
  }
  const fees = samples
    .map((sample) => sample.prioritizationFee)
    .sort((a, b) => a - b);
  const p75 = fees[Math.floor((fees.length - 1) * 0.75)] ?? 0;
  const capped = Math.min(p75, Number(config.maxPriorityFeeMicroLamports));
  return BigInt(Math.max(0, Math.floor(capped)));
}

function checkConfiguredRoute(
  config: Config,
  whirlpool: WhirlpoolSnapshot,
  inputVault: TokenAccountData,
  outputVault: TokenAccountData,
): boolean {
  const usdcIsA = whirlpool.mintA.equals(config.usdcMint);
  const usdcIsB = whirlpool.mintB.equals(config.usdcMint);
  const intermediateIsA = whirlpool.mintA.equals(config.intermediateMint);
  const intermediateIsB = whirlpool.mintB.equals(config.intermediateMint);
  if (!(usdcIsA && intermediateIsB) && !(usdcIsB && intermediateIsA)) {
    throw new Error("Orca pool must contain exactly the configured USDC and intermediate mint");
  }
  if (!inputVault.mint.equals(config.intermediateMint)) {
    throw new Error("RAYDIUM_INPUT_VAULT does not hold the intermediate mint");
  }
  if (!outputVault.mint.equals(config.usdcMint)) {
    throw new Error("RAYDIUM_OUTPUT_VAULT does not hold the configured USDC mint");
  }
  return usdcIsA;
}

async function scanOnce(
  connection: Connection,
  program: Program<Idl>,
  wallet: Keypair,
  config: Config,
): Promise<void> {
  const programId = program.programId;
  const vaultStateAddress = deriveVaultState(programId, config.usdcMint);
  const [whirlpool, inputVault, outputVault, raydiumPool, raydiumConfig, observation] =
    await Promise.all([
      readWhirlpool(connection, config.orcaWhirlpool),
      readTokenAccount(connection, config.raydiumInputVault),
      readTokenAccount(connection, config.raydiumOutputVault),
      connection.getAccountInfo(config.raydiumPoolState, "confirmed"),
      connection.getAccountInfo(config.raydiumAmmConfig, "confirmed"),
      connection.getAccountInfo(config.raydiumObservationState, "confirmed"),
    ]);

  if (!raydiumPool?.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) {
    throw new Error("RAYDIUM_POOL_STATE is not owned by the expected Devnet CPMM program");
  }
  if (!raydiumConfig?.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) {
    throw new Error("RAYDIUM_AMM_CONFIG is not owned by the expected Devnet CPMM program");
  }
  if (!observation?.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) {
    throw new Error("RAYDIUM_OBSERVATION_STATE is not owned by the expected Devnet CPMM program");
  }

  const usdcIsMintA = checkConfiguredRoute(config, whirlpool, inputVault, outputVault);
  const vaultState = await readVaultState(program, vaultStateAddress);
  if (!vaultState.botAuthority.equals(wallet.publicKey)) {
    throw new Error("The wallet does not match the vault's configured bot authority");
  }
  if (!vaultState.usdcMint.equals(config.usdcMint)) {
    throw new Error("Configured USDC mint does not match the initialized vault");
  }
  if (vaultState.paused) {
    console.info("Vault is paused; no transaction will be built.");
    return;
  }

  const usdcVault = getAssociatedTokenAddressSync(
    config.usdcMint,
    vaultStateAddress,
    true,
  );
  if (!vaultState.usdcVault.equals(usdcVault)) {
    throw new Error("Vault state points to an unexpected USDC token account");
  }
  const intermediateVault = getAssociatedTokenAddressSync(
    config.intermediateMint,
    vaultStateAddress,
    true,
  );

  const expectedIntermediate = quoteOrcaSpot(
    config.amountIn,
    whirlpool.sqrtPriceX64,
    usdcIsMintA,
  );
  const expectedUsdc = quoteCpmmSpot(
    expectedIntermediate,
    inputVault.amount,
    outputVault.amount,
  );
  const estimatedUsdcAfterHaircut =
    (expectedUsdc * (10_000n - config.estimateHaircutBps)) / 10_000n;
  const minIntermediateOut =
    (expectedIntermediate * (10_000n - config.slippageBps)) / 10_000n;
  const requiredUsdc = config.amountIn + config.minProfit;

  if (
    expectedIntermediate <= 0n ||
    minIntermediateOut <= 0n ||
    estimatedUsdcAfterHaircut <= requiredUsdc
  ) {
    console.info("No estimated spread above the configured profit threshold.");
    return;
  }

  const stateInfo = await connection.getAccountInfo(vaultStateAddress, "confirmed");
  if (!stateInfo) throw new Error("Vault state account is missing");
  if (!stateInfo.owner.equals(programId)) {
    throw new Error("Vault state is not owned by the configured vault program");
  }
  const intermediateAccount = await connection.getAccountInfo(
    intermediateVault,
    "confirmed",
  );
  if (!intermediateAccount) {
    throw new Error("The intermediate-token vault ATA is missing; create it before scanning");
  }
  if (!intermediateAccount.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error("The intermediate-token vault is not owned by classic SPL Token");
  }
  const intermediateData = AccountLayout.decode(intermediateAccount.data);
  if (
    !intermediateData.mint.equals(config.intermediateMint) ||
    !intermediateData.owner.equals(vaultStateAddress)
  ) {
    throw new Error("The intermediate-token vault ATA has an unexpected mint or owner");
  }

  const priorityFee = await getPriorityFee(connection, config);
  const oracle = deriveOrcaOracle(config.orcaWhirlpool);
  const raydiumAuthority = deriveRaydiumAuthority();
  const builder = program.methods as unknown as {
    executeArbitrage(
      amountIn: BN,
      minIntermediateOut: BN,
      minProfit: BN,
    ): AnchorMethodBuilder;
  };
  const arbitrageInstruction = await builder
    .executeArbitrage(
      new BN(config.amountIn.toString()),
      new BN(minIntermediateOut.toString()),
      new BN(config.minProfit.toString()),
    )
    .accounts({
      botAuthority: wallet.publicKey,
      vaultState: vaultStateAddress,
      usdcMint: config.usdcMint,
      usdcVault,
      intermediateMint: config.intermediateMint,
      intermediateVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      orcaProgram: ORCA_PROGRAM_ID,
      orcaWhirlpool: config.orcaWhirlpool,
      orcaTokenVaultA: whirlpool.vaultA,
      orcaTokenVaultB: whirlpool.vaultB,
      orcaTickArray0: config.orcaTickArrays[0],
      orcaTickArray1: config.orcaTickArrays[1],
      orcaTickArray2: config.orcaTickArrays[2],
      orcaOracle: oracle,
      raydiumProgram: RAYDIUM_CPMM_PROGRAM_ID,
      raydiumAuthority,
      raydiumAmmConfig: config.raydiumAmmConfig,
      raydiumPoolState: config.raydiumPoolState,
      raydiumInputVault: config.raydiumInputVault,
      raydiumOutputVault: config.raydiumOutputVault,
      raydiumObservationState: config.raydiumObservationState,
    })
    .instruction();

  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    arbitrageInstruction,
  );
  transaction.sign(wallet);

  const simulation = await connection.simulateTransaction(
    transaction,
    [wallet],
  );
  if (simulation.value.err) {
    console.info(
      "Simulation rejected the route; no transaction sent.",
      JSON.stringify(simulation.value.err),
    );
    for (const line of simulation.value.logs?.slice(-8) ?? []) {
      console.info(line);
    }
    return;
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`Submitted transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  console.info(
    `Arbitrage confirmed: ${signature}; estimated gross output ${estimatedUsdcAfterHaircut.toString()} base units.`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const wallet = loadKeypair(config.walletPath);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const idl = JSON.parse(readFileSync(config.idlPath, "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const programInfo = await connection.getAccountInfo(program.programId, "confirmed");
  if (!programInfo?.executable) {
    throw new Error(`Vault program is not deployed at ${program.programId.toBase58()}`);
  }

  console.info(
    `Scanning Devnet as ${wallet.publicKey.toBase58()} every ${config.pollIntervalMs} ms.`,
  );
  while (true) {
    try {
      await scanOnce(connection, program, wallet, config);
    } catch (error) {
      console.error("Scan failed; no transaction was sent during this iteration.", error);
    }
    await new Promise((resolveTimer) =>
      setTimeout(resolveTimer, config.pollIntervalMs),
    );
  }
}

main().catch((error: unknown) => {
  console.error("Scanner startup failed.", error);
  process.exitCode = 1;
});
