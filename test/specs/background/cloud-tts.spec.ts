const mockPlayAudio = jest.fn((src?: string) => Promise.resolve())

jest.mock('@/background/dom-task-bridge', () => ({
  getDomTaskBridge: () => ({ playAudio: mockPlayAudio })
}))

import {
  playPronunciation,
  synthesizeFromIPA
} from '@/background/cloud-tts'

const plainTTS = (word: string) =>
  'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
  encodeURIComponent(word)

describe('cloud tts pronunciation', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    mockPlayAudio.mockClear()
    fetchMock.mockReset()
    ;(global as any).fetch = fetchMock
    process.env.GOOGLE_CLOUD_TTS_API_KEY = 'test-key'
  })

  afterAll(() => {
    delete process.env.GOOGLE_CLOUD_TTS_API_KEY
  })

  it('synthesizes the word from its IPA with a WaveNet voice', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audioContent: 'QUJD' })
    })

    await playPronunciation({ text: 'kadane', ipa: 'kəˈdeɪn' })

    expect(mockPlayAudio).toHaveBeenCalledWith('data:audio/mpeg;base64,QUJD')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://texttospeech.googleapis.com/v1/text:synthesize?key=test-key'
    )
    const body = JSON.parse(init.body)
    expect(body.input.ssml).toBe(
      '<speak><phoneme alphabet="ipa" ph="kəˈdeɪn">kadane</phoneme></speak>'
    )
    expect(body.voice.name).toMatch(/^en-US-Wavenet-/)
  })

  it('serves a repeated lookup from the cache', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audioContent: 'WFla' })
    })

    const first = await synthesizeFromIPA('arcane', 'ɑrˈkeɪn')
    const second = await synthesizeFromIPA('arcane', 'ɑːɹˈkeɪn')

    expect(first).toBe('data:audio/mpeg;base64,WFla')
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ignores repeat clicks while the first synthesis is in flight', async () => {
    let respond: (value: any) => void = () => {}
    fetchMock.mockReturnValue(new Promise(resolve => (respond = resolve)))

    const first = playPronunciation({ text: 'parity', ipa: 'ˈpærɪti' })
    const second = playPronunciation({ text: 'parity', ipa: 'ˈpærɪti' })
    await second
    respond({ ok: true, json: () => Promise.resolve({ audioContent: 'UEFS' }) })
    await first

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockPlayAudio).toHaveBeenCalledTimes(1)
    expect(mockPlayAudio).toHaveBeenCalledWith('data:audio/mpeg;base64,UEFS')

    // once it has played, clicking again replays (from the cache)
    await playPronunciation({ text: 'parity', ipa: 'ˈpærɪti' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockPlayAudio).toHaveBeenCalledTimes(2)
  })

  it('falls back to Google Translate TTS without IPA', async () => {
    await playPronunciation({ text: 'kadane' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockPlayAudio).toHaveBeenCalledWith(plainTTS('kadane'))
  })

  it('falls back to Google Translate TTS without an API key', async () => {
    delete process.env.GOOGLE_CLOUD_TTS_API_KEY
    await playPronunciation({ text: 'kadane', ipa: 'kəˈdeɪn' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockPlayAudio).toHaveBeenCalledWith(plainTTS('kadane'))
  })

  it('falls back to Google Translate TTS when the IPA is unusable', async () => {
    await playPronunciation({ text: 'bach', ipa: 'bɑx' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockPlayAudio).toHaveBeenCalledWith(plainTTS('bach'))
  })

  it('falls back to Google Translate TTS when Cloud TTS fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('API key not valid')
    })

    await playPronunciation({ text: 'mundane', ipa: 'mʌnˈdeɪn' })

    expect(mockPlayAudio).toHaveBeenCalledWith(plainTTS('mundane'))
    warn.mockRestore()
  })
})
