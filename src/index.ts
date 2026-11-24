import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The official Node.js client of the Notyza API (asked on 21/11/2026). Thin by design: each method is one route of
 * /v1 (docs: /llms-full.txt, OpenAPI: /v1/openapi.json), the errors carry the API's own `code` and Portuguese message,
 * and `verifyWebhook` checks the `Notyza-Signature` of a webhook. No dependencies; Node 18+ (global fetch).
 *
 *   const notyza = new Notyza({ apiKey: process.env.NOTYZA_API_KEY })
 *   const nota = await notyza.notas.issue({ id: 'pedido-1001', serviceCode: '040101', description: 'Consulta', valueCents: 25000 })
 */

export type Json = Record<string, any>

export interface NotyzaOptions {
  /** ek_test_… (no fiscal value) or ek_live_…. */
  apiKey: string
  /** Default: https://api.notyza.com.br. */
  baseUrl?: string
  fetch?: typeof fetch
  /** Per request, in milliseconds (default 60 s: the government can be slow). */
  timeoutMs?: number
}

/** An answer the API refused (4xx/5xx), with its `code` (stable) and `error` (the sentence to show). */
export class NotyzaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Json,
  ) {
    super(message)
    this.name = 'NotyzaError'
  }
}

/**
 * A document's answer: 200 issued, 202 still with the government (ask again with the same id, or wait for the
 * `nota.issued` webhook), 422 refused (`errors[].explanation` and `errors[].fix`). The status comes in `httpStatus`.
 */
export type DocumentResult = Json & { httpStatus: 200 | 202 | 422 }

export class Notyza {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: NotyzaOptions) {
    if (!/^ek_(test|live)_/.test(options.apiKey ?? '')) throw new Error('Notyza: apiKey precisa ser uma chave ek_test_… ou ek_live_….')
    this.baseUrl = (options.baseUrl ?? 'https://api.notyza.com.br').replace(/\/$/, '')
    this.fetchFn = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  /** The key's mode: test notas never have fiscal value. */
  get mode(): 'test' | 'live' {
    return this.options.apiKey.startsWith('ek_live_') ? 'live' : 'test'
  }

