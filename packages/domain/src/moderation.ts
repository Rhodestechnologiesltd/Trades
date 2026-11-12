/**
 * Review/message moderation (spec §A.9): PII redaction + profanity flagging.
 * Redaction prevents parties exchanging phone numbers/emails to take jobs
 * off-platform (disintermediation) and protects privacy in public reviews.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 7+ digit sequences allowing spaces, dashes, dots, parentheses and a leading +
const PHONE = /(?:\+?\d[\s\-.()]*){7,}\d/g;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

const BLOCKLIST = ['fuck', 'shit', 'bitch', 'bastard', 'cunt', 'asshole', 'merde', 'connard', 'salope', 'putain'];

export interface ModerationResult {
  text: string;
  redacted: boolean;
  flagged: boolean;
  reasons: string[];
}

export function moderateText(input: string): ModerationResult {
  const reasons: string[] = [];
  let text = input;
  const before = text;
  text = text.replace(EMAIL, '[email removed]');
  if (text !== before) reasons.push('email');
  const b2 = text;
  text = text.replace(PHONE, '[phone removed]');
  if (text !== b2) reasons.push('phone');
  const b3 = text;
  text = text.replace(URL, '[link removed]');
  if (text !== b3) reasons.push('link');
  const lower = text.toLowerCase();
  const profane = BLOCKLIST.some(w => new RegExp(`\\b${w}`, 'i').test(lower));
  if (profane) reasons.push('profanity');
  return { text, redacted: text !== input, flagged: profane, reasons };
}
