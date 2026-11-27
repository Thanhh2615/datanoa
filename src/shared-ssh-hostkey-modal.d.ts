import type {
  SshHostKeyChallenge,
  SshHostKeyDecision,
  SslMode,
  TlsFailure,
  TlsFailureKind,
} from './protocol.js'

export interface SshHostKeyResolveResponse {
  ok: boolean
  decision: SshHostKeyDecision
  savedPath?: string
  retryToken?: string
}

export interface SshHostKeyModalChallenge extends SshHostKeyChallenge {
  knownHostsReadOnly?: boolean
  retryToken?: string
}

export interface OpenSharedSshHostKeyModalOptions {
  challenge: SshHostKeyModalChallenge
  panelId?: string
  connectionId?: string
  resolveDecision?: (input: {
    challengeId: string
    decision: SshHostKeyDecision
  }) => Promise<SshHostKeyResolveResponse>
  onClose?: (decision: SshHostKeyDecision) => void
  onResolveResult?: (response: SshHostKeyResolveResponse) => void
}

export declare function openSharedSshHostKeyModal(
  options: OpenSharedSshHostKeyModalOptions
): Promise<SshHostKeyDecision>

export declare function closeByChallengeId(
  challengeId: string,
  decision?: SshHostKeyDecision
): boolean

export declare function closeAllSshHostKeyModals(): void

export declare const HARD_TLS_FAILURE_KINDS: ReadonlySet<TlsFailureKind>

export interface SharedTlsFailureRemedyOptions {
  displayMode?: 'flex' | 'hidden'
  hintClass?: string
  actionsClass?: string
  buttonClass?: string
  allowAutoSuggestedMode?: boolean
  onInspectCaCert?: (kind: 'CaFileInvalid' | 'UnknownIssuer') => void
  onInspectClientCert?: () => void
  onApplySslMode?: (mode: SslMode, retest: boolean) => void
  onSetServerName?: (serverName: string) => void
  onVerifyCaOnly?: () => void
  onInspectTls?: () => void
}

export declare function renderSharedTlsFailureRemedy(
  box: HTMLElement | null | undefined,
  failure: TlsFailure | null | undefined,
  options?: SharedTlsFailureRemedyOptions
): void

export interface SshRetryableResult {
  ok: boolean
  message?: string
  tlsFailure?: TlsFailure
  sshChallenge?: SshHostKeyModalChallenge
}

export interface SshRetryTrustedFingerprint {
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
}

export interface SshHostKeyRetryContext {
  scopeKey: string
  attempt: number
  retryAttempt: number
  sshRetryToken?: string
  getTrustedFingerprints: () => SshRetryTrustedFingerprint[]
}

export interface RunWithSshHostKeyRetryOptions<TResult extends SshRetryableResult = SshRetryableResult> {
  connectionId?: string
  panelId?: string
  jumpHosts?: readonly unknown[]
  maxHops?: number
  sshRetryToken?: string
  runAttempt: (context?: SshHostKeyRetryContext) => Promise<TResult>
  isActive?: () => boolean
  resolveDecision?: OpenSharedSshHostKeyModalOptions['resolveDecision']
}

export declare function runWithSshHostKeyRetry<TResult extends SshRetryableResult = SshRetryableResult>(
  options: RunWithSshHostKeyRetryOptions<TResult>
): Promise<TResult | SshRetryableResult>
