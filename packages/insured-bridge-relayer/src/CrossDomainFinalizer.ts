import Web3 from "web3";
const { toBN } = Web3.utils;

import winston from "winston";

import { createEtherscanLinkMarkdown, createFormatFunction, PublicNetworks } from "@uma/common";
import { getAbi } from "@uma/contracts-node";
import { InsuredBridgeL1Client, InsuredBridgeL2Client, GasEstimator } from "@uma/financial-templates-lib";

import type { BN } from "@uma/common";

export class CrossDomainFinalizer {
  constructor(
    readonly logger: winston.Logger,
    readonly gasEstimator: GasEstimator,
    readonly l1Client: InsuredBridgeL1Client,
    readonly l2Client: InsuredBridgeL2Client,
    readonly account: string,
    readonly crossDomainFinalizationThreshold: number = 5
  ) {}
  async checkForBridgeableL2TokensAndBridge() {
    this.logger.debug({ at: "AcrossRelayer#CrossDomainFinalizer", message: "Checking bridgeable L2 tokens" });

    // Fetch all WhitelistToken events on L1 and filter out the ones that are not on the associated L2Client
    // chainId.
    const whitelistedTokenMappings = this.l1Client.getWhitelistedTokensForChainId(this.l2Client.chainId.toString());

    // Extract the l2Tokens that have been whitelisted. `whitelistedTokenMappings` is a key-value dictionary of L1 to
    // L2 token addresses so we'll extract just the values.
    const whitelistedL2Tokens = Object.values(whitelistedTokenMappings);

    // Check if any of the whitelisted l2Tokens are bridgeable. Do this in one parallel call. Returns an array of bool
    // for each l2Token, describing if it can be bridged from L2->L1.
    const canBridge = await Promise.all(
      whitelistedL2Tokens.map((l2Token) => this.l2Client.bridgeDepositBox.methods.canBridge(l2Token).call())
    );

    // For each canBridge result, check if it is true. If so, then we can bridge the token.
    const bridgeableL2Tokens = whitelistedL2Tokens.filter((_, index) => canBridge[index]);

    // Finally, iterate over the bridgeable l2Tokens and bridge them.
    if (bridgeableL2Tokens.length == 0) {
      this.logger.debug({ at: "AcrossRelayer#CrossDomainFinalizer", message: "No bridgeable L2 tokens" });
      return;
    }
    // Track the account nonce and manually increment on each TX. We need to do this because the L2 transactions
    // process quicker than the infura node updates and we need to avoid the nonce collision.
    let nonce = await this.l2Client.l2Web3.eth.getTransactionCount(this.account);
    for (const l2Token of bridgeableL2Tokens) {
      // For each bridgeable L2Token, check the balance in the deposit box. If it is greater than
      // crossDomainFinalizationThreshold, as a percentage, then we can bridge it.

      try {
        const { symbol, decimals, l2PoolBalance } = await this._getL2TokenInfo(l2Token);
        const l1PoolReserves = await this._getL1PoolReserves(l2Token);

        if (l2PoolBalance.gt(toBN(this.crossDomainFinalizationThreshold).mul(l1PoolReserves).div(toBN(100)))) {
          this.logger.debug({
            at: "AcrossRelayer#CrossDomainFinalizer",
            message: "L2 balance > cross domain finalization threshold % of L1 pool reserves, bridging",
            l2Token,
            l2PoolBalance: l2PoolBalance.toString(),
            l1PoolReserves: l1PoolReserves.toString(),
            crossDomainFinalizationThresholdPercent: this.crossDomainFinalizationThreshold,
          });
          await this._bridgeL2Token(l2Token, nonce, symbol, decimals);
          nonce++; // increment the nonce for the next transaction.
        } else {
          this.logger.debug({
            at: "AcrossRelayer#CrossDomainFinalizer",
            message: "L2 balance <= cross domain finalization threshold % of L1 pool reserves, skipping",
            l2Token,
            l2PoolBalance: l2PoolBalance.toString(),
            l1PoolReserves: l1PoolReserves.toString(),
            crossDomainFinalizationThresholdPercent: this.crossDomainFinalizationThreshold,
          });
        }
      } catch (error) {
        this.logger.error({
          at: "AcrossRelayer#CrossDomainFinalizer",
          message: "Something errored sending tokens over the canonical bridge!",
          error,
        });
      }
    }
  }
  // TODO
  // async checkForFinalizedCanonicalRelaysAndFinalize() {}

  // Bridged L2 tokens and returns the current account nonce after the transaction.
  private async _bridgeL2Token(l2Token: string, nonce: number, symbol: string, decimals: number) {
    // Note that this tx sending method is NOT using TransactionUtils runTransaction as it is not required on L2.
    // Provide the nonce manually. Web3.js will increment it for us normally but it struggle with doing thins on L2s.
    const receipt = await this.l2Client.bridgeDepositBox.methods
      .bridgeTokens(l2Token, "0") // The second term in this function call is l2Gas, which is currently unused.
      .send({ from: this.account, nonce });

    if (receipt.events) {
      const tokensSent = receipt.events.TokensBridged.returnValues.numberOfTokensBridged;
      this.logger.info({
        at: "AcrossRelayer#CrossDomainFinalizer",
        message: `${symbol} sent over ${PublicNetworks[this.l2Client.chainId]?.name} bridge! 🌁`,
        mrkdwn:
          createFormatFunction(2, 4, false, decimals)(tokensSent) +
          " " +
          symbol +
          " was sent over the canonical " +
          PublicNetworks[this.l2Client.chainId]?.name +
          " bridge. tx: " +
          createEtherscanLinkMarkdown(receipt.transactionHash, this.l2Client.chainId),
      });
    }
  }

  // Fetch info about a token on L2.
  private async _getL2TokenInfo(l2Token: string): Promise<{ symbol: string; decimals: number; l2PoolBalance: BN }> {
    const l2TokenInstance = new this.l2Client.l2Web3.eth.Contract(getAbi("ERC20"), l2Token);

    const [symbol, decimals, l2PoolBalance] = await Promise.all([
      l2TokenInstance.methods.symbol().call(),
      l2TokenInstance.methods.decimals().call(),
      l2TokenInstance.methods.balanceOf(this.l2Client.bridgeDepositBox.options.address).call(),
    ]);

    return { symbol, decimals, l2PoolBalance: toBN(l2PoolBalance) };
  }

  // Fetch L1 pool reserves for a given l2Token.
  private async _getL1PoolReserves(l2Token: string): Promise<BN> {
    const bridgePool = this.l1Client.getBridgePoolForL2Token(l2Token, this.l2Client.chainId.toString()).contract;

    const [liquidReserves, utilizedReserves] = await Promise.all([
      bridgePool.methods.liquidReserves().call(),
      bridgePool.methods.utilizedReserves().call(),
    ]);
    return toBN(liquidReserves).add(toBN(utilizedReserves));
  }
}
