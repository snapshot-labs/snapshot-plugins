import { isAddress } from '@ethersproject/address';
import { BigNumber } from '@ethersproject/bignumber';
import { isBigNumberish } from '@ethersproject/bignumber/lib/bignumber';
import { isHexString } from '@ethersproject/bytes';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';
import { call, getProvider, multicall, sendTransaction } from '../../utils';
import { _TypedDataEncoder } from '@ethersproject/hash';
import { Contract } from '@ethersproject/contracts';
import { Result } from '@ethersproject/abi';
import { ModuleTransaction, ProposalDetails } from './models';
import {
  EIP712_TYPES,
  ModuleAbi,
  OracleAbi,
  START_BLOCKS,
  TokenAbi
} from './constants';
import {
  buildQuestion,
  checkPossibleExecution,
  getModuleDetails,
  getProposalDetails
} from './utils/realityModule';
import { retrieveInfoFromOracle } from './utils/realityETH';
import {
  createMultiSendTx,
  getMultiSend,
  MULTI_SEND_VERSION
} from './utils/multiSend';

export default class Plugin {
  public author = 'Gnosis';
  public version = '1.0.0';
  public name = 'SafeSnap';
  public website = 'https://safe.gnosis.io';
  public options: any;

  static createMultiSendTx(
    txs: ModuleTransaction[],
    nonce: number,
    multiSendAddress: string
  ) {
    return createMultiSendTx(txs, nonce, multiSendAddress);
  }

  static getMultiSend(
    network: number | string,
    version: MULTI_SEND_VERSION = MULTI_SEND_VERSION.V1_3_0
  ) {
    return getMultiSend(network, version);
  }

  validateTransaction(transaction: ModuleTransaction) {
    const addressEmptyOrValidate =
      transaction.to === '' || isAddress(transaction.to);
    return (
      isBigNumberish(transaction.value) &&
      addressEmptyOrValidate &&
      (!transaction.data || isHexString(transaction.data)) &&
      transaction.operation in ['0', '1'] &&
      isBigNumberish(transaction.nonce)
    );
  }

  calcTransactionHash(
    network: string,
    moduleAddress: string,
    transaction: ModuleTransaction
  ) {
    const chainId = parseInt(network);
    const domain = {
      chainId,
      verifyingContract: moduleAddress
    };
    return _TypedDataEncoder.hash(domain, EIP712_TYPES, transaction);
  }

  calcTransactionHashes(
    chainId: number,
    moduleAddress: string,
    transactions: ModuleTransaction[]
  ) {
    const domain = {
      chainId: chainId,
      verifyingContract: moduleAddress
    };
    return transactions.map((tx) => {
      return _TypedDataEncoder.hash(domain, EIP712_TYPES, {
        ...tx,
        nonce: tx.nonce || '0',
        data: tx.data || '0x'
      });
    });
  }

  async getExecutionDetails(
    network: string,
    moduleAddress: string,
    proposalId: string,
    transactions: ModuleTransaction[]
  ): Promise<ProposalDetails> {
    const provider: StaticJsonRpcProvider = getProvider(network);
    const chainId = parseInt(network);
    const txHashes = this.calcTransactionHashes(
      chainId,
      moduleAddress,
      transactions
    );
    const question = await buildQuestion(proposalId, txHashes);
    const questionHash = solidityKeccak256(['string'], [question]);

    const proposalDetails = await getProposalDetails(
      provider,
      network,
      moduleAddress,
      questionHash,
      txHashes
    );
    const moduleDetails = await getModuleDetails(
      provider,
      network,
      moduleAddress
    );
    const questionState = await checkPossibleExecution(
      provider,
      network,
      moduleDetails.oracle,
      proposalDetails.questionId
    );
    const infoFromOracle = await retrieveInfoFromOracle(
      provider,
      network,
      moduleDetails.oracle,
      proposalDetails.questionId
    );
    try {
      return {
        ...moduleDetails,
        proposalId,
        ...questionState,
        ...proposalDetails,
        transactions,
        txHashes,
        ...infoFromOracle
      };
    } catch (e) {
      throw new Error(e);
    }
  }

