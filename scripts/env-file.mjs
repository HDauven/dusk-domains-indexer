import { parseEnv } from 'node:util'

const preferredEnvPrefix = 'VITE_DUSK_DOMAINS'

export const parseEnvFile = parseEnv

export function envValue(env, key) {
  return env[preferredEnvKey(key)]
}

export function preferredEnvKey(key) {
  return `${preferredEnvPrefix}_${key}`
}
