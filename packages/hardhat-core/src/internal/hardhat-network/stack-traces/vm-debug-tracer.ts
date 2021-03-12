import VM from "@nomiclabs/ethereumjs-vm";
import { EVMResult } from "@nomiclabs/ethereumjs-vm/dist/evm/evm";
import { InterpreterStep } from "@nomiclabs/ethereumjs-vm/dist/evm/interpreter";
import { Transaction } from "ethereumjs-tx";
import { BN, toBuffer } from "ethereumjs-util";
import type MapValuesT from "lodash/mapValues";

import { RpcDebugTracingConfig } from "../provider/input";
import { RpcDebugTraceOutput, RpcStructLog } from "../provider/output";

// tslint:disable only-hardhat-error

export class VMDebugTracer {
  private _enabled = false;
  private _structLogs: RpcStructLog[] = [];
  private _lastTrace?: RpcDebugTraceOutput;
  private _config: RpcDebugTracingConfig;

  // update memory from vm instead of previous step
  private _dumpMemory = false;

  private _resetStorage = false;

  // FVTODO
  private _foos: number[] = [];

  constructor(private readonly _vm: VM) {
    this._afterMessageHandler = this._afterMessageHandler.bind(this);
    this._beforeTxHandler = this._beforeTxHandler.bind(this);
    this._stepHandler = this._stepHandler.bind(this);
    this._afterTxHandler = this._afterTxHandler.bind(this);
  }

  /**
   * Run the `cb` callback and trace its execution
   */
  public async trace(
    action: () => Promise<void>,
    config: RpcDebugTracingConfig
  ): Promise<RpcDebugTraceOutput> {
    try {
      this._enableTracing(config);
      await action();
      return this._getDebugTrace();
    } finally {
      this._disableTracing();
    }
  }

  private _enableTracing(config: RpcDebugTracingConfig) {
    if (this._enabled) {
      return;
    }
    this._vm.on("beforeTx", this._beforeTxHandler);
    this._vm.on("step", this._stepHandler);
    this._vm.on("afterMessage", this._afterMessageHandler);
    this._vm.on("afterTx", this._afterTxHandler);
    this._enabled = true;
    this._config = config;
  }

  private _disableTracing() {
    if (!this._enabled) {
      return;
    }
    this._vm.removeListener("beforeTx", this._beforeTxHandler);
    this._vm.removeListener("step", this._stepHandler);
    this._vm.removeListener("afterTx", this._afterTxHandler);
    this._vm.removeListener("afterMessage", this._afterMessageHandler);
    this._enabled = false;
    this._config = undefined;
  }

  private _getDebugTrace(): RpcDebugTraceOutput {
    if (this._lastTrace === undefined) {
      throw new Error(
        "No debug trace available. Please run the transaction first"
      );
    }
    return this._lastTrace;
  }

  private async _beforeTxHandler(_tx: Transaction, next: any) {
    this._structLogs = [];
    next();
  }

  private async _afterMessageHandler(result: EVMResult, next: any) {
    const logToUpdateIndex = this._foos.pop();

    if (logToUpdateIndex === undefined) {
      return next();
      // throw new Error("should never happen?") // FVTODO
    }

    const logToUpdate = this._structLogs[logToUpdateIndex];
    // FVTODO should we subtract gas refund?
    logToUpdate.gasCost +=
      result.gasUsed.toNumber() + (result.execResult.gas?.toNumber() ?? 0);

    next();
  }

  private async _stepHandler(step: InterpreterStep, next: any) {
    const structLog = await this._stepToStructLog(
      step,
      this._structLogs?.[this._structLogs.length - 1]
    );
    this._structLogs.push(structLog);
    next();
  }

  private async _afterTxHandler(result: EVMResult, next: any) {
    this._lastTrace = {
      gas: result.gasUsed.toNumber(),
      failed: result.execResult.exceptionError !== undefined,
      returnValue: result.execResult.returnValue.toString("hex"),
      structLogs: this._structLogs,
    };
    next();
  }

  private _getMemory(step: InterpreterStep): string[] {
    const memory = Buffer.from(step.memory)
      .toString("hex")
      .match(/.{1,64}/g);
    return memory === null ? [] : memory;
  }

  private _getStack(step: InterpreterStep): string[] | undefined {
    if (this._config?.disableStack === true) {
      return undefined;
    }
    const stack = step.stack
      .slice()
      .map((el: BN) => el.toString("hex").padStart(64, "0"));
    return stack;
  }

  private _getStorage(
    storage: Record<string, string>
  ): Record<string, string> | undefined {
    const mapValues: typeof MapValuesT = require("lodash/mapValues");
    if (this._config?.disableStorage === true) {
      return undefined;
    }
    const paddedStorage = mapValues(storage, (storageValue) =>
      storageValue.padStart(64, "0")
    );
    return paddedStorage;
  }