  async getModuleDetails(network: string, moduleAddress: string) {
    const provider: StaticJsonRpcProvider = getProvider(network);
    return getModuleDetails(provider, network, moduleAddress);
  }

  async *submitProposal(
    web3: any,
    moduleAddress: string,
    proposalId: string,
    transactions: ModuleTransaction[]
  ) {
    const txHashes = this.calcTransactionHashes(
      web3.network.chainId,
      moduleAddress,
      transactions
    );
    const tx = await sendTransaction(
      web3,
      moduleAddress,
      ModuleAbi,
      'addProposal',
      [proposalId, txHashes]
    );
    yield;
    const receipt = await tx.wait();
    console.log('[DAO module] submitted proposal:', receipt);
  }

  async loadClaimBondData(
    web3: any,
    network: string,
    questionId: string,
    oracleAddress: string
  ) {
    const contract = new Contract(oracleAddress, OracleAbi, web3);
    const provider: StaticJsonRpcProvider = getProvider(network);
    const account = (await web3.listAccounts())[0];

    const [
      [userBalance],
      [bestAnswer],
      [historyHash],
      [isFinalized]
    ] = await multicall(network, provider, OracleAbi, [
      [oracleAddress, 'balanceOf', [account]],
      [oracleAddress, 'getBestAnswer', [questionId]],
      [oracleAddress, 'getHistoryHash', [questionId]],
      [oracleAddress, 'isFinalized', [questionId]]
    ]);

    let tokenSymbol = 'ETH';
    let tokenDecimals = 18;

    try {
      const token = await call(provider, OracleAbi, [
        oracleAddress,
        'token',
        []
      ]);
      const [[symbol], [decimals]] = await multicall(
        network,
        provider,
        TokenAbi,
        [
          [token, 'symbol', []],
          [token, 'decimals', []]
        ]
      );

      tokenSymbol = symbol;
      tokenDecimals = decimals;
    } catch (e) {}

    const answersFilter = contract.filters.LogNewAnswer(null, questionId);
    const events = await contract.queryFilter(
      answersFilter,
      START_BLOCKS[network]
    );

    const users: Result[] = [];
    const historyHashes: Result[] = [];
    const bonds: Result[] = [];
    const answers: Result[] = [];

    // We need to send the information from last to first
    events.reverse().forEach(({ args }) => {
      users.push(args?.user.toLowerCase());
      historyHashes.push(args?.history_hash);
      bonds.push(args?.bond);
      answers.push(args?.answer);
    });

    const alreadyClaimed = BigNumber.from(historyHash).eq(0);
    const address = account.toLowerCase();

    // Check if current user has submitted an answer
    const currentUserAnswers = users.map((user, i) => {
      if (user === address) return answers[i];
    });

    // If the user has answers, check if one of them is the winner
    const votedForCorrectQuestion =
      currentUserAnswers.some((answer) => {
        if (answer) {
          return BigNumber.from(answer).eq(bestAnswer);
        }
      }) && isFinalized;

    // If user has balance in the contract, he should be able to withdraw
    const hasBalance = !userBalance.eq(0) && isFinalized;

    // Remove the first history and add an empty one
    // More info: https://github.com/realitio/realitio-contracts/blob/master/truffle/contracts/Realitio.sol#L502
    historyHashes.shift();
    const firstHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as unknown;
    historyHashes.push(firstHash as Result);

    return {
      tokenSymbol,
      tokenDecimals,
      canClaim: (!alreadyClaimed && votedForCorrectQuestion) || hasBalance,
      data: {
        length: [bonds.length.toString()],
        historyHashes,
        users,
        bonds,
        answers
      }
    };
  }

