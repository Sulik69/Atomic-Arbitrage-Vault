use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("11111111111111111111111111111111");

/// Orca Whirlpool program ID. The CPI below targets its legacy `swap`
/// instruction, not `swap_v2`.
pub const ORCA_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
/// Raydium CPMM Devnet program ID (not AMM v4 or CLMM).
pub const RAYDIUM_CPMM_PROGRAM_ID: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");

// Whirlpool v1 account offsets; verified against the upstream Whirlpool
// account layout. The exact Orca program ID is fixed above and checked below.
const WHIRLPOOL_MINT_A_OFFSET: usize = 101;
const WHIRLPOOL_VAULT_A_OFFSET: usize = 133;
const WHIRLPOOL_MINT_B_OFFSET: usize = 181;
const WHIRLPOOL_VAULT_B_OFFSET: usize = 213;
const WHIRLPOOL_MIN_SQRT_PRICE_X64: u128 = 4_295_048_016;
const WHIRLPOOL_MAX_SQRT_PRICE_X64: u128 = 79_226_673_515_401_279_992_447_579_055;
const WHIRLPOOL_ACCOUNT_DISCRIMINATOR: [u8; 8] = [0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09];
const ORCA_SWAP_DISCRIMINATOR: [u8; 8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];
const RAYDIUM_SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] =
    [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

#[program]
pub mod arbitrage_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, bot_authority: Pubkey) -> Result<()> {
        require!(
            bot_authority != Pubkey::default(),
            ArbitrageError::InvalidBotAuthority
        );

        let state = &mut ctx.accounts.vault_state;
        state.bump = ctx.bumps.vault_state;
        state.admin = ctx.accounts.payer.key();
        state.bot_authority = bot_authority;
        state.usdc_mint = ctx.accounts.usdc_mint.key();
        state.usdc_vault = ctx.accounts.usdc_vault.key();
        state.total_shares = 0;
        state.paused = false;

