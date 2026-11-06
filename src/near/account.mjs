import { CompactError, EXIT } from '../errors.mjs';
import { RpcError } from './rpc.mjs';
import { signTransaction } from './tx.mjs';
import { publicKeyString } from './keys.mjs';
import { sleep } from '../util/fs.mjs';
import { nullLogger } from '../util/log.mjs';

export const YOCTO = 10n ** 24n;
export const MIN_BALANCE = YOCTO / 20n; // 0.05 NEAR is plenty for the Compact transactions
export const GAS_30T = 30_000_000_000_000n;
export const NO_CONTRACT_HASH = '11111111111111111111111111111111';

/** 1234500000000000000000000 -> "1.2345" */
export function formatNear(yocto, decimals = 4) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, decimals);
  return `${whole}.${frac}`;
}

export async function getAccountInfo(rpc, accountId) {
  const a = await rpc.viewAccount(accountId);
  if (!a) return { exists: false, balance: 0n, codeHash: NO_CONTRACT_HASH, storageUsage: 0 };
  return { exists: true, balance: BigInt(a.amount), codeHash: a.code_hash, storageUsage: a.storage_usage };
}

/** Poll until the account holds at least `min`. Calls onTick({balance, waitedMs}). */
export async function waitForFunding(rpc, accountId, { min = MIN_BALANCE, timeoutMs = 10 * 60_000, intervalMs = 4000, onTick, signal } = {}) {
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) throw new CompactError('E_ABORT', 'Cancelled.', { exitCode: EXIT.CANCELLED });
    const info = await getAccountInfo(rpc, accountId);
    onTick?.({ balance: info.balance, waitedMs: Date.now() - start });
    if (info.exists && info.balance >= min) return info;
    if (Date.now() - start > timeoutMs) {
      throw new CompactError('E_FUNDING_TIMEOUT', `Account still below ${formatNear(min, 2)} NEAR after ${Math.round(timeoutMs / 60000)} min.`, {
        hint: 'Fund the address, then re-run the command.',
      });
    }
    await sleep(intervalMs);
  }
}

function summarizeOutcome(res) {
  const failures = [];
  const status = res.status || {};
  if (status.Failure) failures.push(status.Failure);
  const outcomes = [res.transaction_outcome, ...(res.receipts_outcome || [])].filter(Boolean);
  let gas = 0n;
  let burnt = 0n;
  for (const o of outcomes) {
    gas += BigInt(o.outcome.gas_burnt || 0);
    burnt += BigInt(o.outcome.tokens_burnt || 0);
    if (o.outcome.status?.Failure) failures.push(o.outcome.status.Failure);
  }
  return {
    ok: failures.length === 0 && (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined),
    failure: failures[0],
    gasBurnt: gas.toString(),
    tokensBurnt: burnt.toString(),
    receiptIds: (res.receipts_outcome || []).map((o) => o.id),
    finalStatus: res.final_execution_status,
  };
}

/** Poll the `tx` method until the transaction has executed (or time runs out). */
export async function waitForTx(rpc, txHash, signerId, { timeoutMs = 90_000, intervalMs = 1500, logger = nullLogger } = {}) {
  const start = Date.now();
  let useObjectParams = true;
  for (;;) {
    try {
      const params = useObjectParams
        ? { tx_hash: txHash, sender_account_id: signerId, wait_until: 'EXECUTED_OPTIMISTIC' }
        : [txHash, signerId];
      return await rpc.call('tx', params);
    } catch (e) {
      if (e instanceof RpcError) {
        if (useObjectParams && /invalid params|parse/i.test(`${e.message} ${e.rpcName}`)) { useObjectParams = false; continue; }
        const pending = /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|not.*(found|yet)/i.test(`${e.rpcName} ${e.message}`);
        if (!pending) throw e;
        logger.debug('tx not final yet', { txHash });
      } else {
        throw e;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new CompactError('E_TX_TIMEOUT', 'The transaction was sent but has not been confirmed yet.', {
        hint: `It may still land. Check tx ${txHash} on the explorer before retrying.`,
        details: { txHash },
        exitCode: EXIT.NETWORK,
      });
    }
    await sleep(intervalMs);
  }
}

/**
 * Sign, broadcast and confirm one transaction.
 * Re-broadcasting the same signed bytes is idempotent, so transient failures are retried safely.
 */
export async function sendTransaction({ rpc, signerId, keyPair, receiverId, actions, logger = nullLogger, confirmTimeoutMs }) {
  const pubStr = publicKeyString(keyPair.publicKey);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await rpc.viewAccessKey(signerId, pubStr);
    if (!key) {
      throw new CompactError('E_ACCOUNT_UNFUNDED', `Account ${signerId} does not exist on-chain yet (it has no balance).`, {
        hint: 'Fund the deployer address with testnet NEAR first: compact account balance --wait',
      });
    }
    const block = await rpc.block();
    const { decode } = await import('./base58.mjs');
    const signed = signTransaction({
      signerId, publicKey: keyPair.publicKey, nonce: BigInt(key.nonce) + 1n,
      receiverId, blockHash: decode(block.hash), actions,
    }, keyPair);

    try {
      await rpc.call('broadcast_tx_async', [signed.signedBase64]);
    } catch (e) {
      const msg = `${e?.rpcName ?? ''} ${e?.message ?? ''}`;
      if (/InvalidNonce|already.*(exist|processed)/i.test(msg)) {
        logger.warn('nonce conflict, re-checking', { attempt });
        // The same tx may already have landed; otherwise loop and rebuild with a fresh nonce.
        try {
          const maybe = await waitForTx(rpc, signed.txHash, signerId, { timeoutMs: 6000, logger });
          return { txHash: signed.txHash, ...summarizeOutcome(maybe) };
        } catch { continue; }
      }
      if (/expired|InvalidTxError.*Expired/i.test(msg)) { continue; }
      throw e;
    }
    const outcome = await waitForTx(rpc, signed.txHash, signerId, { timeoutMs: confirmTimeoutMs, logger });
    return { txHash: signed.txHash, ...summarizeOutcome(outcome) };
  }
  throw new CompactError('E_TX_FAILED', 'Could not get the transaction accepted after 3 attempts.', {
    hint: 'Run again in a minute; if it keeps failing, check `compact doctor`.',
  });
}
