// Description:
// - Add new Contract Creator on Ethereum and/or Polygon.

// Run:
// - For testing, start mainnet fork in one window with `yarn hardhat node --fork <ARCHIVAL_NODE_URL> --no-deploy`
// - (optional, or required if --polygon is not undefined) set POLYGON_NODE_URL to a Polygon mainnet node. This will
//   be used to query contract data from Polygon when relaying proposals through the GovernorRootTunnel.
// - Propose: HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/addContractCreator.js --ethereum 0xabc --polygon 0xdef
// - Vote Simulate: HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/simulateVote.js
// - Verify: HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/addContractCreator.js --verify --ethereum 0xabc --polygon 0xdef
// - For production, set the CUSTOM_NODE_URL environment and run the script with a different `HARDHAT_NETWORK` value,
//   for example: `HARDHAT_NETWORK=mainnet node ./packages/core/scripts/admin-proposals/addContractCreator.js ...`

// Customizations:
// - --polygon param can be omitted, in which case transactions will only take place on Ethereum.
// - --ethereum flag can also be omitted, in which case transactions will only be relayed to Polygon
// - If --verify flag is set, script is assumed to be running after a Vote Simulation and updated contract state is
// verified.

// Examples:
// - Add contract creator on Ethereum only:
//    - `HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/addContractCreator.js --ethereum 0xabc`
// - Add contract creator on Polygon only:
//    - `HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/addContractCreator.js --polygon 0xabc`
// - Add contract creator on both:
//    - `HARDHAT_NETWORK=localhost node ./packages/core/scripts/admin-proposals/addContractCreator.js --ethereum 0xabc --polygon 0xdef`

const hre = require("hardhat");
require("dotenv").config();
const { GasEstimator } = require("@uma/financial-templates-lib");
const Web3 = require("web3");
const winston = require("winston");
const { RegistryRolesEnum, interfaceName } = require("@uma/common");
const { _getContractAddressByName, _impersonateAccounts } = require("./utils");
const argv = require("minimist")(process.argv.slice(), {
  string: [
    // address to add on Ethereum
    "ethereum",
    // address to add on Polygon. Required if --ethereum is omitted
    "polygon",
  ],
  boolean: [
    // set True if verifying, False for proposing.
    "verify",
  ],
  default: { verify: false },
});

// Net ID returned by web3 when connected to a mainnet fork running on localhost.
const HARDHAT_NET_ID = 31337;
// Net ID that this script should simulate with.
const PROD_NET_ID = 1;
// Wallets we need to use to sign transactions.
const REQUIRED_SIGNER_ADDRESSES = { deployer: "0x2bAaA41d155ad8a4126184950B31F50A1513cE25" };

