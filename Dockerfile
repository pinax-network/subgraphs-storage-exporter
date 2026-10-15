# Zero-dependency Bun app (Bun's built-in SQL for Postgres) — no install step needed.
# Bun >= 1.2 for the built-in SQL/postgres client (the 1.1 the sibling exporters pin lacks it).
FROM oven/bun:1.4.3-alpine

WORKDIR /app
COPY src ./src

ENV PORT=9402
EXPOSE 9402

# Drop to the image's unprivileged user.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||9402)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