        emit!(VaultInitialized {
            admin: state.admin,
            bot_authority,
            usdc_mint: state.usdc_mint,
            usdc_vault: state.usdc_vault,
        });
        Ok(())
    }

    pub fn set_bot_authority(ctx: Context<AdminVault>, new_bot_authority: Pubkey) -> Result<()> {
        require!(
            new_bot_authority != Pubkey::default(),
            ArbitrageError::InvalidBotAuthority
        );
        ctx.accounts.vault_state.bot_authority = new_bot_authority;
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminVault>, paused: bool) -> Result<()> {
        ctx.accounts.vault_state.paused = paused;
        Ok(())
    }

    /// Deposit classic SPL-token USDC. Share units are proportional claims on
    /// the vault's USDC balance, including realized arbitrage gains.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ArbitrageError::ZeroAmount);
        require!(
            !ctx.accounts.vault_state.paused,
            ArbitrageError::VaultPaused
        );

        let total_shares = ctx.accounts.vault_state.total_shares;
        let shares_to_mint =
            calculate_shares_to_mint(amount, ctx.accounts.usdc_vault.amount, total_shares)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let shares = &mut ctx.accounts.user_shares;
        require!(
            shares.owner == Pubkey::default() || shares.owner == ctx.accounts.user.key(),
            ArbitrageError::InvalidShareOwner
        );
        shares.owner = ctx.accounts.user.key();
        shares.shares = shares
            .shares
            .checked_add(shares_to_mint)
            .ok_or(ArbitrageError::MathOverflow)?;

        ctx.accounts.vault_state.total_shares = total_shares
            .checked_add(shares_to_mint)
            .ok_or(ArbitrageError::MathOverflow)?;

        emit!(Deposited {
            owner: ctx.accounts.user.key(),
            amount,
            shares: shares_to_mint,
            total_shares: ctx.accounts.vault_state.total_shares,
        });
        Ok(())
    }

    /// Burn pool shares and withdraw the corresponding fraction of the live
    /// USDC vault balance (principal plus realized profit).
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, ArbitrageError::ZeroAmount);
        let total_shares = ctx.accounts.vault_state.total_shares;
        let user_shares = ctx.accounts.user_shares.shares;
        let vault_balance = ctx.accounts.usdc_vault.amount;

        require!(shares <= user_shares, ArbitrageError::InsufficientShares);
        let amount = calculate_withdrawal_amount(vault_balance, total_shares, shares)?;

        ctx.accounts.user_shares.shares = user_shares
            .checked_sub(shares)
            .ok_or(ArbitrageError::MathOverflow)?;
        ctx.accounts.vault_state.total_shares = total_shares
            .checked_sub(shares)
            .ok_or(ArbitrageError::MathOverflow)?;

        let mint_key = ctx.accounts.usdc_mint.key();
        let bump = [ctx.accounts.vault_state.bump];
        let signer_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump];
        let signer = [signer_seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                &signer,
            ),
            amount,
        )?;

        emit!(Withdrawn {
            owner: ctx.accounts.user.key(),
            amount,
            shares,
            total_shares: ctx.accounts.vault_state.total_shares,
        });
        Ok(())
    }

    /// Execute USDC -> intermediate token on Orca Whirlpool, then
    /// intermediate token -> USDC on Raydium CPMM.
    ///
    /// Both CPIs and the final balance check run in one Solana transaction.
    /// Any error rolls back both swaps and all token movements.
    pub fn execute_arbitrage(
        ctx: Context<ExecuteArbitrage>,
        amount_in: u64,
        min_intermediate_out: u64,
        min_profit: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.vault_state.paused,
            ArbitrageError::VaultPaused
        );
        require!(amount_in > 0, ArbitrageError::ZeroAmount);
        require!(min_profit > 0, ArbitrageError::ZeroProfitThreshold);
        require!(
            ctx.accounts.vault_state.total_shares > 0,
            ArbitrageError::NoShareholders
        );

        let initial_usdc_balance = ctx.accounts.usdc_vault.amount;
        let initial_intermediate_balance = ctx.accounts.intermediate_vault.amount;
        require!(
            amount_in <= initial_usdc_balance,
            ArbitrageError::InsufficientVaultBalance
        );
        require_keys_eq!(
            ctx.accounts.orca_program.key(),
            ORCA_PROGRAM_ID,
            ArbitrageError::InvalidDexProgram
        );
        require_keys_eq!(
            ctx.accounts.raydium_program.key(),
            RAYDIUM_CPMM_PROGRAM_ID,
            ArbitrageError::InvalidDexProgram
        );
        require!(
            ctx.accounts.orca_program.executable && ctx.accounts.raydium_program.executable,
            ArbitrageError::InvalidDexProgram
        );

        // Confirm the supplied Whirlpool is a real account owned by the fixed
        // Orca program, and derive direction/mints/vaults from its state rather
        // than trusting the off-chain bot.
        require_keys_eq!(
            *ctx.accounts.orca_whirlpool.owner,
            ORCA_PROGRAM_ID,
            ArbitrageError::InvalidOrcaPool
        );
        let whirlpool_info = ctx.accounts.orca_whirlpool.to_account_info();
        let (mint_a, vault_a, mint_b, vault_b) = {
            let data = whirlpool_info.try_borrow_data()?;
            require!(
                data.len() >= WHIRLPOOL_VAULT_B_OFFSET + 32,
                ArbitrageError::InvalidOrcaPool
            );
            require!(
                data.get(..8) == Some(WHIRLPOOL_ACCOUNT_DISCRIMINATOR.as_ref()),
                ArbitrageError::InvalidOrcaPool
            );
            (
                read_pubkey_at(&data, WHIRLPOOL_MINT_A_OFFSET)?,
                read_pubkey_at(&data, WHIRLPOOL_VAULT_A_OFFSET)?,
                read_pubkey_at(&data, WHIRLPOOL_MINT_B_OFFSET)?,
                read_pubkey_at(&data, WHIRLPOOL_VAULT_B_OFFSET)?,
            )
        };
        require_keys_eq!(
            vault_a,
            ctx.accounts.orca_token_vault_a.key(),
            ArbitrageError::InvalidOrcaPool
        );
        require_keys_eq!(
            vault_b,
            ctx.accounts.orca_token_vault_b.key(),
            ArbitrageError::InvalidOrcaPool
        );
        require_keys_eq!(
            ctx.accounts.orca_token_vault_a.mint,
            mint_a,
            ArbitrageError::InvalidOrcaPool
        );
        require_keys_eq!(
            ctx.accounts.orca_token_vault_b.mint,
            mint_b,
            ArbitrageError::InvalidOrcaPool
        );

        let usdc_mint = ctx.accounts.usdc_mint.key();
        let intermediate_mint = ctx.accounts.intermediate_mint.key();
        let a_to_b = if mint_a == usdc_mint && mint_b == intermediate_mint {
            true
        } else if mint_b == usdc_mint && mint_a == intermediate_mint {
            false
        } else {
            return err!(ArbitrageError::InvalidOrcaPool);
        };

        let usdc_vault = ctx.accounts.usdc_vault.to_account_info();
        let intermediate_vault = ctx.accounts.intermediate_vault.to_account_info();
        let (owner_account_a, owner_account_b) = if a_to_b {
            (usdc_vault.clone(), intermediate_vault.clone())
        } else {
            (intermediate_vault.clone(), usdc_vault.clone())
        };

        let sqrt_price_limit = if a_to_b {
            WHIRLPOOL_MIN_SQRT_PRICE_X64 + 1
        } else {
            WHIRLPOOL_MAX_SQRT_PRICE_X64 - 1
        };
        let mut orca_data = Vec::with_capacity(42);
        orca_data.extend_from_slice(&ORCA_SWAP_DISCRIMINATOR);
        orca_data.extend_from_slice(&amount_in.to_le_bytes());
        orca_data.extend_from_slice(&min_intermediate_out.to_le_bytes());
        orca_data.extend_from_slice(&sqrt_price_limit.to_le_bytes());
        orca_data.push(1); // amount_specified_is_input
        orca_data.push(u8::from(a_to_b));

        let orca_ix = Instruction {
            program_id: ORCA_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_state.key(), true),
                AccountMeta::new(ctx.accounts.orca_whirlpool.key(), false),
                AccountMeta::new(owner_account_a.key(), false),
                AccountMeta::new(ctx.accounts.orca_token_vault_a.key(), false),
                AccountMeta::new(owner_account_b.key(), false),
                AccountMeta::new(ctx.accounts.orca_token_vault_b.key(), false),
                AccountMeta::new(ctx.accounts.orca_tick_array_0.key(), false),
                AccountMeta::new(ctx.accounts.orca_tick_array_1.key(), false),
                AccountMeta::new(ctx.accounts.orca_tick_array_2.key(), false),
                AccountMeta::new(ctx.accounts.orca_oracle.key(), false),
            ],
            data: orca_data,
        };

        let mint_key = ctx.accounts.usdc_mint.key();
        let bump = [ctx.accounts.vault_state.bump];
        let signer_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump];
        let signer = [signer_seeds];
        invoke_signed(
            &orca_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.vault_state.to_account_info(),
                whirlpool_info,
                owner_account_a,
                ctx.accounts.orca_token_vault_a.to_account_info(),
                owner_account_b,
                ctx.accounts.orca_token_vault_b.to_account_info(),
                ctx.accounts.orca_tick_array_0.to_account_info(),
                ctx.accounts.orca_tick_array_1.to_account_info(),
                ctx.accounts.orca_tick_array_2.to_account_info(),
                ctx.accounts.orca_oracle.to_account_info(),
                ctx.accounts.orca_program.to_account_info(),
            ],
            &signer,
        )?;

        ctx.accounts.intermediate_vault.reload()?;
        let intermediate_amount = ctx
            .accounts
            .intermediate_vault
            .amount
            .checked_sub(initial_intermediate_balance)
            .ok_or(ArbitrageError::MathOverflow)?;
        require!(
            intermediate_amount >= min_intermediate_out && intermediate_amount > 0,
            ArbitrageError::ArbitrageUnprofitable
        );

        // Let the CPMM complete a positive-output swap so the vault's explicit
        // post-CPI invariant can return ArbitrageUnprofitable on a bad trade.
        // A downstream minimum of amount_in + min_profit would revert first
        // with Raydium's error and bypass the vault's custom profit error.
        let min_usdc_out = 0u64;
        let mut raydium_data = Vec::with_capacity(24);
        raydium_data.extend_from_slice(&RAYDIUM_SWAP_BASE_INPUT_DISCRIMINATOR);
        raydium_data.extend_from_slice(&intermediate_amount.to_le_bytes());
        raydium_data.extend_from_slice(&min_usdc_out.to_le_bytes());

        let raydium_ix = Instruction {
            program_id: RAYDIUM_CPMM_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault_state.key(), true), // payer / token authority
                AccountMeta::new_readonly(ctx.accounts.raydium_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.raydium_amm_config.key(), false),
                AccountMeta::new(ctx.accounts.raydium_pool_state.key(), false),
                AccountMeta::new(intermediate_vault.key(), false),
                AccountMeta::new(usdc_vault.key(), false),
                AccountMeta::new(ctx.accounts.raydium_input_vault.key(), false),
                AccountMeta::new(ctx.accounts.raydium_output_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(intermediate_mint, false),
                AccountMeta::new_readonly(usdc_mint, false),
                AccountMeta::new(ctx.accounts.raydium_observation_state.key(), false),
            ],
            data: raydium_data,
        };
        invoke_signed(
            &raydium_ix,
            &[
                ctx.accounts.vault_state.to_account_info(),
                ctx.accounts.raydium_authority.to_account_info(),
                ctx.accounts.raydium_amm_config.to_account_info(),
                ctx.accounts.raydium_pool_state.to_account_info(),
                intermediate_vault,
                usdc_vault,
                ctx.accounts.raydium_input_vault.to_account_info(),
                ctx.accounts.raydium_output_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.intermediate_mint.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.raydium_observation_state.to_account_info(),
                ctx.accounts.raydium_program.to_account_info(),
            ],
            &signer,
        )?;

        ctx.accounts.usdc_vault.reload()?;
        ctx.accounts.intermediate_vault.reload()?;
        require!(
            ctx.accounts.intermediate_vault.amount == initial_intermediate_balance,
            ArbitrageError::IntermediateBalanceChanged
        );
        // Atomic zero-loss / positive-profit invariant. Returning this error
        // rolls back both AMM CPIs and all token transfers.
        let profit = enforce_minimum_profit(
            initial_usdc_balance,
            ctx.accounts.usdc_vault.amount,
            min_profit,
        )?;
        emit!(ArbitrageExecuted {
            bot: ctx.accounts.bot_authority.key(),
            amount_in,
            intermediate_amount,
            initial_usdc_balance,
            final_usdc_balance: ctx.accounts.usdc_vault.amount,
            profit,
        });
        Ok(())
    }
}

