// Parse only explicit output-token/minute evidence. These are provider counters,
// not completion_tokens or total-token TPM, and may include hidden reasoning.
export function parseOutputRateLimit(message: unknown): { limit: number; used: number; requested: number } | null {
  if (typeof message !== 'string') return null;
  const match = /(?:output\s+tokens?\s+per\s+minute\s*(?:\(OTPM\))?|\bOTPM\b)\s*:\s*Limit\s+([\d,]+),\s*Used\s+([\d,]+),\s*Requested\s+([\d,]+)/i.exec(message);
  if (!match) return null;
  const [limit, used, requested] = match.slice(1).map(v => Number(v.replace(/,/g, '')));
  if (![limit, used, requested].every(Number.isSafeInteger) || limit <= 0 || used < 0 || requested < 0) return null;
  return { limit, used, requested };
}
