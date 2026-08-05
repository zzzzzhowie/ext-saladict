import React, { FC, useState } from 'react'
import { Input, Button, Form, message } from 'antd'
import { FormInstance } from 'antd/lib/form'
import { useTranslate } from '@/_helpers/i18n'
import { SaladictFormItem } from '@/options/components/SaladictForm'
import {
  openaiTranslate,
  resolveOpenAIConfig
} from '@/components/dictionaries/openai/engine'

const trimAuthValue = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value

/** Reads the current (possibly unsaved) openai auth from the antd form. */
const OpenAITestButton: FC<{
  form: FormInstance
  configPath: string
}> = ({ form, configPath }) => {
  const { t } = useTranslate(['options'])
  const [loading, setLoading] = useState(false)

  const onTest = async () => {
    setLoading(true)
    try {
      const resolved = resolveOpenAIConfig({
        baseUrl: form.getFieldValue(configPath + '.baseUrl'),
        apiKey: form.getFieldValue(configPath + '.apiKey'),
        model: form.getFieldValue(configPath + '.model'),
        systemPrompt: form.getFieldValue(configPath + '.systemPrompt'),
        prompt: form.getFieldValue(configPath + '.prompt'),
        temperature: form.getFieldValue(configPath + '.temperature'),
        reasoningEffort: form.getFieldValue(configPath + '.reasoningEffort'),
        maxTokens: form.getFieldValue(configPath + '.maxTokens')
      })

      if (!resolved.apiKey || !resolved.baseUrl || !resolved.model) {
        message.error(t('dictAuth.openai.testMissing'))
        return
      }

      const translated = await openaiTranslate({
        ...resolved,
        text: 'Hello, world!',
        from: 'en',
        to: 'zh-CN'
      })

      if (translated) {
        message.success(t('dictAuth.openai.testSuccess') + ' ' + translated)
      } else {
        message.error(t('dictAuth.openai.testEmpty'))
      }
    } catch (e) {
      message.error(
        t('dictAuth.openai.testFailed') +
          (e instanceof Error ? ' ' + e.message : '')
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button size="small" type="link" loading={loading} onClick={onTest}>
      {t('dictAuth.openai.test')}
    </Button>
  )
}

/**
 * OpenAI (AI translation) needs a richer account form than the generic
 * key/value inputs: multiline prompts and a "test service" button.
 * Returns SaladictForm items to be spliced into DictAuths.
 */
export function getOpenAIAuthItems(
  t: (key: string) => string,
  configPath: string,
  title: string,
  url: string
): SaladictFormItem[] {
  return [
    {
      name: configPath + '.baseUrl',
      normalize: trimAuthValue,
      label: (
        <span>
          {title + ' '}
          <code>baseUrl</code>
        </span>
      ),
      children: (
        <Input autoComplete="off" placeholder="https://api.openai.com/v1" />
      )
    },
    {
      name: configPath + '.apiKey',
      normalize: trimAuthValue,
      label: (
        <span>
          <code>apiKey</code>
        </span>
      ),
      children: <Input.Password autoComplete="off" placeholder="sk-..." />
    },
    {
      name: configPath + '.model',
      normalize: trimAuthValue,
      label: (
        <span>
          <code>model</code>
        </span>
      ),
      children: <Input autoComplete="off" placeholder="gpt-5.4-nano" />
    },
    {
      name: configPath + '.systemPrompt',
      label: (
        <span>
          <code>systemPrompt</code>
        </span>
      ),
      children: <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} />
    },
    {
      name: configPath + '.prompt',
      label: (
        <span>
          <code>prompt</code>
        </span>
      ),
      help: t('dictAuth.openai.promptHelp'),
      children: <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} />
    },
    {
      name: configPath + '.temperature',
      normalize: trimAuthValue,
      label: (
        <span>
          <code>temperature</code>
        </span>
      ),
      children: <Input autoComplete="off" placeholder="0" />
    },
    {
      name: configPath + '.reasoningEffort',
      normalize: trimAuthValue,
      label: (
        <span>
          <code>reasoningEffort</code>
        </span>
      ),
      help: t('dictAuth.openai.reasoningEffortHelp'),
      children: (
        <Input
          autoComplete="off"
          placeholder="none | low | medium | high | xhigh"
        />
      )
    },
    {
      name: configPath + '.maxTokens',
      normalize: trimAuthValue,
      label: (
        <span>
          <code>maxTokens</code>
        </span>
      ),
      help: t('dictAuth.openai.maxTokensHelp'),
      children: <Input autoComplete="off" placeholder="0 = 不限制" />
    },
    {
      key: configPath + '.__test__',
      label: ' ',
      colon: false,
      style: { marginBottom: 10 },
      children: (
        <span className="ant-form-text">
          <a href={url} target="_blank" rel="nofollow noopener noreferrer">
            {title}
          </a>{' '}
          <Form.Item noStyle shouldUpdate>
            {form => (
              <OpenAITestButton
                form={form as FormInstance}
                configPath={configPath}
              />
            )}
          </Form.Item>
        </span>
      )
    }
  ]
}
