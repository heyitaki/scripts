import * as dotenv from 'dotenv';
dotenv.config();

import { CONTRACTS } from '@certusone/wormhole-sdk/lib/cjs/utils/consts';
import {
  CompiledInstruction,
  Connection,
  Message,
  MessageCompiledInstruction,
  MessageV0,
  PublicKey,
} from '@solana/web3.js';
import { decode } from 'bs58';

const GET_SIGNATURES_LIMIT = 1000;
const WORMHOLE_PROGRAM_ID = CONTRACTS.MAINNET.solana.core;

// (async () => {
//   const connection = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'finalized');
//   const latestSlot = await connection.getSlot();
//   await solanaTraverseWormholeMessages(connection, 96383501, latestSlot);
// })();

export const solanaTraverseWormholeMessages = async (
  connection: Connection,
  fromSlot: number,
  toSlot: number,
): Promise<void> => {
  if (fromSlot > toSlot) throw new Error('solana: invalid block range');
  console.log(`fetching info for blocks ${fromSlot} to ${toSlot}`);

  // get transaction bounds, fromTransaction occurs after toTransaction because getConfirmedSignaturesForAddress2 walks backwards
  const [fromBlock, toBlock] = await Promise.all([
    connection.getBlock(fromSlot, { maxSupportedTransactionVersion: 0 }),
    connection.getBlock(toSlot, { maxSupportedTransactionVersion: 0 }),
  ]);
  if (!fromBlock || !fromBlock.blockTime)
    return solanaTraverseWormholeMessages(connection, fromSlot + 1, toSlot); // could be skipped slot
  if (!toBlock || !toBlock.blockTime) throw new Error(`solana: failed to fetch block ${toSlot}`); // this is finalized, has to exist
  const fromSignature = toBlock.transactions.at(-1)?.transaction.signatures[0];
  const toSignature = fromBlock.transactions[0].transaction.signatures[0];

  // get all core bridge signatures between fromTransaction and toTransaction
  let numSignatures = GET_SIGNATURES_LIMIT;
  let currSignature = fromSignature;

  let prevSlot = 0;
  let startSlotCurrChain = 0;
  let lengthOfLongestChain = 0;
  let startSlotLongestChain = 0;
  let count = 0;
  while (numSignatures === GET_SIGNATURES_LIMIT) {
    const signatures = await connection.getConfirmedSignaturesForAddress2(
      new PublicKey(WORMHOLE_PROGRAM_ID),
      {
        before: currSignature,
        until: toSignature,
        limit: GET_SIGNATURES_LIMIT,
      },
    );
    for (const { signature } of signatures) {
      const res = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!res || !res.blockTime) {
        throw new Error(`solana: failed to fetch tx for signature ${signature}`);
      }

      const message = res.transaction.message;
      const accountKeys = isLegacyMessage(message)
        ? message.accountKeys
        : message.staticAccountKeys;
      const programIdIndex = accountKeys.findIndex((i) => i.toBase58() === WORMHOLE_PROGRAM_ID);
      const instructions = message.compiledInstructions;
      const innerInstructions =
        res.meta?.innerInstructions?.flatMap((i) =>
          i.instructions.map(normalizeCompileInstruction),
        ) || [];
      const whInstructions = innerInstructions
        .concat(instructions)
        .filter((i) => i.programIdIndex === programIdIndex);
      for (const instruction of whInstructions) {
        // skip if not postMessage instruction
        if (instruction.data[0] !== 0x01 && instruction.data[0] !== 0x08) continue;

        // do something
        {
          if (prevSlot === 0 || prevSlot - res.slot > 1) {
            startSlotCurrChain = res.slot;
          }

          if (prevSlot - res.slot > 1 && startSlotCurrChain - prevSlot > lengthOfLongestChain) {
            lengthOfLongestChain = startSlotCurrChain - prevSlot;
            startSlotLongestChain = prevSlot;
          }

          prevSlot = res.slot;
          console.log(res.slot, ++count, lengthOfLongestChain, startSlotLongestChain);
        }
      }
    }

    numSignatures = signatures.length;
    currSignature = signatures.at(-1)?.signature;
  }
};

export const isLegacyMessage = (message: Message | MessageV0): message is Message => {
  return message.version === 'legacy';
};

export const normalizeCompileInstruction = (
  instruction: CompiledInstruction | MessageCompiledInstruction,
): MessageCompiledInstruction => {
  if ('accounts' in instruction) {
    return {
      accountKeyIndexes: instruction.accounts,
      data: decode(instruction.data),
      programIdIndex: instruction.programIdIndex,
    };
  } else {
    return instruction;
  }
};
