import { hash, verify } from '@node-rs/argon2'

// OWASP-recommended argon2id parameters.
const OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS)
}

export function verifyPassword(digest: string, password: string): Promise<boolean> {
  return verify(digest, password, OPTS)
}
