import { BigNumber } from '@ethersproject/bignumber';

export interface ModuleTransaction {
  to: string;
  value: string;
  data: string;
  operation: string;
  nonce: string;
}

export interface ProposalDetails {
  dao: string;
  oracle: string;
  cooldown: number;
  proposalId: string;
  questionId: string | undefined;
  executionApproved: boolean;
  finalizedAt: number | undefined;
  nextTxIndex: number | undefined;
  transactions: ModuleTransaction[];
  txHashes: string[];
  currentBond: BigNumber | undefined;
  isApproved: boolean;
  endTime: number | undefined;
}
