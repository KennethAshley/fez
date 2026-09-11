/** Evaluation children may inspect a wallet; only the host may settle authorized work. */
export function requireWalletMutationAllowed(): void {
  if (process.env.FEZ_EVALUATION_ACTIVE === "1") {
    throw new Error("wallet changes are disabled during agent evaluation — authorized payments must be settled by the host");
  }
}
