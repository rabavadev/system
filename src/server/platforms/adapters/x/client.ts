import type {
  XCreateTweetResponse,
  XHttpTransport,
  XPublishFailure,
  XUserMeResponse,
} from './types.ts'

export const X_USERS_ME_URL = 'https://api.x.com/2/users/me'
export const X_CREATE_TWEET_URL = 'https://api.x.com/2/tweets'

const DEFAULT_TIMEOUT_MS = 15_000

export interface XXClientOptions {
  transport?: XHttpTransport
  timeoutMs?: number
}

export class XApiClient {
  private readonly transport: XHttpTransport
  private readonly timeoutMs: number

  constructor(options?: XXClientOptions) {
    this.transport = options?.transport ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Fetches authenticated user identity via GET /2/users/me.
   */
  async getAuthenticatedUser(
    userAccessToken: string,
  ): Promise<
    { ok: true; data: { id: string; username: string; name?: string } } | XPublishFailure
  > {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.transport(X_USERS_ME_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        return this.normalizeHttpError(response, false)
      }

      let parsed: XUserMeResponse
      try {
        parsed = (await response.json()) as XUserMeResponse
      } catch {
        return {
          ok: false,
          code: 'provider_error',
          message: 'Malformed response from X user identity endpoint.',
        }
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.data ||
        typeof parsed.data !== 'object' ||
        typeof parsed.data.id !== 'string' ||
        parsed.data.id.trim().length === 0 ||
        typeof parsed.data.username !== 'string' ||
        parsed.data.username.trim().length === 0
      ) {
        return {
          ok: false,
          code: 'provider_error',
          message: 'X user identity endpoint returned incomplete data.',
        }
      }

      const userData: { id: string; username: string; name?: string } = {
        id: parsed.data.id.trim(),
        username: parsed.data.username.trim(),
      }
      if (parsed.data.name && parsed.data.name.trim().length > 0) {
        userData.name = parsed.data.name.trim()
      }

      return {
        ok: true,
        data: userData,
      }
    } catch (error) {
      return this.normalizeException(error, false)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Creates a text tweet via POST /2/tweets.
   * Performs exactly ONE attempt with bounded timeout.
   */
  async createTweet(
    userAccessToken: string,
    text: string,
  ): Promise<
    | {
        ok: true
        data: { id: string; text?: string }
        rateLimit?: { limit?: number; remaining?: number; reset?: number }
      }
    | XPublishFailure
  > {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.transport(X_CREATE_TWEET_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })

      // Strict check: X Create Tweet requires HTTP 201 Created
      if (response.status !== 201) {
        return this.normalizeHttpError(response, true)
      }

      let parsed: XCreateTweetResponse
      try {
        parsed = (await response.json()) as XCreateTweetResponse
      } catch {
        return {
          ok: false,
          code: 'provider_error',
          message: 'Malformed response from X tweet creation endpoint.',
          ambiguous: true,
        }
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.data ||
        typeof parsed.data !== 'object' ||
        typeof parsed.data.id !== 'string' ||
        parsed.data.id.trim().length === 0
      ) {
        return {
          ok: false,
          code: 'provider_error',
          message: 'X tweet creation endpoint returned missing or invalid tweet ID.',
          ambiguous: true,
        }
      }

      const tweetData: { id: string; text?: string } = {
        id: parsed.data.id.trim(),
      }
      if (typeof parsed.data.text === 'string') {
        tweetData.text = parsed.data.text
      }

      const rateLimit: { limit?: number; remaining?: number; reset?: number } = {}
      const limitHeader = response.headers?.get('x-rate-limit-limit')
      const remainingHeader = response.headers?.get('x-rate-limit-remaining')
      const resetHeader = response.headers?.get('x-rate-limit-reset')
      if (limitHeader) rateLimit.limit = Number.parseInt(limitHeader, 10)
      if (remainingHeader) rateLimit.remaining = Number.parseInt(remainingHeader, 10)
      if (resetHeader) rateLimit.reset = Number.parseInt(resetHeader, 10)

      const result: {
        ok: true
        data: { id: string; text?: string }
        rateLimit?: { limit?: number; remaining?: number; reset?: number }
      } = {
        ok: true,
        data: tweetData,
      }
      if (Object.keys(rateLimit).length > 0) {
        result.rateLimit = rateLimit
      }

      return result
    } catch (error) {
      return this.normalizeException(error, true)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private normalizeHttpError(response: Response, isPostRequest: boolean): XPublishFailure {
    const status = response.status
    let retryAfterMs: number | undefined

    if (status === 429) {
      const retryAfterHeader = response.headers?.get('retry-after')
      const resetHeader = response.headers?.get('x-rate-limit-reset')
      if (retryAfterHeader) {
        const sec = Number.parseInt(retryAfterHeader, 10)
        if (!Number.isNaN(sec) && sec > 0) {
          retryAfterMs = sec * 1000
        }
      } else if (resetHeader) {
        const resetUnixSec = Number.parseInt(resetHeader, 10)
        if (!Number.isNaN(resetUnixSec) && resetUnixSec > 0) {
          const nowUnixSec = Math.floor(Date.now() / 1000)
          const diffSec = Math.max(0, resetUnixSec - nowUnixSec)
          retryAfterMs = diffSec * 1000
        }
      }

      const failure: XPublishFailure = {
        ok: false,
        code: 'rate_limited',
        message: 'X API rate limit exceeded.',
      }
      if (retryAfterMs !== undefined) {
        failure.retryAfterMs = retryAfterMs
      }
      return failure
    }

    if (status === 400) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'X API rejected tweet request as invalid or malformed.',
      }
    }

    if (status === 401) {
      return {
        ok: false,
        code: 'unauthorized',
        message: 'X API authentication failed: invalid, revoked, or expired user access token.',
      }
    }

    if (status === 403) {
      return {
        ok: false,
        code: 'forbidden',
        message:
          'X API authorization failed: token lacks required tweet.write scope or account is restricted.',
      }
    }

    if (status >= 500) {
      return {
        ok: false,
        code: 'provider_error',
        message: `X service returned error status ${status}.`,
        ambiguous: isPostRequest,
      }
    }

    return {
      ok: false,
      code: 'provider_error',
      message: `X API returned unexpected status ${status}.`,
      ambiguous: isPostRequest,
    }
  }

  private normalizeException(error: unknown, isPostRequest: boolean): XPublishFailure {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))

    if (isAbort) {
      return {
        ok: false,
        code: 'timeout',
        message: 'X API request timed out.',
        ambiguous: isPostRequest,
      }
    }

    return {
      ok: false,
      code: 'network_error',
      message: 'Network error connecting to X API.',
      ambiguous: isPostRequest,
    }
  }
}