async function run() {
  const { ethereum, polygon, verify } = argv;
  const { getContract, network, web3, assert } = hre;

  // Set up provider so that we can sign from special wallets:
  let netId = await web3.eth.net.getId();
  if (netId === HARDHAT_NET_ID) {
    console.log("🚸 Connected to a local node, attempting to impersonate accounts on forked network 🚸");
    console.table(REQUIRED_SIGNER_ADDRESSES);
    await _impersonateAccounts(network, REQUIRED_SIGNER_ADDRESSES);
    console.log("🔐 Successfully impersonated accounts");
  } else {
    console.log("📛 Connected to a production node 📛");
  }

  // Contract ABI's
  const Registry = getContract("Registry");
  const GovernorRootTunnel = getContract("GovernorRootTunnel");
  const GovernorChildTunnel = getContract("GovernorChildTunnel");
  const Governor = getContract("Governor");
  const Finder = getContract("Finder");
  const Voting = getContract("Voting");

  // Parse comma-delimited CLI params into arrays
  let ethereumContractToRegister = ethereum;
  let polygonContractToRegister = polygon;
  let crossChainWeb3;

  // If polygon address is specified, initialize Governance relay infrastructure contracts
  let polygon_netId;
  let polygon_registry;
  let polygon_governor;
  if (!(polygonContractToRegister || ethereumContractToRegister))
    throw new Error("Must specify either --ethereum or --polygon or both");
  else if (polygonContractToRegister) {
    if (!process.env.POLYGON_NODE_URL)
      throw new Error("If --polygon is defined, you must set a POLYGON_NODE_URL environment variable");
    crossChainWeb3 = new Web3(process.env.POLYGON_NODE_URL);
    polygon_netId = await crossChainWeb3.eth.net.getId();
    polygon_registry = new crossChainWeb3.eth.Contract(
      Registry.abi,
      _getContractAddressByName("Registry", polygon_netId)
    );
    polygon_governor = new crossChainWeb3.eth.Contract(
      GovernorChildTunnel.abi,
      _getContractAddressByName("GovernorChildTunnel", polygon_netId)
    );
  }

  // Initialize Eth contracts by grabbing deployed addresses from networks/1.json file.
  if (netId === HARDHAT_NET_ID) netId = PROD_NET_ID;
  const registry = new web3.eth.Contract(Registry.abi, _getContractAddressByName("Registry", netId));
  const gasEstimator = new GasEstimator(
    winston.createLogger({ silent: true }),
    60, // Time between updates.
    netId
  );
  await gasEstimator.update();
  console.log(
    `⛽️ Current fast gas price for Ethereum: ${web3.utils.fromWei(
      gasEstimator.getCurrentFastPrice().toString(),
      "gwei"
    )} gwei`
  );
  const governor = new web3.eth.Contract(Governor.abi, _getContractAddressByName("Governor", netId));
  const governorRootTunnel = new web3.eth.Contract(
    GovernorRootTunnel.abi,
    _getContractAddressByName("GovernorRootTunnel", netId)
  );
  const finder = new web3.eth.Contract(Finder.abi, _getContractAddressByName("Finder", netId));
  const oracleAddress = await finder.methods
    .getImplementationAddress(web3.utils.utf8ToHex(interfaceName.Oracle))
    .call();
  const oracle = new web3.eth.Contract(Voting.abi, oracleAddress);

  if (polygonContractToRegister) {
    console.group("\nℹ️  Relayer infrastructure for Polygon transactions:");
    console.log(`- Registry @ ${polygon_registry.options.address}`);
    console.log(`- GovernorRootTunnel @ ${governorRootTunnel.options.address}`);
    console.log(`- GovernorChildTunnel @ ${polygon_governor.options.address}`);
    console.groupEnd();
  }
  console.group("\nℹ️  DVM infrastructure for Ethereum transactions:");
  console.log(`- Registry @ ${registry.options.address}`);
  console.log(`- Governor @ ${governor.options.address}`);
  console.groupEnd();

  if (!verify) {
    console.group("\n🌠 Proposing new Admin Proposal");

    const adminProposalTransactions = [];
    console.group("\n Key to understand the following logs:");
    console.log(
      "- 🟣 = Transactions to be submitted to the Polygon contracts are relayed via the GovernorRootTunnel on Etheruem. Look at this test for an example:"
    );
    console.log("    - https://github.com/UMAprotocol/protocol/blob/master/packages/core/test/polygon/e2e.js#L221");
    console.log("- 🟢 = Transactions to be submitted directly to Ethereum contracts.");
    console.groupEnd();
    if (ethereumContractToRegister) {
      console.group(`\n🟢 Adding new contract creator @ ${ethereumContractToRegister}`);
      if (!(await registry.methods.holdsRole(RegistryRolesEnum.CONTRACT_CREATOR, ethereumContractToRegister).call())) {
        const addMemberData = registry.methods
          .addMember(RegistryRolesEnum.CONTRACT_CREATOR, ethereumContractToRegister)
          .encodeABI();
        console.log("- addMemberData", addMemberData);
        adminProposalTransactions.push({ to: registry.options.address, value: 0, data: addMemberData });
      } else {
        console.log("- Contract @ ", ethereumContractToRegister, "is already a contract creator. Nothing to do.");
      }

      console.groupEnd();
    }

    if (polygonContractToRegister) {
      console.group(`\n🟣 (Polygon) Adding new contract creator @ ${polygonContractToRegister}`);

      if (
        !(await polygon_registry.methods
          .holdsRole(RegistryRolesEnum.CONTRACT_CREATOR, polygonContractToRegister)
          .call())
      ) {
        const addMemberData = polygon_registry.methods
          .addMember(RegistryRolesEnum.CONTRACT_CREATOR, polygonContractToRegister)
          .encodeABI();
        console.log("- addMemberData", addMemberData);
        let relayGovernanceData = governorRootTunnel.methods
          .relayGovernance(polygon_registry.options.address, addMemberData)
          .encodeABI();
        console.log("- relayGovernanceData", relayGovernanceData);
        adminProposalTransactions.push({ to: governorRootTunnel.options.address, value: 0, data: relayGovernanceData });
      } else {
        console.log("- Contract @ ", polygonContractToRegister, "is already a contract creator. Nothing to do.");
      }

      console.groupEnd();
    }

    // Send the proposal
    console.group(`\n📨 Sending to governor @ ${governor.options.address}`);
    console.log(`- Admin proposal contains ${adminProposalTransactions.length} transactions`);
    if (adminProposalTransactions.length > 0) {
      const txn = await governor.methods
        .propose(adminProposalTransactions)
        .send({ from: REQUIRED_SIGNER_ADDRESSES["deployer"], gasPrice: gasEstimator.getCurrentFastPrice() });
      console.log("- Transaction: ", txn?.transactionHash);

      // Print out details about new Admin proposal
      const priceRequests = await oracle.getPastEvents("PriceRequestAdded");
      const newAdminRequest = priceRequests[priceRequests.length - 1];
      console.log(
        `- New admin request {identifier: ${
          newAdminRequest.returnValues.identifier
        }, timestamp: ${newAdminRequest.returnValues.time.toString()}}`
      );
    } else {
      console.log("- 0 Transactions in Admin proposal. Nothing to do");
    }
    console.groupEnd();
  } else {
    console.group("\n🔎 Verifying execution of Admin Proposal");
    if (ethereumContractToRegister) {
      assert(
        await registry.methods.holdsRole(RegistryRolesEnum.CONTRACT_CREATOR, ethereumContractToRegister),
        "Contract does not hold creator role"
      );
      console.log(`- Contract @ ${ethereumContractToRegister} holds creator role on Ethereum`);
    }

    if (polygonContractToRegister) {
      const addMemberData = polygon_registry.methods
        .addMember(RegistryRolesEnum.CONTRACT_CREATOR, polygon_governor.options.address)
        .encodeABI();
      const relayedRegistryTransactions = await governorRootTunnel.getPastEvents("RelayedGovernanceRequest", {
        filter: { to: polygon_registry.options.address },
        fromBlock: 0,
      });
      assert(
        relayedRegistryTransactions.find((e) => e.returnValues.data === addMemberData),
        "Could not find RelayedGovernanceRequest matching expected relayed addMemberData transaction"
      );
      console.log(
        `- GovernorRootTunnel correctly emitted events to registry ${polygon_registry.options.address} containing addMember data`
      );
    }
  }
  console.groupEnd();

  console.log("\n😇 Success!");
}

function main() {
  const startTime = Date.now();
  run()
    .catch((err) => {
      console.error(err);
    })
    .finally(() => {
      const timeElapsed = Date.now() - startTime;
      console.log(`Done in ${(timeElapsed / 1000).toFixed(2)}s`);
    });
}
main();
