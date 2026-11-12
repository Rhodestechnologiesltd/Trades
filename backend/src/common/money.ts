import { Money, fromMajor, toMajorString } from '@trades/domain';

/** NUMERIC column (string) → Money */
export const m = (amount: string | number, currency: string): Money => fromMajor(String(amount), currency);
/** Money → NUMERIC column string */
export const n = (money: Money): string => toMajorString(money);
/** API representation of money: exact decimal string + currency */
export const apiMoney = (money: Money) => ({ amount: toMajorString(money), currency: money.currency });
