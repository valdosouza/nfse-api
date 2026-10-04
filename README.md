# nfse-api

Serviço de emissão de **NFS-e** pelo Padrão Nacional (ADN / Sefin Nacional) do Gestão 2027 — porta
**3002**, contrato `/v1`. Consumido diretamente pelo setes-app (e qualquer front-end do produto) com o
JWT do setes-api; lê os fatos da nota no banco do produto e controla o ciclo com o fisco (envio,
autorização, consulta, cancelamento). Núcleo comum: `D:\Gestao2027\fiscal-api` (biblioteca).

**Estado (2026-10-04): F1 executada** — serviço funcional no dev (65 testes), dados da Setes migrados; a
virada da produção (setes-api deixa de emitir) é a F2a. Plano: `D:\Gestao2027\Infra-IA\prompts\prompt_apis_fiscais_isoladas.md`
§12 · índice: `D:\Gestao2027\Infra-IA\nfse-api\INDEX.md`.
