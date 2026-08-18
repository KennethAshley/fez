import { execSync } from "child_process";

/**
 * Wallet / registration helper for Bittensor subnets.
 *
 * Generates (and optionally executes) btcli commands for:
 *   - wallet creation
 *   - subnet registration
 *   - stake addition
 *
 * btcli must be installed locally (`pip install bittensor`).
 */

export interface WalletConfig {
  walletName: string;
  walletHotkey: string;
  walletPath?: string; // default ~/.bittensor/wallets
}

export interface RegistrationCommand {
  description: string;
  command: string;
  requiresSudo: boolean;
}

export class WalletHelper {
  private btcliAvailable: boolean;

  constructor() {
    this.btcliAvailable = this.checkBtcli();
  }

  isAvailable(): boolean {
    return this.btcliAvailable;
  }

  /**
   * Generate the commands needed to register a wallet on a subnet.
   * Does NOT execute them — returns them for the caller to review or run.
   */
  generateRegistrationCommands(config: WalletConfig, netuid: number): RegistrationCommand[] {
    const walletPath = config.walletPath || "~/.bittensor/wallets";
    const base = `btcli`;

    return [
      {
        description: `Create wallet '${config.walletName}' (skip if exists)`,
        command: `${base} wallet create --wallet.name ${config.walletName} --wallet.path ${walletPath}`,
        requiresSudo: false,
      },
      {
        description: `Create hotkey '${config.walletHotkey}' (skip if exists)`,
        command: `${base} wallet create --wallet.name ${config.walletName} --wallet.hotkey ${config.walletHotkey} --wallet.path ${walletPath}`,
        requiresSudo: false,
      },
      {
        description: `Register on subnet ${netuid}`,
        command: `${base} subnet register --wallet.name ${config.walletName} --wallet.hotkey ${config.walletHotkey} --netuid ${netuid} --wallet.path ${walletPath}`,
        requiresSudo: false,
      },
      {
        description: `Check registration status`,
        command: `${base} wallet overview --wallet.name ${config.walletName} --wallet.path ${walletPath}`,
        requiresSudo: false,
      },
    ];
  }

  /**
   * Generate stake command for a subnet.
   */
  generateStakeCommand(config: WalletConfig, netuid: number, amount: number): RegistrationCommand {
    const walletPath = config.walletPath || "~/.bittensor/wallets";
    return {
      description: `Stake ${amount} TAO on subnet ${netuid}`,
      command: `btcli stake add --wallet.name ${config.walletName} --wallet.hotkey ${config.walletHotkey} --netuid ${netuid} --amount ${amount} --wallet.path ${walletPath}`,
      requiresSudo: false,
    };
  }

  /**
   * Execute a btcli command. Only use after user confirmation.
   */
  runCommand(command: string): { stdout: string; stderr: string } {
    try {
      const stdout = execSync(command, {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000, // 2 min for btcli ops
      });
      return { stdout, stderr: "" };
    } catch (err) {
      const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
      return { stdout: "", stderr };
    }
  }

  /**
   * Check if a wallet is registered on a subnet by parsing btcli output.
   */
  checkRegistration(config: WalletConfig, netuid: number): { registered: boolean; details?: string } {
    if (!this.btcliAvailable) {
      return { registered: false, details: "btcli not available" };
    }

    const walletPath = config.walletPath || "~/.bittensor/wallets";
    const cmd = `btcli wallet overview --wallet.name ${config.walletName} --wallet.path ${walletPath}`;

    try {
      const output = execSync(cmd, { stdio: "pipe", encoding: "utf-8", timeout: 30_000 });
      // Look for the netuid in the output table
      const registered = output.includes(` ${netuid} `) || output.includes(`|${netuid}|`);
      return { registered, details: output.slice(0, 500) };
    } catch (err) {
      return {
        registered: false,
        details: `failed to check: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private checkBtcli(): boolean {
    try {
      execSync("btcli --version", { stdio: "pipe", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
