FROM node:22-alpine

LABEL name="ambiant-scan" \
      description="Zero-dependency environmental scraper & modeler" \
      version="1.0.0"

WORKDIR /app

COPY server.js .
COPY package.json .

ENV PORT=3400 \
    CACHE_TTL_SECONDS=600 \
    GEO_CACHE_TTL_SECONDS=86400 \
    MAX_CACHE_ENTRIES=5000

EXPOSE 3400

USER node

CMD ["node", "server.js"]
