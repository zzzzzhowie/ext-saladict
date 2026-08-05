// Default from the local .env (DEEPL_AUTH_KEY), baked in at build time.
// Only the variable name lives in source; the secret stays in gitignored .env.
export const DEFAULT_DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY || ''

export const auth = {
  authKey: DEFAULT_DEEPL_AUTH_KEY
}

export const url = 'https://www.deepl.com/pro-api'
