import React, { FC, useState } from 'react'
import { Input, Button, Form, Select, message } from 'antd'
import { FormInstance } from 'antd/lib/form'
import { useTranslate } from '@/_helpers/i18n'
import { SaladictFormItem } from '@/options/components/SaladictForm'
import {
  LLMAuthConfig,
  hasCredential,
  llmTranslate,
  resolveLLMConfig
} from '@/components/dictionaries/openai/engine'
import {
  PROVIDERS,
  PROVIDER_IDS,
  checkKeyFormat
} from '@/components/dictionaries/openai/providers/presets'

const trimAuthValue = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value

const AUTH_FIELDS: Array<keyof LLMAuthConfig> = [
  'provider',
  'model',
  'apiKey',
  'openrouterApiKey',
  'anthropicApiKey',
  'geminiApiKey',
  'deepseekApiKey',
  'baseUrl',
  'customApiKey',
  'systemPrompt',
  'prompt',
  'temperature',
  'reasoningEffort',
  'maxTokens'
]

/** The current (possibly unsaved) AI auth from the antd form. */
const readAuth = (form: FormInstance, configPath: string): LLMAuthConfig => {
  const auth: LLMAuthConfig = {}
  AUTH_FIELDS.forEach(key => {
    auth[key] = form.getFieldValue(configPath + '.' + key)
  })
  return auth
}

/** "Anthropic · claude-haiku-5-5", plus what's missing or wrong with the
 * routed provider's credentials. */
const RouteText: FC<{ form: FormInstance; configPath: string }> = ({
  form,
  configPath
}) => {
  const { t } = useTranslate(['options'])
  const resolved = resolveLLMConfig(readAuth(form, configPath))
  const preset = PROVIDERS[resolved.provider]
  let problem: React.ReactNode = null
  if (!resolved.baseUrl) {
    problem = (
      <>
        {t('dictAuth.openai.routeMissing')} <code>baseUrl</code>
      </>
    )
  } else if (resolved.keyRequired && !resolved.apiKey) {
    problem = (
      <>
        {t('dictAuth.openai.routeMissing')} <code>{preset.keyField}</code>
      </>
    )
  } else {
    const mismatch = checkKeyFormat(resolved.provider, resolved.apiKey)
    if (mismatch) {
      problem = (
        <>
          <code>{preset.keyField}</code>{' '}
          {mismatch.issuer
            ? t('dictAuth.openai.routeKeyIssuer', {
                provider: PROVIDERS[mismatch.issuer].label
              })
            : t('dictAuth.openai.routeKeyPrefix', {
                prefix: mismatch.expectedPrefix
              })}
        </>
      )
    }
  }
  return (
    <span className="ant-form-text">
      {preset.label} · <code>{resolved.model}</code>
      {problem ? <span style={{ color: '#f5222d' }}> — {problem}</span> : null}
    </span>
  )
}

const TestButton: FC<{
  form: FormInstance
  configPath: string
}> = ({ form, configPath }) => {
  const { t } = useTranslate(['options'])
  const [loading, setLoading] = useState(false)

  const onTest = async () => {
    setLoading(true)
    try {
      const resolved = resolveLLMConfig(readAuth(form, configPath))

      if (!hasCredential(resolved)) {
        message.error(t('dictAuth.openai.testMissing'))
        return
      }

      const translated = await llmTranslate(resolved, {
        text: 'Hello, world!',
        from: 'en',
        to: 'zh-CN'
      })

      if (translated) {
        message.success(
          `${t('dictAuth.openai.testSuccess')}${translated} (${
            PROVIDERS[resolved.provider].label
          } · ${resolved.model})`
        )
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

const codeLabel = (name: string, prefix = '') => (
  <span>
    {prefix}
    <code>{name}</code>
  </span>
)

/** Labels are just the field name (it already names the provider), except
 * the OpenAI key, which kept its original name `apiKey`. */
const keyItem = (
  configPath: string,
  field: string,
  placeholder = '',
  prefix = ''
) => ({
  name: configPath + '.' + field,
  normalize: trimAuthValue,
  label: codeLabel(field, prefix ? prefix + ' ' : ''),
  children: <Input.Password autoComplete="off" placeholder={placeholder} />
})

/**
 * The AI translate dict needs a richer account form than the generic
 * key/value inputs: a model-routed provider, one key per provider, multiline
 * prompts and a "test service" button.
 * Returns SaladictForm items to be spliced into DictAuths.
 */
export function getOpenAIAuthItems(
  t: (key: string) => string,
  configPath: string,
  title: string,
  url: string
): SaladictFormItem[] {
  const providerPath = configPath + '.provider'
  const providerIs = (...ids: string[]) => (values: any) =>
    ids.includes(values[providerPath])

  return [
    {
      name: configPath + '.model',
      normalize: trimAuthValue,
      label: codeLabel('model', title + ' '),
      help: t('dictAuth.openai.modelHelp'),
      children: (
        <Input
          autoComplete="off"
          placeholder="gpt-5.4-nano · claude-haiku-5-5 · openai/gpt-5.4-nano"
        />
      )
    },
    {
      name: providerPath,
      label: codeLabel('provider'),
      help: t('dictAuth.openai.providerHelp'),
      children: (
        <Select>
          <Select.Option value="auto">
            {t('dictAuth.openai.providerAuto')}
          </Select.Option>
          {PROVIDER_IDS.map(id => (
            <Select.Option key={id} value={id}>
              {id === 'custom'
                ? t('dictAuth.openai.providerCustom')
                : PROVIDERS[id].label}
            </Select.Option>
          ))}
        </Select>
      )
    },
    {
      key: configPath + '.__route__',
      label: t('dictAuth.openai.route'),
      children: (
        <Form.Item noStyle shouldUpdate>
          {form => (
            <RouteText form={form as FormInstance} configPath={configPath} />
          )}
        </Form.Item>
      )
    },
    keyItem(configPath, 'apiKey', 'sk-proj-…', 'OpenAI'),
    keyItem(configPath, 'openrouterApiKey', 'sk-or-…'),
    keyItem(configPath, 'anthropicApiKey', 'sk-ant-…'),
    keyItem(configPath, 'geminiApiKey', 'AIza…'),
    keyItem(configPath, 'deepseekApiKey', 'sk-…'),
    {
      name: configPath + '.baseUrl',
      normalize: trimAuthValue,
      label: codeLabel('baseUrl'),
      help: t('dictAuth.openai.baseUrlHelp'),
      hide: values => !providerIs('custom', 'ollama')(values),
      children: (
        <Input autoComplete="off" placeholder={PROVIDERS.ollama.baseUrl} />
      )
    },
    {
      ...keyItem(configPath, 'customApiKey'),
      hide: values => !providerIs('custom')(values)
    },
    {
      name: configPath + '.systemPrompt',
      label: codeLabel('systemPrompt'),
      children: <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} />
    },
    {
      name: configPath + '.prompt',
      label: codeLabel('prompt'),
      help: t('dictAuth.openai.promptHelp'),
      children: <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} />
    },
    {
      name: configPath + '.temperature',
      normalize: trimAuthValue,
      label: codeLabel('temperature'),
      children: <Input autoComplete="off" placeholder="0" />
    },
    {
      name: configPath + '.reasoningEffort',
      normalize: trimAuthValue,
      label: codeLabel('reasoningEffort'),
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
      label: codeLabel('maxTokens'),
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
              <TestButton form={form as FormInstance} configPath={configPath} />
            )}
          </Form.Item>
        </span>
      )
    }
  ]
}
