import React, { FC, useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { message } from '@/_helpers/browser-api'
import { ViewPorps } from '@/components/dictionaries/helpers'
import { Trans, useTranslate } from '@/_helpers/i18n'
import { OpenAIResult, isSingleEnglishWord } from './engine'

const SANITIZE_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p',
    'ul',
    'ol',
    'li',
    'strong',
    'b',
    'em',
    'i',
    'br',
    'span',
    'code'
  ],
  ALLOWED_ATTR: ['class']
}

const CredentialMessage: FC<{
  error: OpenAIResult['credentialError']
}> = ({ error }) => {
  const { t } = useTranslate('content')
  return (
    <Trans message={t(`machineTrans.credential.${error || 'missing'}`)}>
      <a
        href={browser.runtime.getURL('options.html?menuselected=DictAuths')}
        target="_blank"
        rel="nofollow noopener noreferrer"
      >
        {t('machineTrans.dictAccount')}
      </a>
    </Trans>
  )
}

const IPA_RE = /\[\[IPA:([^\]]*)\]\]/

/** Lift the injected `[[IPA:…]]` marker (see IPA_DIRECTIVE) out of the model
 * output. Handles the streaming case where the marker is still arriving. */
function splitIPA(html: string): { ipa: string; body: string } {
  const m = html.match(IPA_RE)
  if (m) {
    const body = html
      .slice((m.index || 0) + m[0].length)
      .replace(/^\s*(?:<p>\s*<\/p>\s*|<br\s*\/?>\s*)+/i, '')
    return { ipa: m[1].trim(), body }
  }
  // Marker not complete yet — hide the partial `[[IPA:` prefix while it streams.
  if (/^\s*\[\[IPA:/.test(html) && !html.includes(']]')) {
    return { ipa: '', body: '' }
  }
  return { ipa: '', body: html }
}

/** Tokenless Google TTS endpoint. It reads the exact word (correct for any
 * form, unlike a dictionary's recorded audio) and needs no `tk` token — so,
 * unlike the tokened translate API, it works from the MV3 background service
 * worker (where the token lib's XHR call fails). Played through the extension's
 * own audio player (offscreen), the same PLAY_AUDIO path auto-pronunciation and
 * the other dict speakers use. */
const googleTTSUrl = (word: string): string =>
  'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
  encodeURIComponent(word)

const playPronunciation = (word: string): void => {
  message.send({ type: 'PLAY_AUDIO', payload: googleTTSUrl(word) })
}

/** A single accurate pronunciation line: word + IPA (from the model) + a
 * speaker button that plays Google TTS. */
const PronLine: FC<{ word: string; ipa: string }> = ({ word, ipa }) => (
  <div className="openai-pron">
    <span className="openai-pron-word">{word}</span>
    {ipa ? <span className="openai-pron-ipa">{ipa}</span> : null}
    <button
      type="button"
      className="openai-pron-speaker"
      title="Play pronunciation"
      onClick={() => playPronunciation(word)}
    >
      <svg
        viewBox="0 0 24 24"
        width="1.1em"
        height="1.1em"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
      </svg>
    </button>
  </div>
)

const Card: FC<{ html: string }> = ({ html }) => (
  <div
    className="openai-card"
    dangerouslySetInnerHTML={{
      __html: DOMPurify.sanitize(html, SANITIZE_CONFIG) as string
    }}
  />
)

/**
 * Streams the result over a background port and renders it progressively.
 * The apiKey stays in the background; this only sends the selection args.
 */
const StreamingCard: FC<{
  args: NonNullable<OpenAIResult['args']>
}> = ({ args }) => {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<{
    credentialError?: OpenAIResult['credentialError']
    message?: string
  } | null>(null)

  useEffect(() => {
    setHtml('')
    setError(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = browser.runtime.connect({
      name: 'saladict-openai-stream'
    } as any)
    let finished = false

    port.onMessage.addListener((msg: any) => {
      if (!msg) return
      if (msg.type === 'delta') {
        setHtml(msg.html)
      } else if (msg.type === 'done') {
        finished = true
        try {
          port.disconnect()
        } catch {
          /* noop */
        }
      } else if (msg.type === 'error') {
        finished = true
        setError({ credentialError: msg.credentialError, message: msg.message })
        try {
          port.disconnect()
        } catch {
          /* noop */
        }
      }
    })

    port.postMessage(args)

    return () => {
      if (!finished) {
        try {
          port.disconnect()
        } catch {
          /* noop */
        }
      }
    }
  }, [args.text, args.from, args.to, args.sentence])

  if (error) {
    if (error.credentialError) {
      return <CredentialMessage error={error.credentialError} />
    }
    return <div className="openai-card">{error.message || 'Error'}</div>
  }

  const { ipa, body } = splitIPA(html)
  return (
    <>
      {isSingleEnglishWord(args.text) && (
        <PronLine word={args.text} ipa={ipa} />
      )}
      <Card html={body} />
    </>
  )
}

export const OpenAIView: FC<ViewPorps<OpenAIResult>> = ({ result }) => {
  if (result.requireCredential || result.credentialError) {
    return <CredentialMessage error={result.credentialError} />
  }

  if (result.streaming && result.args) {
    return <StreamingCard args={result.args} />
  }

  return <Card html={splitIPA(result.html || '').body} />
}

export default OpenAIView
