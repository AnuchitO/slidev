import { randomInt } from 'node:crypto'

/**
 * Alphabet for auto-generated room/presenter codes (`index.ts`, plan 031a —
 * "don't need to hard-code a value on the running server side"): uppercase
 * letters + digits, with the visually-ambiguous `0`/`O`/`1`/`I`/`L` excluded.
 * These codes get read aloud across a room and typed back in under time
 * pressure, so removing characters a listener could plausibly mishear or
 * mistype for another one matters more here than maximizing entropy per
 * character.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * Generates a random code of `length` characters drawn from `CODE_ALPHABET`.
 * Used by `index.ts` to invent a room/presenter code when the operator
 * hasn't set one via env var — an explicitly-configured env var always wins;
 * this is only ever the fallback.
 *
 * `random` defaults to `node:crypto`'s `randomInt` (cryptographically
 * strong, not `Math.random()` — these codes gate real privileged actions,
 * same reasoning as `session.ts`'s `randomUUID()`-based participant ids) but
 * is injectable so `codeGeneration.test.ts` can assert exact output without
 * mocking the crypto module.
 */
export function generateCode(length: number, random: (max: number) => number = max => randomInt(max)): string {
  let code = ''
  for (let i = 0; i < length; i++)
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)]
  return code
}