  async *claimBond(
    web3: any,
    oracleAddress: string,
    questionId: string,
    claimParams: [string[], string[], number[], string[]]
  ) {
    const currentHistoryHash = await call(web3, OracleAbi, [
      oracleAddress,
      'getHistoryHash',
      [questionId]
    ]);

    if (BigNumber.from(currentHistoryHash).eq(0)) {
      const tx = await sendTransaction(
        web3,
        oracleAddress,
        OracleAbi,
        'withdraw',
        []
      );
      yield;
      const receipt = await tx.wait();
      console.log('[Realitio] executed withdraw:', receipt);
      return;
    }

    const tx = await sendTransaction(
      web3,
      oracleAddress,
      OracleAbi,
      'claimMultipleAndWithdrawBalance',
      [[questionId], ...claimParams]
    );
    yield;
    const receipt = await tx.wait();
    console.log(
      '[Realitio] executed claimMultipleAndWithdrawBalance:',
      receipt
    );
  }

  async *executeProposal(
    web3: any,
    moduleAddress: string,
    proposalId: string,
    transactions: ModuleTransaction[],
    transactionIndex: number
  ) {
    const txHashes = this.calcTransactionHashes(
      web3.network.chainId,
      moduleAddress,
      transactions
    );
    const moduleTx = transactions[transactionIndex];
    const tx = await sendTransaction(
      web3,
      moduleAddress,
      ModuleAbi,
      'executeProposalWithIndex',
      [
        proposalId,
        txHashes,
        moduleTx.to,
        moduleTx.value,
        moduleTx.data || '0x',
        moduleTx.operation,
        transactionIndex
      ]
    );
    yield;
    const receipt = await tx.wait();
    console.log('[DAO module] executed proposal:', receipt);
  }

  async *voteForQuestion(
    network: string,
    web3: any,
    oracleAddress: string,
    questionId: string,
    minimumBondInDaoModule: string,
    answer: '1' | '0'
  ) {
    const currentBond = await call(web3, OracleAbi, [
      oracleAddress,
      'getBond',
      [questionId]
    ]);

    let bond;
    let methodName;
    const txOverrides = {};
    let parameters = [
      questionId,
      `0x000000000000000000000000000000000000000000000000000000000000000${answer}`
    ];

    const currentBondIsZero = currentBond.eq(BigNumber.from(0));
    if (currentBondIsZero) {
      // DaoModules can have 0 minimumBond, if it happens, the initial bond will be 1 token
      const daoBondIsZero = BigNumber.from(minimumBondInDaoModule).eq(0);
      bond = daoBondIsZero ? BigNumber.from(10) : minimumBondInDaoModule;
    } else {
      bond = currentBond.mul(2);
    }

    // fetch token attribute from Realitio contract, if it works, it means it is
    // a RealitioERC20, otherwise the catch will handle the currency as ETH
    try {
      const account = (await web3.listAccounts())[0];
      const token = await call(web3, OracleAbi, [oracleAddress, 'token', []]);
      const [[tokenDecimals], [allowance]] = await multicall(
        network,
        web3,
        TokenAbi,
        [
          [token, 'decimals', []],
          [token, 'allowance', [account, oracleAddress]]
        ]
      );

      if (bond.eq(10)) {
        bond = bond.pow(tokenDecimals);
      }

      // Check if contract has allowance on user tokens,
      // if not, trigger approve method
      if (allowance.lt(bond)) {
        const approveTx = await sendTransaction(
          web3,
          token,
          TokenAbi,
          'approve',
          [oracleAddress, bond],
          {}
        );
        yield 'erc20-approval';
        const approvalReceipt = await approveTx.wait();
        console.log('[DAO module] token transfer approved:', approvalReceipt);
        yield;
      }
      parameters = [...parameters, bond, bond];
      methodName = 'submitAnswerERC20';
    } catch (e) {
      if (bond.eq(10)) {
        bond = bond.pow(18);
      }
      parameters = [...parameters, bond];
      txOverrides['value'] = bond.toString();
      methodName = 'submitAnswer';
    }

    const tx = await sendTransaction(
      web3,
      oracleAddress,
      OracleAbi,
      methodName,
      parameters,
      txOverrides
    );
    yield;
    const receipt = await tx.wait();
    console.log('[DAO module] executed vote on oracle:', receipt);
  }
}
