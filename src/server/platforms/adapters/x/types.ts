import type { PlatformCredential } from '../../types.ts'

export type XHttpTransport = (url: string, init: RequestInit) => Promise<Response>

export interface XUserMeResponse {
  data?: {
    id?: string
    name?: string
    username?: string
  }
  errors?: Array<{
    message?: string
    code?: number
    [key: string]: unknown
  }>
  title?: string
  detail?: string
  type?: string
  status?: number
}

export interface XCreateTweetResponse {
  data?: {
    id?: string
    text?: string
  }
  errors?: Array<{
    message?: string
    code?: number
    [key: string]: unknown
  }>
  title?: string
  detail?: string
  type?: string
  status?: number
}

export type XPublishErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'network_error'
  | 'ambiguous_external_result'
  | 'account_identity_mismatch'
  | 'unsupported_content'
  | 'not_configured'

export interface XPublishSuccess {
  ok: true
  externalId: string
  url: string | null
  text: string
  rateLimit?:
    | {
        limit?: number | undefined
        remaining?: number | undefined
        reset?: number | undefined
      }
    | undefined
}

export interface XPublishFailure {
  ok: false
  code: XPublishErrorCode
  message: string
  retryAfterMs?: number | undefined
  ambiguous?: boolean | undefined
}

export type XPublishResult = XPublishSuccess | XPublishFailure

export interface XPublishTextInput {
  text: string
  expectedAccountHandle: string
  trustedProviderUserId?: string | null | undefined
  credential: PlatformCredential
}