fn calculate_shares_to_mint(amount: u64, balance_before: u64, total_shares: u64) -> Result<u64> {
    require!(amount > 0, ArbitrageError::ZeroAmount);
    if total_shares == 0 {
        // Refuse to let the first depositor claim unsolicited tokens sent
        // directly to the vault before the share ledger exists.
        require!(balance_before == 0, ArbitrageError::AssetsWithoutShares);
        return Ok(amount);
    }

    require!(balance_before > 0, ArbitrageError::MathOverflow);
    let shares = u128::from(amount)
        .checked_mul(u128::from(total_shares))
        .ok_or(ArbitrageError::MathOverflow)?
        .checked_div(u128::from(balance_before))
        .ok_or(ArbitrageError::MathOverflow)?;
    let shares = u64::try_from(shares).map_err(|_| error!(ArbitrageError::MathOverflow))?;
    require!(shares > 0, ArbitrageError::DepositTooSmall);
    Ok(shares)
}

fn calculate_withdrawal_amount(vault_balance: u64, total_shares: u64, shares: u64) -> Result<u64> {
    require!(
        shares > 0 && shares <= total_shares && total_shares > 0,
        ArbitrageError::InsufficientShares
    );
    let amount = if shares == total_shares {
        vault_balance
    } else {
        let payout = u128::from(vault_balance)
            .checked_mul(u128::from(shares))
            .ok_or(ArbitrageError::MathOverflow)?
            .checked_div(u128::from(total_shares))
            .ok_or(ArbitrageError::MathOverflow)?;
        u64::try_from(payout).map_err(|_| error!(ArbitrageError::MathOverflow))?
    };
    require!(amount > 0, ArbitrageError::WithdrawalTooSmall);
    Ok(amount)
}

