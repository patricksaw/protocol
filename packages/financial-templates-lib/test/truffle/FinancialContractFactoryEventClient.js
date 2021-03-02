// Note: This is placed within the /truffle folder because EmpCreator/PerpCreator.new() fails due to incorrect library linking by hardhat.
// `Error: ExpiringMultiPartyCreator contains unresolved libraries. You must deploy and link the following libraries before
//         you can deploy a new version of ExpiringMultiPartyCreator: $585a446ef18259666e65e81865270bd4dc$`
// We should look more into library linking via hardhat within a script: https://hardhat.org/plugins/hardhat-deploy.html#handling-contract-using-libraries

const winston = require("winston");

const { toWei, utf8ToHex } = web3.utils;

const { FinancialContractFactoryEventClient } = require("../../src/clients/FinancialContractFactoryEventClient");
const { interfaceName, advanceBlockAndSetTime, ZERO_ADDRESS, RegistryRolesEnum } = require("@uma/common");
const { getTruffleContract } = require("@uma/core");

const ExpiringMultiPartyCreator = getTruffleContract("ExpiringMultiPartyCreator", web3);
const PerpetualCreator = getTruffleContract("PerpetualCreator", web3);
const TokenFactory = getTruffleContract("TokenFactory", web3);
const Finder = getTruffleContract("Finder", web3);
const IdentifierWhitelist = getTruffleContract("IdentifierWhitelist", web3);
const Token = getTruffleContract("ExpandedERC20", web3);
const AddressWhitelist = getTruffleContract("AddressWhitelist", web3);
const Timer = getTruffleContract("Timer", web3);
const Registry = getTruffleContract("Registry", web3);

