import { pickLinkedTransferUpdate } from '../transferLink';

describe('pickLinkedTransferUpdate', () => {
  it('mirrors amount sign so the paired account moves the opposite direction', () => {
    expect(pickLinkedTransferUpdate({ amount: -63.43 })).toEqual({
      amount: 63.43,
    });
    expect(pickLinkedTransferUpdate({ amount: 100 })).toEqual({
      amount: -100,
    });
  });

  it('copies date, memo, and status verbatim', () => {
    expect(
      pickLinkedTransferUpdate({
        txnDate: '2026-05-13',
        memo: 'Transfer to savings',
        status: 'reconciled',
      })
    ).toEqual({
      txnDate: '2026-05-13',
      memo: 'Transfer to savings',
      status: 'reconciled',
    });
  });

  it('preserves null memo', () => {
    expect(pickLinkedTransferUpdate({ memo: null })).toEqual({ memo: null });
  });

  it('does not propagate payee or check number to the paired side', () => {
    const result = pickLinkedTransferUpdate({
      payee: 'Transfer to Chase',
      checkNumber: '1001',
    });
    expect(result).toEqual({});
  });

  it('returns only the fields that were provided', () => {
    expect(pickLinkedTransferUpdate({ status: 'cleared' })).toEqual({
      status: 'cleared',
    });
  });

  it('returns an empty object when no editable fields are present', () => {
    expect(pickLinkedTransferUpdate({})).toEqual({});
  });
});