fn enforce_minimum_profit(
    initial_balance: u64,
    final_balance: u64,
    min_profit: u64,
) -> Result<u64> {
    let required_balance = initial_balance
        .checked_add(min_profit)
        .ok_or(ArbitrageError::MathOverflow)?;
    require!(
        final_balance >= required_balance,
        ArbitrageError::ArbitrageUnprofitable
    );
    final_balance
        .checked_sub(initial_balance)
        .ok_or(ArbitrageError::ArbitrageUnprofitable.into())
}

fn read_pubkey_at(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes = data
        .get(offset..offset + 32)
        .ok_or(ArbitrageError::InvalidOrcaPool)?;
    let mut raw = [0u8; 32];
    raw.copy_from_slice(bytes);
    Ok(Pubkey::new_from_array(raw))
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = VaultState::SPACE,
        seeds = [b"vault", usdc_mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_state
    )]
    pub usdc_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminVault<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", usdc_mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = admin,
        has_one = usdc_mint
    )]
    pub vault_state: Account<'info, VaultState>,
    pub usdc_mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", usdc_mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = usdc_mint,
        has_one = usdc_vault
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(address = vault_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = vault_state.usdc_vault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = UserShares::SPACE,
        seeds = [b"shares", vault_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_shares: Account<'info, UserShares>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", usdc_mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = usdc_mint,
        has_one = usdc_vault
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(address = vault_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = vault_state.usdc_vault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"shares", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_shares.owner == user.key() @ ArbitrageError::InvalidShareOwner
    )]
    pub user_shares: Account<'info, UserShares>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteArbitrage<'info> {
    #[account(mut, address = vault_state.bot_authority)]
    pub bot_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", usdc_mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = usdc_mint,
        has_one = usdc_vault
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(address = vault_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = vault_state.usdc_vault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(constraint = intermediate_mint.key() != usdc_mint.key())]
    pub intermediate_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = intermediate_mint,
        associated_token::authority = vault_state
    )]
    pub intermediate_vault: Account<'info, TokenAccount>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, Token>,

    /// CHECK: Fixed to the official Whirlpool program ID; CPI checks its ABI.
    #[account(address = ORCA_PROGRAM_ID)]
    pub orca_program: UncheckedAccount<'info>,
    /// CHECK: Owner, discriminator, mint pair and vault addresses are checked in the handler.
    #[account(mut)]
    pub orca_whirlpool: UncheckedAccount<'info>,
    #[account(mut)]
    pub orca_token_vault_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub orca_token_vault_b: Account<'info, TokenAccount>,
    /// CHECK: Whirlpool validates the supplied tick-array PDAs and contents.
    #[account(mut, owner = ORCA_PROGRAM_ID)]
    pub orca_tick_array_0: UncheckedAccount<'info>,
    /// CHECK: Whirlpool validates the supplied tick-array PDAs and contents.
    #[account(mut, owner = ORCA_PROGRAM_ID)]
    pub orca_tick_array_1: UncheckedAccount<'info>,
    /// CHECK: Whirlpool validates the supplied tick-array PDAs and contents.
    #[account(mut, owner = ORCA_PROGRAM_ID)]
    pub orca_tick_array_2: UncheckedAccount<'info>,
    /// CHECK: Derived under Orca's fixed program ID.
    #[account(
        mut,
        seeds = [b"oracle", orca_whirlpool.key().as_ref()],
        bump,
        seeds::program = ORCA_PROGRAM_ID
    )]
    pub orca_oracle: UncheckedAccount<'info>,

    /// CHECK: Fixed to the official Devnet Raydium CPMM program ID.
    #[account(address = RAYDIUM_CPMM_PROGRAM_ID)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: Derived using Raydium CPMM's published authority seed.
    #[account(
        seeds = [b"vault_and_lp_mint_auth_seed"],
        bump,
        seeds::program = RAYDIUM_CPMM_PROGRAM_ID
    )]
    pub raydium_authority: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM validates this config against the pool state.
    #[account(owner = RAYDIUM_CPMM_PROGRAM_ID)]
    pub raydium_amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM deserializes and validates this pool state.
    #[account(mut, owner = RAYDIUM_CPMM_PROGRAM_ID)]
    pub raydium_pool_state: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = raydium_input_vault.mint == intermediate_mint.key()
    )]
    pub raydium_input_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = raydium_output_vault.mint == usdc_mint.key()
    )]
    pub raydium_output_vault: Account<'info, TokenAccount>,
    /// CHECK: Raydium CPMM validates this account against the pool state.
    #[account(mut, owner = RAYDIUM_CPMM_PROGRAM_ID)]
    pub raydium_observation_state: UncheckedAccount<'info>,
}

