import { browser } from '../../helper'

describe('offscreen audio player', () => {
  const bakAudio = (window as any).Audio
  const instances: any[] = []
  const MockAudio = jest.fn((src: string) => {
    const instance: any = {
      src,
      play: jest.fn(() => Promise.resolve()),
      pause: jest.fn()
    }
    instances.push(instance)
    return instance
  })

  let onMessage: (msg: any) => Promise<any> | undefined
  const play = (src: string) =>
    onMessage({ type: 'SALADICT_OFFSCREEN_TASK', task: 'PLAY_AUDIO', src })

  beforeAll(() => {
    ;(window as any).Audio = MockAudio
    browser.runtime.onMessage.addListener.resetHistory()
    jest.isolateModules(() => {
      require('@/offscreen/index')
    })
    onMessage = browser.runtime.onMessage.addListener.lastCall.args[0]
  })

  afterAll(() => {
    ;(window as any).Audio = bakAudio
  })

  beforeEach(async () => {
    await onMessage({ type: 'SALADICT_OFFSCREEN_TASK', task: 'STOP_AUDIO' })
    MockAudio.mockClear()
    instances.length = 0
  })

  it('replays the same clip once the previous playback has ended', async () => {
    await play('https://e.a/kadane.mp3')
    instances[0].onended()

    await play('https://e.a/kadane.mp3')

    expect(MockAudio).toHaveBeenCalledTimes(2)
    expect(instances[1].play).toHaveBeenCalledTimes(1)
  })

  it('replays the same clip after a playback error', async () => {
    await play('https://e.a/kadane.mp3')
    instances[0].onerror()

    await play('https://e.a/kadane.mp3')

    expect(MockAudio).toHaveBeenCalledTimes(2)
  })

  it('stops the clip when the same speaker is clicked while it plays', async () => {
    await play('https://e.a/kadane.mp3')

    await play('https://e.a/kadane.mp3')

    expect(MockAudio).toHaveBeenCalledTimes(1)
    expect(instances[0].pause).toHaveBeenCalledTimes(1)
  })
})