  /** Any route of /v1. Answers with the JSON; throws NotyzaError on 4xx/5xx except the ones listed in `accept`. */
  async request<T = Json>(method: string, path: string, body?: unknown, accept: number[] = []): Promise<T & { httpStatus: number }> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    let json: Json = {}
    try {
      json = text ? (JSON.parse(text) as Json) : {}
    } catch {
      json = { error: text.slice(0, 500) }
    }
    if (response.status >= 400 && !accept.includes(response.status)) {
      throw new NotyzaError(response.status, String(json.code ?? 'http_error'), String(json.error ?? `A API respondeu ${response.status}.`), json)
    }
    return { ...(json as T), httpStatus: response.status }
  }

  private async pdf(path: string): Promise<Uint8Array> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.options.apiKey}` }, signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as Json
      throw new NotyzaError(response.status, String(json.code ?? 'http_error'), String(json.error ?? `A API respondeu ${response.status}.`), json)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private static query(params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
    const text = search.toString()
    return text ? `?${text}` : ''
  }

  private static id(value: string) {
    return encodeURIComponent(value)
  }

  /** NFS-e (and every document through the generic routes: get, list, cancel, PDF). */
  readonly notas = {
    /** The same `id` never issues twice: asking again answers with the nota already there. */
    issue: (nota: Json): Promise<DocumentResult> => this.request('POST', '/v1/notas', nota, [422]) as Promise<DocumentResult>,
    get: (id: string, options: { issuer?: string; xml?: boolean } = {}) => this.request('GET', `/v1/notas/${Notyza.id(id)}${Notyza.query({ issuer: options.issuer, xml: options.xml ? 1 : undefined })}`),
    list: (filter: { issuer?: string; status?: string; model?: 'nfse' | 'nfe' | 'nfce' | 'mdfe' | 'cte'; q?: string; from?: string; to?: string; limit?: number; before?: string } = {}) =>
      this.request<{ notas: Json[]; total: number }>('GET', `/v1/notas${Notyza.query(filter)}`),
    cancel: (id: string, body: { issuer?: string; reasonCode?: '1' | '2' | '9'; reason?: string } = {}) => this.request('POST', `/v1/notas/${Notyza.id(id)}/cancel`, body, [422]) as Promise<DocumentResult>,
    substitute: (id: string, body: Json) => this.request('POST', `/v1/notas/${Notyza.id(id)}/substitute`, body, [422]) as Promise<DocumentResult>,
    pdf: (id: string, issuer?: string) => this.pdf(`/v1/notas/${Notyza.id(id)}/pdf${Notyza.query({ issuer })}`),
    /** Many at once: up to 500 notas as a .zip (pdf, xml, both) or a spreadsheet (csv). */
    export: (body: Json) => this.request('POST', '/v1/notas/export', body),
    /** Why the government refused (a nota of the account, or a code): the cause, the fix and the field. */
    diagnose: (body: { nota?: string; issuer?: string; code?: string; message?: string; model?: 'nfse' | 'nfe' | 'nfce' | 'mdfe' | 'cte' }) => this.request('POST', '/v1/diagnose', body),
  }

  /** NF-e (modelo 55). */
  readonly nfe = {
    issue: (nfe: Json): Promise<DocumentResult> => this.request('POST', '/v1/nfe', nfe, [422]) as Promise<DocumentResult>,
    get: (id: string, issuer?: string) => this.request('GET', `/v1/nfe/${Notyza.id(id)}${Notyza.query({ issuer })}`),
    cancel: (id: string, body: { issuer?: string; reason?: string } = {}) => this.request('POST', `/v1/nfe/${Notyza.id(id)}/cancel`, body, [422]) as Promise<DocumentResult>,
    correct: (id: string, body: { issuer?: string; text: string }) => this.request('POST', `/v1/nfe/${Notyza.id(id)}/correction`, body),
    returnSale: (id: string, body: Json) => this.request('POST', `/v1/nfe/${Notyza.id(id)}/return`, body, [422]) as Promise<DocumentResult>,
    /** Inutilização of a range of the NF-e series. 200 voided, 422 refused by SEFAZ. */
    voidNumbers: (body: { issuer?: string; from: number; to: number; reason: string }) => this.request('POST', '/v1/nfe/void', body, [422]),
    pdf: (id: string, issuer?: string) => this.pdf(`/v1/nfe/${Notyza.id(id)}/pdf${Notyza.query({ issuer })}`),
  }

  /** NFC-e (modelo 65, the retail counter). */
  readonly nfce = {
    issue: (nfce: Json): Promise<DocumentResult> => this.request('POST', '/v1/nfce', nfce, [422]) as Promise<DocumentResult>,
    get: (id: string, issuer?: string) => this.request('GET', `/v1/nfce/${Notyza.id(id)}${Notyza.query({ issuer })}`),
    cancel: (id: string, body: { issuer?: string; reason?: string } = {}) => this.request('POST', `/v1/nfce/${Notyza.id(id)}/cancel`, body, [422]) as Promise<DocumentResult>,
    voidNumbers: (body: { issuer?: string; from: number; to: number; reason: string }) => this.request('POST', '/v1/nfce/void', body, [422]),
    pdf: (id: string, issuer?: string) => this.pdf(`/v1/nfce/${Notyza.id(id)}/pdf${Notyza.query({ issuer })}`),
  }

  /** MDF-e (modelo 58, the trip's manifest of the own cargo). */
  /** CT-e (modelo 57): the document of each road freight of a carrier in the Simples. */
  readonly cte = {
    issue: (cte: Json): Promise<DocumentResult> => this.request('POST', '/v1/cte', cte, [422]) as Promise<DocumentResult>,
    get: (id: string, issuer?: string) => this.request('GET', `/v1/cte/${Notyza.id(id)}${Notyza.query({ issuer })}`),
    /** A carta de correção: [{ group, field, value, item? }]; never values, parties or dates. */
    correct: (id: string, corrections: Array<{ group: string; field: string; value: string; item?: number }>, issuer?: string) =>
      this.request('POST', `/v1/cte/${Notyza.id(id)}/correction`, { corrections, ...(issuer ? { issuer } : {}) }),
    cancel: (id: string, body: { issuer?: string; reason?: string } = {}) => this.request('POST', `/v1/cte/${Notyza.id(id)}/cancel`, body, [422]) as Promise<DocumentResult>,
    /** The value that was missing of an authorized freight (the same parties). */
    complement: (id: string, body: Json) => this.request('POST', `/v1/cte/${Notyza.id(id)}/complement`, body, [422]) as Promise<DocumentResult>,
    /** The same freight with what was wrong fixed; SEFAZ accepts it after the tomador's disagreement. */
    substitute: (id: string, body: Json) => this.request('POST', `/v1/cte/${Notyza.id(id)}/substitute`, body, [422]) as Promise<DocumentResult>,
    /** The tomador's side: the service of a CT-e it paid for was not as agreed. */
    disagree: (body: { issuer?: string; key: string; reason: string }) => this.request('POST', '/v1/cte/disagreement', body),
    pdf: (id: string, issuer?: string) => this.pdf(`/v1/cte/${Notyza.id(id)}/pdf${Notyza.query({ issuer })}`),
  }

  readonly mdfe = {
    issue: (mdfe: Json): Promise<DocumentResult> => this.request('POST', '/v1/mdfe', mdfe, [422]) as Promise<DocumentResult>,
    get: (id: string, issuer?: string) => this.request('GET', `/v1/mdfe/${Notyza.id(id)}${Notyza.query({ issuer })}`),
    close: (id: string, body: { issuer?: string; cityCode?: string; date?: string } = {}) => this.request('POST', `/v1/mdfe/${Notyza.id(id)}/close`, body),
    addDriver: (id: string, body: { issuer?: string; driver: string | { name: string; cpf: string } }) => this.request('POST', `/v1/mdfe/${Notyza.id(id)}/drivers`, body),
    cancel: (id: string, body: { issuer?: string; reason?: string } = {}) => this.request('POST', `/v1/mdfe/${Notyza.id(id)}/cancel`, body, [422]) as Promise<DocumentResult>,
    open: (issuer?: string) => this.request<{ mdfe: Json[] }>('GET', `/v1/mdfe/open${Notyza.query({ issuer })}`),
    pdf: (id: string, issuer?: string) => this.pdf(`/v1/mdfe/${Notyza.id(id)}/pdf${Notyza.query({ issuer })}`),
  }

  /** The companies (CNPJs) of the account. */
  readonly issuers = {
    create: (body: Json) => this.request('POST', '/v1/issuers', body),
    list: () => this.request<{ issuers: Json[] }>('GET', '/v1/issuers'),
    get: (id: string) => this.request('GET', `/v1/issuers/${Notyza.id(id)}`),
    update: (id: string, body: Json) => this.request('PATCH', `/v1/issuers/${Notyza.id(id)}`, body),
    health: (id: string, deep = false) => this.request('GET', `/v1/issuers/${Notyza.id(id)}/health${Notyza.query({ deep: deep ? 1 : undefined })}`),
    /** The onboarding's steps, done or not, with how to do each one. */
    checklist: (id: string) => this.request('GET', `/v1/issuers/${Notyza.id(id)}/checklist`),
    /** A one-use panel link (30 minutes) where the person sends the .pfx and its password. */
    certificateLink: (id: string) => this.request<{ url: string; expiresAt: string }>('POST', `/v1/issuers/${Notyza.id(id)}/certificate-link`),
    /** The .pfx itself (multipart). */
    uploadCertificate: async (id: string, pfx: Uint8Array, password: string) => {
      const form = new FormData()
      form.append('certificate', new Blob([pfx]), 'certificado.pfx')
      form.append('password', password)
      const response = await this.fetchFn(`${this.baseUrl}/v1/issuers/${Notyza.id(id)}/certificate`, { method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}` }, body: form })
      const json = (await response.json().catch(() => ({}))) as Json
      if (!response.ok) throw new NotyzaError(response.status, String(json.code ?? 'http_error'), String(json.error ?? `A API respondeu ${response.status}.`), json)
      return json
    },
    /** Production on (a live key only). */
    enableProduction: (id: string) => this.request('POST', `/v1/issuers/${Notyza.id(id)}/production`),
  }

  readonly webhooks = {
    create: (body: { url: string; events?: string[] }) => this.request<{ id: string; secret: string }>('POST', '/v1/webhooks', body),
    list: () => this.request('GET', '/v1/webhooks'),
    remove: (id: string) => this.request('DELETE', `/v1/webhooks/${Notyza.id(id)}`),
  }

  /** The free lookups (no key needed on the API side; the client sends it anyway). */
  readonly lookups = {
    city: (cityCode: string) => this.request('GET', `/v1/public/cities/${Notyza.id(cityCode)}`),
    serviceCodes: (q: string, limit = 20) => this.request<{ serviceCodes: Json[] }>('GET', `/v1/public/service-codes${Notyza.query({ q, limit })}`),
    ibsCbs: (serviceCode: string) => this.request('GET', `/v1/public/service-codes/${Notyza.id(serviceCode)}/ibs-cbs`),
    accessKey: (key: string) => this.request('GET', `/v1/public/access-keys/${Notyza.id(key.replace(/\s/g, ''))}`),
    taxId: (value: string) => this.request('POST', '/v1/public/tax-id', { value }),
  }
}

/**
 * Checks a webhook's `Notyza-Signature` (`t=<unix>,v1=<hex>[,v1=<hex>]`, HMAC-SHA256 of "<t>.<raw body>" with the
 * webhook's secret). Refuses signatures older than `toleranceSeconds` (default 5 minutes), against replays. Pass the raw
 * body exactly as received (a re-serialized JSON breaks the signature).
 */
export const verifyWebhook = (signatureHeader: string, rawBody: string | Uint8Array, secret: string, options: { toleranceSeconds?: number; now?: number } = {}): boolean => {
  const parts = signatureHeader.split(',').map((part) => part.trim())
  const timestamp = Number(parts.find((part) => part.startsWith('t='))?.slice(2))
  if (!Number.isFinite(timestamp)) return false
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'))
  return parts
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3))
      return given.length === expected.length && timingSafeEqual(given, expected)
    })
}

export default Notyza
