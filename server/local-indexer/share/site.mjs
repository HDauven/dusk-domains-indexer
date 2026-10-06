export function siteConfig(env = process.env) {
  const url = new URL(env.DUSK_DOMAINS_SITE_URL || 'https://dusk.domains')
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('DUSK_DOMAINS_SITE_URL must use HTTP or HTTPS')
  return { origin: url.origin, host: url.host, noindex: env.DUSK_DOMAINS_NOINDEX === 'true' }
}
