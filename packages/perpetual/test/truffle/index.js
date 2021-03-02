// Note: This is placed within the /truffle folder because EmpCreator/PerpCreator.new() fails due to incorrect library linking by hardhat.
// `Error: ExpiringMultiPartyCreator contains unresolved libraries. You must deploy and link the following libraries before
//         you can deploy a new version of ExpiringMultiPartyCreator: $585a446ef18259666e65e81865270bd4dc$`
// We should look more into library linking via hardhat within a script: https://hardhat.org/plugins/hardhat-deploy.html#handling-contract-using-libraries
const Main = require("../../index.js");

const winston = require("winston");
const sinon = require("sinon");

const { toWei, utf8ToHex } = web3.utils;

const { SpyTransport, spyLogIncludes, spyLogLevel } = require("@uma/financial-templates-lib");
const { interfaceName, RegistryRolesEnum } = require("@uma/common");
const { getTruffleContract } = require("@uma/core");

const PerpetualCreator = getTruffleContract("PerpetualCreator", web3);
const TokenFactory = getTruffleContract("TokenFactory", web3);
const Finder = getTruffleContract("Finder", web3);
const Store = getTruffleContract("Store", web3);
const IdentifierWhitelist = getTruffleContract("IdentifierWhitelist", web3);
const Token = getTruffleContract("ExpandedERC20", web3);
const AddressWhitelist = getTruffleContract("AddressWhitelist", web3);
const Timer = getTruffleContract("Timer", web3);
const Registry = getTruffleContract("Registry", web3);

contract("index.js", function(accounts) {
  const deployer = accounts[0];

  // Contracts
  let perpFactory;
  let finder;
  let store;
  let timer;
  let identifierWhitelist;
  let collateralWhitelist;
  let tokenFactory;
  let registry;
  let collateral;
  let perpsCreated = [];

  // Offchain infra
  let spyLogger;
  let spy;

  let pollingDelay = 0; // 0 polling delay creates a serverless bot that yields after one full execution.
  let errorRetries = 1;
  let errorRetriesTimeout = 0.1; // 100 milliseconds between preforming retries

  // Default testing values.
  let defaultCreationParams = {
    expirationTimestamp: "1950000000", // Fri Oct 17 2031 10:40:00 GMT+0000
    priceFeedIdentifier: utf8ToHex("Test Identifier"),
    fundingRateIdentifier: utf8ToHex("TEST18DECIMALS"),
    syntheticName: "Test Synth",
    syntheticSymbol: "TEST-SYNTH",
    collateralRequirement: { rawValue: toWei("1.2") },
    disputeBondPercentage: { rawValue: toWei("0.1") },
    sponsorDisputeRewardPercentage: { rawValue: toWei("0.05") },
    disputerDisputeRewardPercentage: { rawValue: toWei("0.04") },
    minSponsorTokens: { rawValue: toWei("10") },
    withdrawalLiveness: "7200",
    liquidationLiveness: "7300",
    tokenScaling: { rawValue: toWei("1") }
  };
  let configStoreParams = {
    timelockLiveness: 86400, // 1 day
    rewardRatePerSecond: { rawValue: toWei("0.000001") },
    proposerBondPercentage: { rawValue: toWei("0.0001") },
    maxFundingRate: { rawValue: toWei("0.00001") },
    minFundingRate: { rawValue: toWei("-0.00001") },
    proposalTimePastLimit: 1800
  };

  before(async function() {
    finder = await Finder.new();
    timer = await Timer.new();
    tokenFactory = await TokenFactory.new();
    perpFactory = await PerpetualCreator.new(finder.address, tokenFactory.address, timer.address);

    // Whitelist an initial identifier so we can deploy.
    identifierWhitelist = await IdentifierWhitelist.new();
    await identifierWhitelist.addSupportedIdentifier(defaultCreationParams.priceFeedIdentifier);
    await identifierWhitelist.addSupportedIdentifier(defaultCreationParams.fundingRateIdentifier);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.IdentifierWhitelist), identifierWhitelist.address);

    store = await Store.new({ rawValue: "0" }, { rawValue: "0" }, timer.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Store), store.address);

    // Add Registry to finder so factories can register contracts.
    registry = await Registry.new();
    await registry.addMember(RegistryRolesEnum.CONTRACT_CREATOR, perpFactory.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Registry), registry.address);

    collateralWhitelist = await AddressWhitelist.new();
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.CollateralWhitelist), collateralWhitelist.address);

    // Use the same collateral for all perps.
    collateral = await Token.new("Wrapped Ether", "WETH", "18");
    await collateralWhitelist.addToWhitelist(collateral.address);
    defaultCreationParams = {
      ...defaultCreationParams,
      collateralAddress: collateral.address
    };

    // Deploy new Perp
    const perpAddress = await perpFactory.createPerpetual.call(defaultCreationParams, configStoreParams, {
      from: deployer
    });
    const perpCreation = await perpFactory.createPerpetual(defaultCreationParams, configStoreParams, {
      from: deployer
    });
    perpsCreated.push({ transaction: perpCreation, address: perpAddress });
  });
  it("Completes one iteration without logging any errors", async function() {
    // We will create a new spy logger, listening for debug events because success logs are tagged with the
    // debug level.
    spy = sinon.spy();
    spyLogger = winston.createLogger({
      level: "debug",
      transports: [new SpyTransport({ level: "debug" }, { spy: spy })]
    });

    await Main.run({
      logger: spyLogger,
      web3,
      perpetualAddress: perpsCreated[0].address,
      pollingDelay,
      errorRetries,
      errorRetriesTimeout
    });

    for (let i = 0; i < spy.callCount; i++) {
      assert.notStrictEqual(spyLogLevel(spy, i), "error");
    }

    // The first log should indicate that the Proposer runner started successfully
    // and auto detected the perpetual's deployed address.
    assert.isTrue(spyLogIncludes(spy, 0, "Perpetual funding rate proposer started"));
    assert.isTrue(spyLogIncludes(spy, 0, perpsCreated[0].address));
    assert.isTrue(spyLogIncludes(spy, spy.callCount - 1, "End of serverless execution loop - terminating process"));
  });
});
