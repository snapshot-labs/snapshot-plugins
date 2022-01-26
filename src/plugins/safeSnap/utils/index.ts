import { isAddress } from '@ethersproject/address';
import { JsonRpcProvider } from '@ethersproject/providers';
import { keccak256 } from '@ethersproject/solidity';
import memoize from 'lodash/memoize';

import SafeSnapPlugin from '../index';
import { createMultiSendTx, getMultiSend } from './multiSend';
import { ModuleTransaction, SafeData } from '../models';
import { getProvider } from '../../../utils';

export const mustBeEthereumAddress = memoize((address: string) => {
  const startsWith0x = address?.startsWith('0x');
  const isValidAddress = isAddress(address);
  return startsWith0x && isValidAddress;
});

export const mustBeEthereumContractAddress = memoize(
  async (network: string, address: string) => {
    const provider = getProvider(network) as JsonRpcProvider;
    const contractCode = await provider.getCode(address);

    return (
      contractCode && contractCode.replace('0x', '').replace(/0/g, '') !== ''
    );
  },
  (url, contractAddress) => `${url}_${contractAddress}`
);

export function formatBatchTransaction(
  batch: ModuleTransaction[],
  nonce: number,
  multiSendAddress: string
): ModuleTransaction {
  if (batch.length === 1) {
    return { ...batch[0], nonce: nonce.toString() };
  }
  return createMultiSendTx(batch, nonce, multiSendAddress);
}

export function createBatch(
  module: string,
  chainId: number,
  nonce: number,
  txs: ModuleTransaction[],
  multiSendAddress: string
) {
  return {
    nonce,
    hash: getBatchHash(module, chainId, nonce, txs, multiSendAddress),
    transactions: txs
  };
}

export function getBatchHash(
  module: string,
  chainId: number,
  nonce: number,
  txs: ModuleTransaction[],
  multiSendAddress: string
) {
  const valid = txs.every((tx) => tx);
  if (!valid || !txs.length) return null;
  try {
    const safeSnap = new SafeSnapPlugin();
    const hashes = safeSnap.calcTransactionHashes(chainId, module, [
      formatBatchTransaction(txs, nonce, multiSendAddress)
    ]);
    return hashes[0];
  } catch (err) {
    console.warn('invalid batch hash', err);
    return null;
  }
}

export function getSafeHash(safe: SafeData) {
  const hashes = safe.txs.map((batch) => batch.hash);
  const valid = hashes.every((hash) => hash);
  if (!valid || !hashes.length) return null;
  return keccak256(['bytes32[]'], [hashes]);
}

export function validateSafeData(safe) {
  return (
    safe.txs.length === 0 ||
    safe.txs
      .map((batch) => batch.transactions)
      .flat()
      .every((tx) => tx)
  );
}

export function isValidInput(input) {
  return input.safes.every(validateSafeData);
}

export function coerceConfig(config, network) {
  if (config.safes) {
    return {
      ...config,
      safes: config.safes.map((safe) => ({
        ...safe,
        multiSendAddress:
          safe.multiSendAddress || getMultiSend(safe.network || network)
      }))
    };
  }

  // map legacy config to new format
  return {
    safes: [
      {
        network,
        realityAddress: config.address,
        multiSendAddress: getMultiSend(network)
      }
    ]
  };
}

export async function fetchTextSignatures(
  methodSignature: string
): Promise<string[]> {
  const url = new URL('/api/v1/signatures', 'https://www.4byte.directory');
  url.searchParams.set('hex_signature', methodSignature);
  url.searchParams.set('ordering', 'created_at');
  const response = await fetch(url.toString());
  const { results } = await response.json();
  return results.map((signature) => signature.text_signature);
}
