# API (`api/`)

Backend NestJS do monorepo **organizze-pluggy**.

Documentação de setup, variáveis de ambiente e uso: **[README na raiz](../README.md)**.

```bash
# na raiz do repo
cp .env.example .env   # se ainda não existir
npm --prefix api install
npm run prisma:generate
npm run dev:api
```

API em `http://localhost:3000`.
