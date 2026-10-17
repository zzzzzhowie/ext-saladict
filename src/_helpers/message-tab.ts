import { message } from '@/_helpers/browser-api'
import { Message, MessageResponse, MsgType } from '@/typings/message'

export function isNoReceivingEndError(error: unknown): boolean {
  const runtimeError =
    error &&
    typeof error === 'object' &&
    error['runtimeLastError'] instanceof Error
      ? error['runtimeLastError']
      : error instanceof Error
      ? error
      : null

  return !!(
    runtimeError &&
    // The receiver is gone: either no content script is listening
    // ("Could not establish connection" / "Receiving end does not exist"),
    // or the target tab itself was closed between lookup and send
    // ("No tab with id: N" / "The tab was closed"). All are benign races.
    /Could not establish connection|Receiving end does not exist|No tab with id|tab was closed/.test(
      runtimeError.message
    )
  )
}

export async function trySendMessageToTab<
  T extends MsgType,
  R = MessageResponse<T>
>(tabId: number, msg: Message<T>): Promise<R | undefined> {
  try {
    return await message.send<T, R>(tabId, msg)
  } catch (error) {
    if (isNoReceivingEndError(error)) {
      return undefined
    }
    throw error
  }
}