  private async _stepToStructLog(
    step: InterpreterStep,
    previousStructLog?: RpcStructLog
  ): Promise<RpcStructLog> {
    const currentStorage = previousStructLog?.storage ?? {};
    const currentMemory = previousStructLog?.memory ?? [];

    let storage = {
      ...currentStorage,
    };

    if (this._resetStorage) {
      storage = {};
      this._resetStorage = false;
    }

    // FVTODO if (this._config?.disableMemory !== true) {
    let memory = [...currentMemory];

    if (this._dumpMemory) {
      if (previousStructLog !== undefined) {
        memory = this._getMemory(step);
      }
      this._dumpMemory = false;
    }

    let gasCost = step.opcode.fee;

    if (step.opcode.name === "SLOAD" && step.stack.length >= 1) {
      const address = step.address;
      const key = toBuffer(step.stack[step.stack.length - 1]);

      const storageValue = await new Promise<Buffer>((resolve, reject) => {
        step.stateManager.getContractStorage(
          address,
          key,
          (err: Error | null, result: Buffer) => {
            if (err !== null) {
              return reject(result);
            }

            return resolve(result);
          }
        );
      });

      storage[key.toString("hex").padStart(64, "0")] = storageValue
        .toString("hex")
        .padStart(64, "0");
    } else if (step.opcode.name === "SSTORE" && step.stack.length >= 2) {
      const key = toBuffer(step.stack[step.stack.length - 1]);
      const storageValue = toBuffer(step.stack[step.stack.length - 2]);

      storage[key.toString("hex").padStart(64, "0")] = storageValue
        .toString("hex")
        .padStart(64, "0");
    } else if (step.opcode.name === "MSTORE") {
      const memoryPosition = divUp(
        step.stack[step.stack.length - 1],
        32
      ).toNumber();

      const memoryExpansion = expandMemory(memory, memoryPosition + 1);
      gasCost += memoryExpansion * 3;

      this._dumpMemory = true;
    } else if (step.opcode.name === "SHA3" && step.stack.length >= 2) {
      const size = divUp(step.stack[step.stack.length - 2], 32).toNumber();
      gasCost += 6 * size;
    } else if (
      (step.opcode.name === "CALLDATACOPY" ||
        step.opcode.name === "CODECOPY") &&
      step.stack.length >= 3
    ) {
      const memoryPosition = step.stack[step.stack.length - 1];
      const copied = step.stack[step.stack.length - 3];

      const wordsCopied = divUp(copied, 32).toNumber();

      const lastMemoryWordPosition = memoryPosition
        .add(copied)
        .subn(1)
        .divn(32)
        .toNumber();

      const memoryExpansion = expandMemory(memory, lastMemoryWordPosition + 1);
      gasCost += memoryExpansion * 3 + wordsCopied * 3;

      this._dumpMemory = true;
    } else if (step.opcode.name === "STATICCALL") {
      const inPosition = step.stack[step.stack.length - 3];
      const inSize = step.stack[step.stack.length - 4];
      const outPosition = step.stack[step.stack.length - 5];
      const outSize = step.stack[step.stack.length - 6];

      const lastMemoryWordPositionIn = inPosition
        .add(inSize)
        .subn(1)
        .divn(32)
        .toNumber();
      const lastMemoryWordPositionOut = outPosition
        .add(outSize)
        .subn(1)
        .divn(32)
        .toNumber();

      const lastMemoryWordPosition = Math.max(
        lastMemoryWordPositionIn,
        lastMemoryWordPositionOut
      );

      const memoryExpansion = expandMemory(memory, lastMemoryWordPosition + 1);
      gasCost += memoryExpansion * 3;

      this._foos.push(this._structLogs.length);
      this._dumpMemory = true;
    } else if (step.opcode.name === "RETURN") {
      this._dumpMemory = true;
      this._resetStorage = true;
    } else if (step.opcode.name === "REVERT") {
      const memoryPosition = step.stack[step.stack.length - 1];
      const size = step.stack[step.stack.length - 2];

      const lastMemoryWordPosition = memoryPosition
        .add(size)
        .subn(1)
        .divn(32)
        .toNumber();
      const memoryExpansion = expandMemory(memory, lastMemoryWordPosition + 1);
      gasCost += memoryExpansion * 3;
    }

    const structLog: RpcStructLog = {
      pc: step.pc,
      op: step.opcode.name,
      gas: step.gasLeft.toNumber(),
      gasCost,
      depth: step.depth + 1,
      stack: this._getStack(step),
      memory,
      storage,
      // memSize: step.memoryWordCount.toNumber(),
    };

    return structLog;
  }
}

/**
 * Expands memory until its length is `size`. Returns the number of
 * words that were added. Does nothing and returns 0 if memory already
 * has that size or bigger.
 */
function expandMemory(memory: string[], size: number): number {
  if (memory.length >= size) {
    return 0;
  }

  const expandBy = size - memory.length;

  for (let i = 0; i < expandBy; i++) {
    memory.push("0".repeat(64));
  }

  return expandBy;
}

function divUp(x: BN, y: number): BN {
  return x.modn(y) === 0 ? x.divn(y) : x.divn(y).addn(1);
}
