import { XApiClient } from '../client.ts'
import type { XHttpTransport, XPublishFailure } from '../types.ts'
import { X_TOKEN_URL, type XOAuthTokenResponse } from './types.ts'

const DEFAULT_TIMEOUT_MS = 15_000

export interface XOAuthClientOptions {
  transport?: XHttpTransport | undefined
  timeoutMs?: number | undefined
}

export class XOAuthClient {
  private readonly transport: XHttpTransport
  private readonly timeoutMs: number
  private readonly apiClient: XApiClient

  constructor(options?: XOAuthClientOptions) {
    this.transport = options?.transport ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.apiClient = new XApiClient({
      transport: this.transport,
      timeoutMs: this.timeoutMs,
    })
  }

  /**
   * Exchanges an authorization code and PKCE code_verifier for an OAuth 2.0 access token (and optional refresh token).
   * Performs exactly ONE attempt with bounded timeout. No automatic retries.
   */
  async exchangeAuthorizationCode(options: {
    code: string
    codeVerifier: string
    clientId: string
    redirectUri: string
  }): Promise<
    | {
        ok: true
        data: XOAuthTokenResponse
      }
    | XPublishFailure
  > {
    const { code, codeVerifier, clientId, redirectUri } = options

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Missing or empty authorization code.',
      }
    }

    if (!codeVerifier || typeof codeVerifier !== 'string' || codeVerifier.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Missing or empty PKCE code_verifier.',
      }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const bodyParams = new URLSearchParams()
      bodyParams.set('grant_type', 'authorization_code')
      bodyParams.set('code', code.trim())
      bodyParams.set('client_id', clientId.trim())
      bodyParams.set('redirect_uri', redirectUri.trim())
      bodyParams.set('code_verifier', codeVerifier.trim())

      const response = await this.transport(X_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyParams.toString(),
        signal: controller.signal,
      })

      if (!response.ok) {
        return this.normalizeHttpError(response)
      }

      interface RawTokenResponse {
        access_token?: unknown
        token_type?: unknown
        expires_in?: unknown
        scope?: unknown
        refresh_token?: unknown
      }

      let parsed: RawTokenResponse
      try {
        parsed = (await response.json()) as RawTokenResponse
      } catch {
        return {
          ok: false,
          code: 'provider_error',
          message: 'Malformed JSON response from X token endpoint.',
        }
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.access_token !== 'string' ||
        parsed.access_token.trim().length === 0
      ) {
        return {
          ok: false,
          code: 'provider_error',
          message: 'X token endpoint response is missing access_token.',
        }
      }

      const tokenResponse: XOAuthTokenResponse = {
        access_token: parsed.access_token.trim(),
      }

      if (typeof parsed.token_type === 'string' && parsed.token_type.trim().length > 0) {
        tokenResponse.token_type = parsed.token_type.trim()
      }

      if (typeof parsed.expires_in === 'number' && parsed.expires_in > 0) {
        tokenResponse.expires_in = parsed.expires_in
      } else if (typeof parsed.expires_in === 'string') {
        const parsedSec = Number.parseInt(parsed.expires_in, 10)
        if (!Number.isNaN(parsedSec) && parsedSec > 0) {
          tokenResponse.expires_in = parsedSec
        }
      }

      if (typeof parsed.scope === 'string' && parsed.scope.trim().length > 0) {
        tokenResponse.scope = parsed.scope.trim()
      }

      if (typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim().length > 0) {
        tokenResponse.refresh_token = parsed.refresh_token.trim()
      }

      return {
        ok: true,
        data: tokenResponse,
      }
    } catch (error) {
      return this.normalizeException(error)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Fetches authenticated user identity via GET /2/users/me using the newly exchanged access token.
   */
  async getAuthenticatedUser(
    userAccessToken: string,
  ): Promise<
    { ok: true; data: { id: string; username: string; name?: string } } | XPublishFailure
  > {
    return this.apiClient.getAuthenticatedUser(userAccessToken)
  }

  private normalizeHttpError(response: Response): XPublishFailure {
    const status = response.status
    if (status === 429) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'X API token endpoint rate limit exceeded.',
      }
    }

    if (status === 400) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'X API rejected token exchange request as invalid or expired.',
      }
    }

    if (status === 401) {
      return {
        ok: false,
        code: 'unauthorized',
        message: 'X API client authentication failed.',
      }
    }

    if (status === 403) {
      return {
        ok: false,
        code: 'forbidden',
        message: 'X API forbidden or app permissions restricted.',
      }
    }

    return {
      ok: false,
      code: 'provider_error',
      message: `X token endpoint returned error status ${status}.`,
    }
  }

  private normalizeException(error: unknown): XPublishFailure {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))

    if (isAbort) {
      return {
        ok: false,
        code: 'timeout',
        message: 'X API token request timed out.',
      }
    }

    return {
      ok: false,
      code: 'network_error',
      message: 'Network error connecting to X API token endpoint.',
    }
  }
}
