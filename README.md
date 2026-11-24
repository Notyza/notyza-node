# Notyza para Node.js

O cliente oficial da API do [Notyza](https://notyza.com.br): NFS-e, NF-e, NFC-e e MDF-e para empresas do Simples Nacional, e a
conferência dos webhooks assinados. TypeScript, sem dependências, Node 18+.

## Instalar

```bash
npm install @notyza/sdk
```

[![npm](https://img.shields.io/npm/v/@notyza/sdk)](https://www.npmjs.com/package/@notyza/sdk)

## Emitir

```ts
import { Notyza } from '@notyza/sdk'

const notyza = new Notyza({ apiKey: process.env.NOTYZA_API_KEY! })

const nota = await notyza.notas.issue({
  id: 'pedido-1001', // o id do seu pedido: o mesmo id nunca emite duas vezes
  serviceCode: '040101',
  description: 'Consulta médica',
  valueCents: 25000,
})

if (nota.httpStatus === 422) {
  for (const error of nota.errors) console.log(error.explanation, error.fix)
}
```

Também: `notyza.nfe`, `notyza.nfce`, `notyza.mdfe` (emitir, consultar, cancelar, PDF, carta de correção, devolução,
inutilizar números, encerrar viagem), `notyza.issuers` (empresas, checklist, link do certificado), `notyza.webhooks`,
`notyza.notas.diagnose` (por que o governo recusou) e `notyza.lookups` (cidade na NFS-e Nacional, códigos de serviço,
IBS/CBS, chave de acesso, CPF/CNPJ). Qualquer outra rota: `notyza.request(method, path, body)`.

## Webhooks

```ts
import { verifyWebhook } from '@notyza/sdk'

// O corpo cru, exatamente como chegou (um JSON reserializado quebra a assinatura).
if (!verifyWebhook(req.headers['notyza-signature'], rawBody, process.env.NOTYZA_WEBHOOK_SECRET!)) return res.status(401).end()
```

## Respostas

- **200**: emitida. **202**: ainda com o governo; pergunte de novo com o mesmo `id` (nunca emite duas vezes) ou espere o webhook `nota.issued`.
- **422**: recusada. Vem como resposta, não como erro: mostre `errors[].explanation` e `errors[].fix` (a causa e como corrigir, em português).
- Qualquer outro 4xx/5xx vira exceção com o `code` estável da API (`plan_company_limit`, `payment_required`…) e a frase para mostrar.
- Chave `ek_test_…`: produção restrita do governo, sem valor fiscal. `ek_live_…`: notas de verdade.

Documentação completa: https://notyza.com.br/docs (também em `/llms-full.txt` para assistentes de IA). OpenAPI: https://api.notyza.com.br/v1/openapi.json.

## Licença

MIT.
