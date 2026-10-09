import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnchorProvider,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

type VaultAdminMethodBuilder = {
  accounts(accounts: Record<string, PublicKey>): {
    rpc(): Promise<string>;
  };
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadWallet(): Keypair {
  const rawPath = requiredEnv("ANCHOR_WALLET");
  const walletPath = resolve(
    rawPath === "~"
      ? process.env.HOME ?? rawPath
      : rawPath.startsWith("~/")
        ? resolve(process.env.HOME ?? "", rawPath.slice(2))
        : rawPath,
  );
  const parsed: unknown = JSON.parse(readFileSync(walletPath, "utf8"));
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

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== "initialize" && action !== "set-bot") {
    throw new Error("Usage: pnpm run vault:init | vault:set-bot");
  }

  const wallet = loadWallet();
  const connection = new Connection(
    process.env.RPC_URL?.trim() || "https://api.devnet.solana.com",
    "confirmed",
  );
  const idlPath = resolve(
    process.cwd(),
    process.env.ARB_IDL_PATH?.trim() || "../target/idl/arbitrage_vault.json",
  );
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const programId = program.programId;
  const usdcMint = new PublicKey(requiredEnv("USDC_MINT"));
  const [vaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdcMint.toBuffer()],
    programId,
  );

  if (action === "initialize") {
    const botAuthority = new PublicKey(requiredEnv("BOT_AUTHORITY"));
    const usdcVault = getAssociatedTokenAddressSync(
      usdcMint,
      vaultState,
      true,
      TOKEN_PROGRAM_ID,
    );
    const methods = program.methods as unknown as {
      initializeVault(botAuthority: PublicKey): VaultAdminMethodBuilder;
    };
    const signature = await methods
      .initializeVault(botAuthority)
      .accounts({
        payer: wallet.publicKey,
        usdcMint,
        vaultState,
        usdcVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.info(`Vault initialized: ${signature}`);
    console.info(`Vault state: ${vaultState.toBase58()}`);
    console.info(`USDC vault: ${usdcVault.toBase58()}`);
    return;
  }

  const newBotAuthority = new PublicKey(requiredEnv("BOT_AUTHORITY"));
  const methods = program.methods as unknown as {
    setBotAuthority(botAuthority: PublicKey): VaultAdminMethodBuilder;
  };
  const signature = await methods
    .setBotAuthority(newBotAuthority)
    .accounts({
      admin: wallet.publicKey,
      vaultState,
      usdcMint,
    })
    .rpc();
  console.info(`Bot authority updated: ${signature}`);
}

main().catch((error: unknown) => {
  console.error("Vault admin command failed.", error);
  process.exitCode = 1;
});
