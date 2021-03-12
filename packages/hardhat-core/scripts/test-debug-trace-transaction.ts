import { assert } from "chai";

import { BackwardsCompatibilityProviderAdapter } from "../src/internal/core/providers/backwards-compatibility";
import { ForkConfig } from "../src/internal/hardhat-network/provider/node-types";
import { RpcDebugTraceOutput } from "../src/internal/hardhat-network/provider/output";
import { HardhatNetworkProvider } from "../src/internal/hardhat-network/provider/provider";
import { makeForkClient } from "../src/internal/hardhat-network/provider/utils/makeForkClient";
import { EthereumProvider } from "../src/types";
import { FORK_TESTS_CACHE_PATH } from "../test/internal/hardhat-network/helpers/constants";

import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNTS_ADDRESSES,
  DEFAULT_ALLOW_UNLIMITED_CONTRACT_SIZE,
  DEFAULT_CHAIN_ID,
  DEFAULT_HARDFORK,
  DEFAULT_NETWORK_ID,
  DEFAULT_NETWORK_NAME,
  PROVIDERS,
} from "../test/internal/hardhat-network/helpers/providers";
import { sendDummyTransaction } from "../test/internal/hardhat-network/helpers/sendDummyTransaction";
import { deployContract } from "../test/internal/hardhat-network/helpers/transactions";

async function main(rpcUrl: string, txHash: string, blockNumber: string) {
  const forkConfig: ForkConfig = {
    jsonRpcUrl: rpcUrl,
    blockNumber: +blockNumber,
  };

  const { forkClient } = await makeForkClient(forkConfig);

  const txHashBuffer = Buffer.from(strip0x(txHash), "hex")

  // const { blockHash } = await forkClient.getTransactionByHash(
  //   Buffer.from(strip0x(txHash), "hex")
  // );
  //
  // const block = await forkClient.getBlockByHash(blockHash);

  const hardhatNetworkProvider = new HardhatNetworkProvider(
    DEFAULT_HARDFORK,
    DEFAULT_NETWORK_NAME,
    DEFAULT_CHAIN_ID,
    DEFAULT_NETWORK_ID,
    100000000,
    true,
    true,
    false, // mining.auto
    0, // mining.interval
    DEFAULT_ACCOUNTS,
    undefined,
    undefined,
    DEFAULT_ALLOW_UNLIMITED_CONTRACT_SIZE,
    undefined,
    undefined,
    forkConfig,
    FORK_TESTS_CACHE_PATH
  );

  const provider = new BackwardsCompatibilityProviderAdapter(
    hardhatNetworkProvider
  );

  const trace: RpcDebugTraceOutput = await provider.send(
    "debug_traceTransaction",
    [add0x(txHash)]
  );

  const expectedTrace = await forkClient.getDebugTraceTransaction(txHashBuffer)

  assertEqualTraces(expectedTrace, trace)
}

const rpcUrlArg = process.argv[2];
const txHashArg = process.argv[3];
const blockNumberArg = process.argv[4];

if (rpcUrlArg === undefined) {
  console.warn("No rpcUrl given");
  usage();
}
if (txHashArg === undefined) {
  console.warn("No txHash given");
  usage();
}
if (blockNumberArg === undefined) {
  console.warn("No blockNumber given");
  usage();
}

main(rpcUrlArg, txHashArg, blockNumberArg)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

function usage() {
  console.warn(
    "ts-node test-debug-trace-transaction.ts <rpcUrl> <txHash> <blockNumber>"
  );
  process.exit(1);
}

function add0x(s: string) {
  return s.toLowerCase().startsWith("0x") ? s : `0x${s}`;
}

function strip0x(s: string) {
  return s.toLowerCase().startsWith("0x") ? s.slice(2) : s;
}

function assertEqualTraces(
  expected: RpcDebugTraceOutput,
  actual: RpcDebugTraceOutput
) {
  assert.equal(expected.failed, actual.failed);
  assert.equal(expected.gas, actual.gas);
  // assert.equal(expected.returnValue, actual.returnValue);

  assert.equal(expected.structLogs.length, actual.structLogs.length);

  for (const [i, log] of expected.structLogs.entries()) {
    assert.deepEqual(
      log,
      actual.structLogs[i],
      `Different logs at ${i} (opcode: ${log.op}, gas: ${log.gas})`
    );
  }
}
