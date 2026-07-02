export const auth = {
  // Default from the local .env (DEEPL_AUTH_KEY), baked in at build time.
  // Only the variable name lives in source; the secret stays in gitignored .env.
  authKey: process.env.DEEPL_AUTH_KEY || ''
}

export const url = 'https://www.deepl.com/pro-api'
