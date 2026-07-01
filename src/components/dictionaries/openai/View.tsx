import React, { FC } from 'react'
import DOMPurify from 'dompurify'
import { ViewPorps } from '@/components/dictionaries/helpers'
import { Trans, useTranslate } from '@/_helpers/i18n'
import { OpenAIResult } from './engine'

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

export const OpenAIView: FC<ViewPorps<OpenAIResult>> = ({ result }) => {
  if (result.requireCredential || result.credentialError) {
    return <CredentialMessage error={result.credentialError} />
  }

  const html = DOMPurify.sanitize(result.html || '', SANITIZE_CONFIG) as string

  return (
    <div className="openai-card" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

export default OpenAIView
