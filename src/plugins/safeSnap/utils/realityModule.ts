import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { multicall } from '../../../utils';
import { ModuleAbi, OracleAbi } from '../constants';
import { HashZero } from '@ethersproject/constants';
import { BigNumber } from '@ethersproject/bignumber';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';

export const buildQuestion = async (proposalId: string, txHashes: string[]) => {
  const hashesHash = solidityKeccak256(['bytes32[]'], [txHashes]).slice(2);
  return `${proposalId}␟${hashesHash}`;
};

export const getProposalDetails = async (
  provider: StaticJsonRpcProvider,
  network: string,
  moduleAddress: string,
  questionHash: string,
  txHashes: string[]
): Promise<{ questionId: string; nextTxIndex: number | undefined }> => {
  const proposalInfo = (
    await multicall(
      network,
      provider,
      ModuleAbi,
      [[moduleAddress, 'questionIds', [questionHash]]].concat(
        txHashes.map((txHash) => [
          moduleAddress,
          'executedProposalTransactions',
          [questionHash, txHash]
        ])
      )
    )
  ).map((res) => res[0]);
  const questionId = proposalInfo[0];
  // We need to offset the index by -1 the first element is the questionId
  const nextIndexToExecute = proposalInfo.indexOf(false, 1) - 1;
  return {
    questionId: questionId !== HashZero ? questionId : undefined,
    nextTxIndex:
      nextIndexToExecute < 0 || nextIndexToExecute >= txHashes.length
        ? undefined
        : nextIndexToExecute
  };
};

export const getModuleDetails = async (
  provider: StaticJsonRpcProvider,
  network: string,
  moduleAddress: string
): Promise<{
  dao: string;
  oracle: string;
  cooldown: number;
  minimumBond: number;
}> => {
  let moduleDetails;
  try {
    // Assume module is Reality Module
    moduleDetails = await multicall(network, provider, ModuleAbi, [
      [moduleAddress, 'avatar'],
      [moduleAddress, 'oracle'],
      [moduleAddress, 'questionCooldown'],
      [moduleAddress, 'minimumBond']
    ]);
  } catch (err) {
    // The Reality Module doesn't have an avatar field, causing tx to fails.
    // Assume module is Dao Module (old version)
    moduleDetails = await multicall(network, provider, ModuleAbi, [
      [moduleAddress, 'executor'],
      [moduleAddress, 'oracle'],
      [moduleAddress, 'questionCooldown'],
      [moduleAddress, 'minimumBond']
    ]);
  }

  return {
    dao: moduleDetails[0][0],
    oracle: moduleDetails[1][0],
    cooldown: moduleDetails[2][0],
    minimumBond: moduleDetails[3][0]
  };
};

export const checkPossibleExecution = async (
  provider: StaticJsonRpcProvider,
  network: string,
  oracleAddress: string,
  questionId: string | undefined
): Promise<{
  executionApproved: boolean;
  finalizedAt: number | undefined;
}> => {
  if (questionId) {
    try {
      const result = await multicall(network, provider, OracleAbi, [
        [oracleAddress, 'resultFor', [questionId]],
        [oracleAddress, 'getFinalizeTS', [questionId]]
      ]);

      return {
        executionApproved: BigNumber.from(result[0][0]).eq(BigNumber.from(1)),
        finalizedAt: BigNumber.from(result[1][0]).toNumber()
      };
    } catch (e) {
      // We expect an error while the question is not answered yet
    }
  }
  return {
    executionApproved: false,
    finalizedAt: undefined
  };
};
