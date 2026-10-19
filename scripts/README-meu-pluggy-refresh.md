# Meu Pluggy — refresh (local + Cloud Run)

No caminho MeuPluggy, o item **proxy** da API não aceita `PATCH`. Só o site [meu.pluggy.ai](https://meu.pluggy.ai) atualiza (auto 24h ou botão **Atualizar**).

Este fluxo usa Playwright para clicar **Atualizar**. Na Cloud Run isso roda como **Job**, disparado pelo botão **Atualizar Open Finance** em Configurações → Bancos.

## 1) Setup local (uma vez)

```bash
npm install
npm run pluggy:refresh:install   # Chromium em %LOCALAPPDATA%\ms-playwright (ignora cache do sandbox)
npm run pluggy:refresh:login
```

Complete o Google SSO. O script grava:

- perfil: `.cache/meu-pluggy-browser/`
- `storageState`: `.cache/meu-pluggy-storageState.json`

Envie o state ao GCS (troque o bucket):

```bash
gcloud storage cp .cache/meu-pluggy-storageState.json gs://SEU_BUCKET/meu-pluggy/storageState.json
```

Quando a sessão expirar, rode `pluggy:refresh:login` de novo e reenvie o arquivo.

## 2) Deploy do Job

Manual:

```powershell
$env:GCP_PROJECT_ID = "seu-projeto"
$env:MEU_PLUGGY_STORAGE_STATE_GCS = "gs://SEU_BUCKET/meu-pluggy/storageState.json"
# opcional: $env:MEU_PLUGGY_CONNECTION_IDS = "uuid1,uuid2"
.\scripts\deploy-meu-pluggy-refresh.ps1
```

Ou via **Cloud Build** no push (`cloudbuild.yaml` + `scripts/setup-cloudbuild-trigger.ps1`). O Job só é rebuildado se `Dockerfile.meu-pluggy-refresh` / `scripts/meu-pluggy-refresh.mjs` mudarem (marker `job-source.sha256` no GCS). Force: `_FORCE_JOB_REBUILD=true` no trigger. O `deploy-cloudrun.ps1` local também redeploya o Job se `MEU_PLUGGY_STORAGE_STATE_GCS` estiver no `.env`.

A SA do Job precisa de leitura no `storageState` e **escrita** no `progress.json` (ex. `roles/storage.objectAdmin` no prefixo `meu-pluggy/`). A SA do serviço Nest precisa ler o `progress.json`.

## 3) App (serviço Nest na Cloud Run)

No deploy do app, defina:

- `GCP_PROJECT_ID`
- `GCP_REGION` (ex. `southamerica-east1`)
- `MEU_PLUGGY_REFRESH_JOB` (default `meu-pluggy-refresh`)

A SA do **serviço** Nest precisa poder executar o Job (`roles/run.developer` no projeto ou IAM no Job).

Botão: **Configurações → Bancos → Atualizar Open Finance** → `POST /api/pluggy/meu-refresh`.

O script grava progresso em `.cache/meu-pluggy-progress.json` (e em `MEU_PLUGGY_PROGRESS_GCS` / ao lado do `storageState` no GCS). A UI faz poll em `GET /api/pluggy/meu-refresh/status` e mostra um toast com banco atual + %.

### Local pelo app (sem Cloud Run)

Sem `GCP_PROJECT_ID`, o `POST` sobe o script Playwright na máquina. Para forçar local mesmo com GCP:

```bash
MEU_PLUGGY_REFRESH_LOCAL=1
```

## 4) Teste manual do Job

```bash
gcloud run jobs execute meu-pluggy-refresh --project=SEU_PROJETO --region=southamerica-east1
gcloud run jobs executions list --job=meu-pluggy-refresh --project=SEU_PROJETO --region=southamerica-east1
```

## Local sem Cloud Run

```bash
npm run pluggy:refresh:login   # 1ª vez / sessão expirada
npm run pluggy:refresh         # só clicar Atualizar
```