#[account]
pub struct VaultState {
    pub bump: u8,
    pub admin: Pubkey,
    pub bot_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub total_shares: u64,
    pub paused: bool,
}

impl VaultState {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 32 + 8 + 1;
}

#[account]
pub struct UserShares {
    pub owner: Pubkey,
    pub shares: u64,
}

impl UserShares {
    pub const SPACE: usize = 8 + 32 + 8;
}

#[event]
pub struct VaultInitialized {
    pub admin: Pubkey,
    pub bot_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_shares: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_shares: u64,
}

#[event]
pub struct ArbitrageExecuted {
    pub bot: Pubkey,
    pub amount_in: u64,
    pub intermediate_amount: u64,
    pub initial_usdc_balance: u64,
    pub final_usdc_balance: u64,
    pub profit: u64,
}

#[error_code]
pub enum ArbitrageError {
    #[msg("The requested amount must be greater than zero.")]
    ZeroAmount,
    #[msg("The minimum profit must be greater than zero.")]
    ZeroProfitThreshold,
    #[msg("The vault is paused.")]
    VaultPaused,
    #[msg("The bot authority cannot be the default public key.")]
    InvalidBotAuthority,
    #[msg("The account is not the owner of this share position.")]
    InvalidShareOwner,
    #[msg("The deposit is too small to mint at least one share.")]
    DepositTooSmall,
    #[msg("The withdrawal is too small to transfer at least one token unit.")]
    WithdrawalTooSmall,
    #[msg("The requested shares exceed the user's balance.")]
    InsufficientShares,
    #[msg("A vault with assets but no shares cannot accept its first deposit.")]
    AssetsWithoutShares,
    #[msg("The vault has insufficient USDC for this trade.")]
    InsufficientVaultBalance,
    #[msg("No shares have been issued, so arbitrage is disabled.")]
    NoShareholders,
    #[msg("The supplied Orca pool, mint, or vault account is invalid.")]
    InvalidOrcaPool,
    #[msg("A supplied DEX program is not the expected executable program.")]
    InvalidDexProgram,
    #[msg("The realized route did not meet the minimum profitable USDC balance.")]
    ArbitrageUnprofitable,
    #[msg("The intermediate token balance changed unexpectedly.")]
    IntermediateBalanceChanged,
    #[msg("A checked arithmetic operation overflowed or divided by zero.")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_mints_one_share_per_base_unit() {
        assert_eq!(calculate_shares_to_mint(75, 0, 0).unwrap(), 75);
    }

    #[test]
    fn later_deposits_use_current_pool_share_price() {
        // 100 USDC enters a pool with 1,000 USDC backing 500 shares.
        assert_eq!(calculate_shares_to_mint(100, 1_000, 500).unwrap(), 50);
    }

    #[test]
    fn first_deposit_cannot_capture_unowned_vault_assets() {
        assert!(calculate_shares_to_mint(100, 1, 0).is_err());
    }

    #[test]
    fn tiny_deposit_cannot_mint_zero_shares() {
        assert!(calculate_shares_to_mint(1, 1_000, 1).is_err());
    }

    #[test]
    fn partial_withdrawal_uses_realized_profit_in_live_balance() {
        // A 25% share position receives 25% of the current 1,200 balance.
        assert_eq!(calculate_withdrawal_amount(1_200, 1_000, 250).unwrap(), 300);
    }

    #[test]
    fn final_shareholder_receives_all_remaining_units() {
        assert_eq!(
            calculate_withdrawal_amount(1_201, 1_000, 1_000).unwrap(),
            1_201
        );
    }

    #[test]
    fn arbitrage_requires_the_full_configured_profit() {
        assert_eq!(enforce_minimum_profit(1_000, 1_025, 25).unwrap(), 25);
        assert!(enforce_minimum_profit(1_000, 1_024, 25).is_err());
    }

    #[test]
    fn profit_threshold_overflow_fails_closed() {
        assert!(enforce_minimum_profit(u64::MAX, u64::MAX, 1).is_err());
    }
}
