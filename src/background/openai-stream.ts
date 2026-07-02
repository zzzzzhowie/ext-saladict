import { getConfig } from '@/_helpers/config-manager'
import { openaiStream } from '@/components/dictionaries/openai/engine'
import { getCredentialErrorFromHttpStatus } from '@/components/dictionaries/machine-custom'

/**
 * Handles a `saladict-openai-stream` port opened by the OpenAI dict View.
 * The View posts `{ text, from, to, sentence }`; we resolve the auth here (so
 * the apiKey never reaches the page), stream the OpenAI response, and post back
 * `{ type: 'delta', html }` chunks followed by `{ type: 'done' }`, or
 * `{ type: 'error', credentialError?, message? }` on failure.
 */
export function registerOpenAIStreamPort(port: browser.runtime.Port): void {
  let disconnected = false
  port.onDisconnect.addListener(() => {
    disconnected = true
  })

  port.onMessage.addListener(async (req: any) => {
    const post = (msg: any) => {
      if (!disconnected) {
        try {
          port.postMessage(msg)
        } catch {
          /* port already closed */
        }
      }
    }

    try {
      const config = await getConfig()
      const auth = (config.dictAuth as any).openai || {}
      await openaiStream(auth, req, html => post({ type: 'delta', html }))
      post({ type: 'done' })
    } catch (e) {
      post({
        type: 'error',
        credentialError: getCredentialErrorFromHttpStatus((e as any)?.status),
        message: (e as any)?.message
      })
    }
  })
}
