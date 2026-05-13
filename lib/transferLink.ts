import type { TransactionStatus } from './types';

export interface TransferEditableFields {
  txnDate?: string;
  amount?: number;
  memo?: string | null;
  status?: TransactionStatus;
}

// Fields that mirror to the paired transfer transaction. Payee and check number
// stay specific to each side (e.g. "Transfer to Chase" vs "Transfer from PNC");
// amount is sign-flipped so a deduction in one account stays a deposit in the other.
export function pickLinkedTransferUpdate(
  input: TransferEditableFields & { payee?: string; checkNumber?: string | null }
): TransferEditableFields {
  const out: TransferEditableFields = {};
  if (input.txnDate !== undefined) {
    out.txnDate = input.txnDate;
  }
  if (input.amount !== undefined) {
    out.amount = -input.amount;
  }
  if (input.memo !== undefined) {
    out.memo = input.memo;
  }
  if (input.status !== undefined) {
    out.status = input.status;
  }
  return out;
}