contract("FinancialContractFactoryEventClient.js", function(accounts) {
  const deployer = accounts[0];

  // Contracts
  let empFactory;
  let perpFactory;
  let finder;
  let timer;
  let identifierWhitelist;
  let collateralWhitelist;
  let tokenFactory;
  let registry;
  let collateral;
  let empsCreated = [];
  let perpsCreated = [];

  // Bot helper modules
  let perpClient, empClient;
  let dummyLogger;

  // Default testing values.
  let defaultCreationParams = {
    expirationTimestamp: "1950000000", // Fri Oct 17 2031 10:40:00 GMT+0000
    priceFeedIdentifier: utf8ToHex("Test Identifier"),
    syntheticName: "Test Synth",
    syntheticSymbol: "TEST-SYNTH",
    collateralRequirement: { rawValue: toWei("1.2") },
    disputeBondPercentage: { rawValue: toWei("0.1") },
    sponsorDisputeRewardPercentage: { rawValue: toWei("0.05") },
    disputerDisputeRewardPercentage: { rawValue: toWei("0.04") },
    minSponsorTokens: { rawValue: toWei("10") },
    withdrawalLiveness: "7200",
    liquidationLiveness: "7300"
  };
  let defaultEmpCreationParams;
  let defaultPerpCreationParams;
  let configStoreParams = {
    timelockLiveness: 86400, // 1 day
    rewardRatePerSecond: { rawValue: toWei("0.000001") },
    proposerBondPercentage: { rawValue: toWei("0.0001") },
    maxFundingRate: { rawValue: toWei("0.00001") },
    minFundingRate: { rawValue: toWei("-0.00001") },
    proposalTimePastLimit: 1800
  };

  const deployNewContract = async type => {
    if (type === "Perpetual") {
      const perpAddress = await perpFactory.createPerpetual.call(defaultPerpCreationParams, configStoreParams, {
        from: deployer
      });
      const perpCreation = await perpFactory.createPerpetual(defaultPerpCreationParams, configStoreParams, {
        from: deployer
      });
      perpsCreated.push({ transaction: perpCreation, address: perpAddress });
    } else {
      const empAddress = await empFactory.createExpiringMultiParty.call(defaultEmpCreationParams, { from: deployer });
      const empCreation = await empFactory.createExpiringMultiParty(defaultEmpCreationParams, { from: deployer });
      empsCreated.push({ transaction: empCreation, address: empAddress });
    }
  };

  before(async function() {
    finder = await Finder.new();
    timer = await Timer.new();
    tokenFactory = await TokenFactory.new();
    empFactory = await ExpiringMultiPartyCreator.new(finder.address, tokenFactory.address, timer.address);
    perpFactory = await PerpetualCreator.new(finder.address, tokenFactory.address, timer.address);

    // Whitelist an initial identifier so we can deploy.
    identifierWhitelist = await IdentifierWhitelist.new();
    await identifierWhitelist.addSupportedIdentifier(defaultCreationParams.priceFeedIdentifier);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.IdentifierWhitelist), identifierWhitelist.address);

    // Create and whitelist collateral so we can deploy.
    collateralWhitelist = await AddressWhitelist.new();
    collateral = await Token.new("Wrapped Ether", "WETH", 18);
    await collateralWhitelist.addToWhitelist(collateral.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.CollateralWhitelist), collateralWhitelist.address);

    // Add collateral to default param
    defaultCreationParams = {
      ...defaultCreationParams,
      collateralAddress: collateral.address
    };
    defaultEmpCreationParams = {
      ...defaultCreationParams,
      financialProductLibraryAddress: ZERO_ADDRESS
    };
    defaultPerpCreationParams = {
      ...defaultCreationParams,
      fundingRateIdentifier: utf8ToHex("Test Funding Rate Identifier"),
      tokenScaling: { rawValue: toWei("1") }
    };

    // Add Registry to finder so factories can register contracts.
    registry = await Registry.new();
    await registry.addMember(RegistryRolesEnum.CONTRACT_CREATOR, empFactory.address);
    await registry.addMember(RegistryRolesEnum.CONTRACT_CREATOR, perpFactory.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Registry), registry.address);

    // Create new financial contracts:
    await deployNewContract("ExpiringMultiParty");
    await deployNewContract("Perpetual");

    // The Event client does not emit any info `level` events.  Therefore no need to test Winston outputs.
    // DummyLogger will not print anything to console as only capture `info` level events.
    dummyLogger = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Console()]
    });
  });
  it("createdExpiringMultiParty", async function() {
    empClient = new FinancialContractFactoryEventClient(
      dummyLogger,
      ExpiringMultiPartyCreator.abi,
      web3,
      empFactory.address,
      0, // startingBlockNumber
      null, // endingBlockNumber
      "ExpiringMultiParty"
    );

    await empClient.clearState();

    // State is empty before update().
    assert.deepStrictEqual([], empClient.getAllCreatedContractEvents());

    await empClient.update();
    assert.deepStrictEqual(
      [
        {
          transactionHash: empsCreated[0].transaction.tx,
          blockNumber: empsCreated[0].transaction.receipt.blockNumber,
          deployerAddress: deployer,
          contractAddress: empsCreated[0].address
        }
      ],
      empClient.getAllCreatedContractEvents()
    );

    // Correctly adds only new events after last query
    await deployNewContract("ExpiringMultiParty");
    await empClient.clearState();
    await empClient.update();
    assert.deepStrictEqual(
      [
        {
          transactionHash: empsCreated[1].transaction.tx,
          blockNumber: empsCreated[1].transaction.receipt.blockNumber,
          deployerAddress: deployer,
          contractAddress: empsCreated[1].address
        }
      ],
      empClient.getAllCreatedContractEvents()
    );
  });
  it("createdPerpetual", async function() {
    perpClient = new FinancialContractFactoryEventClient(
      dummyLogger,
      PerpetualCreator.abi,
      web3,
      perpFactory.address,
      0, // startingBlockNumber
      null, // endingBlockNumber
      "Perpetual"
    );

    await perpClient.clearState();

    // State is empty before update().
    assert.deepStrictEqual([], perpClient.getAllCreatedContractEvents());

    await perpClient.update();
    assert.deepStrictEqual(
      [
        {
          transactionHash: perpsCreated[0].transaction.tx,
          blockNumber: perpsCreated[0].transaction.receipt.blockNumber,
          deployerAddress: deployer,
          contractAddress: perpsCreated[0].address
        }
      ],
      perpClient.getAllCreatedContractEvents()
    );

    // Correctly adds only new events after last query
    await deployNewContract("Perpetual");
    await perpClient.clearState();
    await perpClient.update();
    assert.deepStrictEqual(
      [
        {
          transactionHash: perpsCreated[1].transaction.tx,
          blockNumber: perpsCreated[1].transaction.receipt.blockNumber,
          deployerAddress: deployer,
          contractAddress: perpsCreated[1].address
        }
      ],
      perpClient.getAllCreatedContractEvents()
    );
  });
  it("Starting client at an offset block number", async function() {
    // Init the event client with an offset block number. If the current block number is used then all log events
    // generated before the creation of the client should not be included. Rather, only subsequent logs should be reported.

    const currentBlockNumber = await web3.eth.getBlockNumber();
    const offsetClient = new FinancialContractFactoryEventClient(
      dummyLogger,
      PerpetualCreator.abi,
      web3,
      perpFactory.address,
      currentBlockNumber + 1, // Start the bot one block after the latest event
      null, // endingBlockNumber
      "Perpetual"
    );
    const currentTimestamp = (await web3.eth.getBlock("latest")).timestamp;
    await advanceBlockAndSetTime(web3, currentTimestamp + 1);
    await advanceBlockAndSetTime(web3, currentTimestamp + 2);
    await advanceBlockAndSetTime(web3, currentTimestamp + 3);

    await offsetClient.update();

    assert.deepStrictEqual([], offsetClient.getAllCreatedContractEvents());
  });
});
