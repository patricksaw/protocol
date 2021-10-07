// This module is used to monitor a API endpoint serving known contract addresses and their expirations.

const { createEtherscanLinkMarkdown } = require("@uma/common");

class ApiMonitor {
  /**
   * @param {Object} logger Winston module used to send logs.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {String} apiEndpoint API endpoint to monitor.
   * @param {Integer} maxTimeTillExpiration Period in seconds to look for upcoming contract expirations.
   */
  constructor({ logger, networker, getTime, apiEndpoint, maxTimeTillExpiration }) {
    this.logger = logger;
    this.networker = networker;
    this.getTime = getTime;
    this.apiEndpoint = apiEndpoint;
    this.maxTimeTillExpiration = maxTimeTillExpiration;
  }

  async checkUpcomingExpirations() {
    this.logger.debug({
      at: "ApiMonitor",
      message: "Checking for upcoming expirations",
      maxTimeTillExpiration: this.maxTimeTillExpiration,
    });

    const expirationPeriod =
      this.maxTimeTillExpiration > 259200
        ? parseInt(this.maxTimeTillExpiration / 86400) + " days"
        : parseInt(this.maxTimeTillExpiration / 3600) + " hours";

    const currentTime = await this.getTime();
    const apiUrl = this.apiEndpoint + "/global/listActive";
    const activeContracts = await this.networker.getJson(apiUrl, { method: "post" });
    const expiringContracts = activeContracts
      .map((contract) => {
        if (!contract.type || !contract.expirationTimestamp) {
          return null;
        }
        let tokenName;
        if (contract.type === "emp") {
          tokenName = contract.tokenName;
        } else if (contract.type === "lsp") {
          tokenName = contract.longTokenName;
        } else {
          tokenName = "";
        }
        const expirationUtcString = new Date(contract.expirationTimestamp * 1000).toUTCString();
        return {
          address: contract.address,
          expirationTimestamp: contract.expirationTimestamp,
          tokenName: tokenName,
          expirationUtcString: expirationUtcString,
        };
      })
      .filter((contract) => {
        return (
          contract &&
          contract.expirationTimestamp - currentTime <= this.maxTimeTillExpiration &&
          contract.expirationTimestamp > currentTime
        );
      });

    let mrkdwn = `Following contracts are expiring in ${expirationPeriod}:`;
    for (let contract of expiringContracts) {
      // UMA API currently supports only Ethereum mainnet, thus chainId of 1 is hardcoded here:
      mrkdwn =
        mrkdwn +
        `\n- ${createEtherscanLinkMarkdown(contract.address, 1)}:` +
        ` ${contract.tokenName}` +
        ` is expiring on ${contract.expirationUtcString}`;
    }
    if (expiringContracts.length) {
      this.logger.info({
        at: "ApiMonitor",
        message: "Expiring contracts reminder 🔔",
        mrkdwn,
        notificationPath: "dev-x",
      });
    }
  }
}

module.exports = { ApiMonitor };
