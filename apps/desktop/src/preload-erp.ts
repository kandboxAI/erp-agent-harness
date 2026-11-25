/** Minimal bridge available only to the ERP document's top frame. */
import { contextBridge, ipcRenderer } from 'electron'
import type { ErpQuestionContext } from './erp-assistant-context.ts'

const CHANNEL = 'erp-desktop:open-dsh'
const ASSISTANT_CHANNEL = 'erp-desktop:assistant'
type AssistantBounds = { x: number; y: number; width: number; height: number }
type AssistantPreview = { dataUrl: string; bounds: AssistantBounds }

if (process.isMainFrame && (location.origin === 'dsh-app://erp'
  || (location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)))) {
  let preview: HTMLImageElement | undefined
  let previewRequest = 0
  const clearPreview = (): void => {
    previewRequest += 1
    preview?.remove()
    preview = undefined
  }
  const setAssistantObscured = async (obscured: boolean): Promise<void> => {
    const request = ++previewRequest
    if (obscured && preview === undefined) {
      try {
        const snapshot = await ipcRenderer.invoke(ASSISTANT_CHANNEL, 'preview') as AssistantPreview | undefined
        if (request !== previewRequest) return
        if (snapshot !== undefined) {
          const image = document.createElement('img')
          image.alt = ''
          image.setAttribute('data-erp-assistant-preview', '')
          image.src = snapshot.dataUrl
          const { x, y, width, height } = snapshot.bounds
          Object.assign(image.style, {
            position: 'fixed', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
            pointerEvents: 'none', zIndex: '1',
          })
          await image.decode()
          // 设置可能在截图返回前关闭；旧请求不能再次隐藏助手。
          if (request !== previewRequest) return
          preview = image
          document.body.append(image)
          // 先绘制静态预览，再隐藏原生视图，避免露出下方的加载占位。
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
          })
        }
      } catch (error) {
        console.warn('ERP desktop: assistant preview unavailable', error)
      }
    }
    if (request !== previewRequest) return
    await ipcRenderer.invoke(ASSISTANT_CHANNEL, obscured ? 'obscure' : 'reveal')
    if (!obscured && request === previewRequest) clearPreview()
  }
  contextBridge.exposeInMainWorld('erpDesktop', {
    assistantContextVersion: 1,
    bindErpSession: (accessToken: string) => ipcRenderer.invoke('erp-desktop:erp-session', 'bind', accessToken) as Promise<void>,
    clearErpSession: () => { clearPreview(); return ipcRenderer.invoke('erp-desktop:erp-session', 'clear') as Promise<void> },
    onErpSessionExpired: (listener: () => void) => {
      const handle = () => { listener() }
      ipcRenderer.on('erp-desktop:erp-session-expired', handle)
      return () => { ipcRenderer.off('erp-desktop:erp-session-expired', handle) }
    },
    onNavigate: (listener: (command: unknown) => void) => {
      const handle = (_event: unknown, command: unknown) => { listener(command) }
      ipcRenderer.on('erp-desktop:navigate', handle)
      return () => { ipcRenderer.off('erp-desktop:navigate', handle) }
    },
    acknowledgeNavigation: (ack: object) => ipcRenderer.invoke('erp-desktop:navigation-ack', ack) as Promise<void>,
    openAssistant: (bounds: AssistantBounds, prompt?: string, context?: ErpQuestionContext) => ipcRenderer.invoke(ASSISTANT_CHANNEL, 'open', bounds, prompt, context) as Promise<void>,
    openRecentAssistant: (bounds: AssistantBounds) => ipcRenderer.invoke(ASSISTANT_CHANNEL, 'recent', bounds) as Promise<void>,
    updateAssistantBounds: (bounds: AssistantBounds) => ipcRenderer.invoke(ASSISTANT_CHANNEL, 'bounds', bounds) as Promise<void>,
    setAssistantObscured,
    closeAssistant: () => { clearPreview(); return ipcRenderer.invoke(ASSISTANT_CHANNEL, 'close') as Promise<void> },
    onAssistantFailed: (listener: () => void) => {
      const handle = () => { clearPreview(); listener() }
      ipcRenderer.on('erp-desktop:assistant-failed', handle)
      return () => { ipcRenderer.off('erp-desktop:assistant-failed', handle) }
    },
    openFullDsh: () => ipcRenderer.invoke(CHANNEL, 'full') as Promise<void>,
    openAgentPage: () => ipcRenderer.invoke(CHANNEL, 'agent') as Promise<void>,
  })
}
