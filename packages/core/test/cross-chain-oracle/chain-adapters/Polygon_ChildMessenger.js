const hre = require("hardhat");
const { web3, assertEventEmitted } = hre;
const { getContract } = hre;
const { assert } = require("chai");

const { didContractThrow } = require("@uma/common");

const { deployContractMock } = require("../../helpers/SmockitHelper");

// Tested Contract
const Polygon_ChildMessenger = getContract("Polygon_ChildMessengerMock");

// Create some random accounts to mimic key cross-chain oracle addresses that are not deployed in these tests.
let fxChildAddress, oracleHubAddress, fxRootTunnelAddress, oracleSpokeAddress;

// Re-used variables
let deployer;
let messenger;
let oracleSpokeSmocked;

describe("Polygon_ChildMessenger", function () {
  beforeEach(async () => {
    const accounts = await hre.web3.eth.getAccounts();
    [deployer, fxChildAddress, oracleHubAddress, fxRootTunnelAddress, oracleSpokeAddress] = accounts;

    messenger = await Polygon_ChildMessenger.new(
      fxChildAddress // FxChild is normally a Polygon system contract, but it is unused in this test and can be
      // set to some arbitrary EOA.
    ).send({ from: deployer });
    await messenger.methods.setFxRootTunnel(fxRootTunnelAddress).send({ from: deployer });

    // Child messenger calls `processMessageFromParent()` on this OracleSpoke, so we'll check that its called with the
    // correct input.
    oracleSpokeSmocked = await deployContractMock("OracleSpoke", {}, getContract("OracleSpoke"));
  });
  it("setOracleSpoke", async function () {
    const setter = messenger.methods.setOracleSpoke(oracleSpokeAddress);
    const txn = await setter.send({ from: deployer });
    assert.equal(await messenger.methods.oracleSpoke().call(), oracleSpokeAddress);
    // Cannot call more than once.
    assert(await didContractThrow(setter.send({ from: deployer })));
    await assertEventEmitted(txn, messenger, "SetOracleSpoke", (ev) => {
      return ev.newOracleSpoke === oracleSpokeAddress;
    });
  });
  it("setOracleHub", async function () {
    const setter = messenger.methods.setOracleHub(oracleHubAddress);
    const txn = await setter.send({ from: deployer });
    assert.equal(await messenger.methods.oracleHub().call(), oracleHubAddress);
    // Cannot call more than once.
    assert(await didContractThrow(setter.send({ from: deployer })));
    await assertEventEmitted(txn, messenger, "SetOracleHub", (ev) => {
      return ev.newOracleHub === oracleHubAddress;
    });
  });
  it("sendMessageToParent", async function () {
    await messenger.methods.setOracleSpoke(oracleSpokeAddress).send({ from: deployer });
    await messenger.methods.setOracleHub(oracleHubAddress).send({ from: deployer });

    const dataToSendToParent = "0xdeadbeef";
    const sendMessage = messenger.methods.sendMessageToParent(dataToSendToParent);

    // Callable only by oracle spoke stored in contract.
    assert(await didContractThrow(sendMessage.send({ from: deployer })));

    const txn = await sendMessage.send({ from: oracleSpokeAddress });

    // Check events are emitted
    await assertEventEmitted(txn, messenger, "MessageSentToParent", (ev) => {
      return ev.data === dataToSendToParent && ev.targetHub === oracleHubAddress;
    });
    const expectedMessageSentData = web3.eth.abi.encodeParameters(
      ["bytes", "address"],
      [dataToSendToParent, oracleHubAddress]
    );
    await assertEventEmitted(txn, messenger, "MessageSent", (ev) => {
      return ev.message === expectedMessageSentData;
    });
  });
  it("_processMessageFromRoot", async function () {
    // Data to pass into this method includes: (1) the data to send to the target and (2) the target contract
    // to call `processMessageFromParent` on with the data from (1). We'll use the smocked contract as the target
    // and test that `processMessageFromParent` is called with the encoded data (1).
    const dataToSendToTarget = "0xdeadbeef";
    const data = web3.eth.abi.encodeParameters(
      ["bytes", "address"],
      [dataToSendToTarget, oracleSpokeSmocked.options.address]
    );

    // Even though this is an internal method, this test exists to verify that  `_processMessageFromRoot` is
    // protected by the `validateSender` modifier as implemented on the
    // FxChildBaseTunnel. The `validateSender` modifier reverts if `sender is not the FxRootTunnel set in the
    // contract.
    assert(await didContractThrow(messenger.methods.processMessageFromRoot(deployer, data).send({ from: deployer })));

    const txn = await messenger.methods.processMessageFromRoot(fxRootTunnelAddress, data).send({ from: deployer });

    // Check that oracle spoke is called as expected
    const processMessageFromParentCall = oracleSpokeSmocked.smocked.processMessageFromParent.calls[0];
    assert.equal(processMessageFromParentCall.data, dataToSendToTarget);

    // Check events are emitted
    await assertEventEmitted(txn, messenger, "MessageReceivedFromParent", (ev) => {
      return ev.targetSpoke === oracleSpokeSmocked.options.address && ev.dataToSendToTarget === dataToSendToTarget;
    });
  });
});
