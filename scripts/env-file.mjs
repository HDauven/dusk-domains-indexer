const preferredEnvPrefix = 'VITE_DUSK_DOMAINS'
const legacyEnvPrefix = 'VITE_DUSK_NAMES'

export function parseEnvFile(source) {
  const env = {}
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...rest] = line.split('=')
    env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/gu, '')
  }
  return env
}

export function envValue(env, key) {
  return env[preferredEnvKey(key)] ?? env[legacyEnvKey(key)]
}

export function preferredEnvKey(key) {
  return `${preferredEnvPrefix}_${key}`
}

export function legacyEnvKey(key) {
  return `${legacyEnvPrefix}_${key}`
}

export function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}
