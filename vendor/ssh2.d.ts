import type { Duplex } from 'node:stream'

export interface Ssh2ConnectConfig {
  host?: string
  port?: number
  sock?: Duplex
  username?: string
  password?: string
  privateKey?: Buffer | string
  passphrase?: string
  agent?: string
  tryKeyboard?: boolean
  readyTimeout?: number
  keepaliveInterval?: number
  keepaliveCountMax?: number
  hostHash?: 'sha256' | 'md5'
  hostVerifier?: (key: Buffer | string, verify?: (valid: boolean) => void) => boolean | void
  algorithms?: {
    serverHostKey?: string[]
  }
}

export interface Ssh2ClientChannel extends Duplex {
  close(): void
}

export interface Ssh2KeyboardInteractivePrompt {
  prompt: string
  echo?: boolean
}

export declare class Client {
  constructor()
  connect(config: Ssh2ConnectConfig): this
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ClientChannel) => void
  ): this
  end(): this
  destroy(): this
  on(event: 'ready' | 'close' | 'end', listener: () => void): this
  on(event: 'error', listener: (err: Error & { level?: string; code?: string }) => void): this
  on(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      instructionsLang: string,
      prompts: Ssh2KeyboardInteractivePrompt[],
      finish: (responses: string[]) => void
    ) => void
  ): this
  on(event: string, listener: (...args: unknown[]) => void): this
  once(event: 'ready' | 'close' | 'end', listener: () => void): this
  once(event: 'error', listener: (err: Error & { level?: string; code?: string }) => void): this
  once(event: string, listener: (...args: unknown[]) => void): this
  removeAllListeners(event?: string): this
}

export interface Ssh2ParsedKey {
  type: string
  comment: string
  getPublicSSH(): Buffer
}

export declare function parseKey(
  data: Buffer | string,
  passphrase?: string
): Ssh2ParsedKey | Ssh2ParsedKey[] | Error

declare const _default: {
  Client: typeof Client
  parseKey: typeof parseKey
}
export default _default
