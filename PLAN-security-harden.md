# Endurecer sessão (revogável)

## Contexto / pesquisa

Após Google SSO (Opção B), a sessão era um cookie HMAC (`email` + `exp`) sem registro no servidor. Logout só limpava o browser: um cookie copiado seguia válido até 7 dias. Não havia rate limit em `POST /api/auth/google` nem checagem de Origin em mutações.

Objetivo: sessão **opaca + Neon**, idle curto com sliding, uma sessão ativa por e-mail, logout/novo login revogam de verdade.

## Desenho

1. Cookie `op_session` = token aleatório (32 bytes hex). Banco guarda só `sha256(token)`.
2. Idle **12h** sem uso → sessão inválida (row apagada).
3. Absolute **7d** desde o login → inválida (não desliza).
4. Sliding: se `lastSeenAt` > 5 min, atualiza e renova `maxAge` do cookie (= idle restante).
5. Novo login Google → apaga todas as sessões do e-mail antes de criar a nova.
6. Logout → apaga a row da sessão atual + `clearCookie`.
7. Throttle: `POST /auth/google` 10/min/IP; global folgado 120/min; health sem throttle.
8. Mutações (`POST|PUT|PATCH|DELETE`) sob `/api`: Origin/Referer deve bater com Host (ou `localhost:5173` em dev); sem ambos → 403.

## Critérios de aceite

- [ ] Logout → mesmo cookie no curl → 401
- [ ] Novo login → cookie antigo → 401
- [ ] Idle > 12h (lastSeenAt antigo no DB) → 401
- [ ] Rajada em `/auth/google` → 429
- [ ] Mutação cross-origin sem Origin válido → 403
- [ ] Typecheck API + web OK
- [ ] Migration Prisma aplicada

## Fora de escopo

GCP Secret Manager, IAP, MFA, double-submit CSRF.
