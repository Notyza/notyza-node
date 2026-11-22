import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Notyza, NotyzaError, verifyWebhook } from './index'

/** A fake API: answers by "METHOD /path" and records the calls. */
const fakeApi = (answers: Record<string, { status: number; body: unknown }>) => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method ?? 'GET'), url, headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const answer = answers[`${init.method ?? 'GET'} ${new URL(url).pathname}`] ?? { status: 404, body: { error: 'Rota não encontrada.', code: 'not_found' } }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('Notyza client', () => {
  it('refuses a key that is not a Notyza key', () => {
    expect(() => new Notyza({ apiKey: 'sk_x' })).toThrow(/ek_test_/)
    expect(new Notyza({ apiKey: 'ek_live_x' }).mode).toBe('live')
  })

  it('issues with the key, and answers 200 and 422 alike (with httpStatus)', async () => {
    const api = fakeApi({
      'POST /v1/notas': { status: 200, body: { id: 'pedido-1', status: 'issued' } },
      'POST /v1/nfe': { status: 422, body: { id: 'p2', status: 'rejected', errors: [{ code: '539', explanation: 'Número usado.' }] } },
    })
    const notyza = new Notyza({ apiKey: 'ek_test_abc', baseUrl: 'https://api.notyza.test/', fetch: api.fetch })
    const nota = await notyza.notas.issue({ id: 'pedido-1', serviceCode: '040101', description: 'Consulta', valueCents: 25000 })
    expect(nota).toMatchObject({ id: 'pedido-1', status: 'issued', httpStatus: 200 })
    expect(api.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.notyza.test/v1/notas', headers: { authorization: 'Bearer ek_test_abc' }, body: { id: 'pedido-1', valueCents: 25000 } })
    const refused = await notyza.nfe.issue({ id: 'p2' })
    expect(refused).toMatchObject({ status: 'rejected', httpStatus: 422 })
  })

  it('throws NotyzaError with the API code and sentence', async () => {
    const api = fakeApi({ 'POST /v1/issuers': { status: 403, body: { error: 'O plano Grátis permite 1 empresa.', code: 'plan_company_limit' } } })
    const notyza = new Notyza({ apiKey: 'ek_test_abc', baseUrl: 'https://api.notyza.test', fetch: api.fetch })
    const error = await notyza.issuers.create({ cnpj: '11222333000181' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotyzaError)
    expect(error).toMatchObject({ status: 403, code: 'plan_company_limit', message: 'O plano Grátis permite 1 empresa.' })
  })

  it('builds the query strings and the encoded ids', async () => {
    const api = fakeApi({ 'GET /v1/notas': { status: 200, body: { notas: [], total: 0 } }, 'GET /v1/mdfe/viagem%201': { status: 200, body: {} } })
    const notyza = new Notyza({ apiKey: 'ek_test_abc', baseUrl: 'https://api.notyza.test', fetch: api.fetch })
    await notyza.notas.list({ model: 'mdfe', status: 'issued', limit: 10 })
    expect(api.calls[0]?.url).toBe('https://api.notyza.test/v1/notas?model=mdfe&status=issued&limit=10')
    await notyza.mdfe.get('viagem 1')
    expect(api.calls[1]?.url).toBe('https://api.notyza.test/v1/mdfe/viagem%201')
  })
})

describe('verifyWebhook', () => {
  const secret = 'whsec_teste'
  const body = '{"type":"nota.issued","data":{"id":"pedido-1"}}'
  const sign = (t: number, key = secret) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`

  it('accepts the right signature, also during a secret rotation (two v1)', () => {
    expect(verifyWebhook(sign(1000), body, secret, { now: 1010 })).toBe(true)
    expect(verifyWebhook(`${sign(1000, 'whsec_novo')},v1=${sign(1000).split('v1=')[1]}`, body, secret, { now: 1010 })).toBe(true)
  })

  it('refuses a wrong secret, a changed body and an old signature', () => {
    expect(verifyWebhook(sign(1000, 'outro'), body, secret, { now: 1010 })).toBe(false)
    expect(verifyWebhook(sign(1000), `${body} `, secret, { now: 1010 })).toBe(false)
    expect(verifyWebhook(sign(1000), body, secret, { now: 1000 + 301 })).toBe(false)
    expect(verifyWebhook('lixo', body, secret)).toBe(false)
  })
})
