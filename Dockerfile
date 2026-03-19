FROM node:22-alpine

RUN apk add --no-cache git bash curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# Create non-root user and workspace
RUN adduser -D -u 1001 telepi \
  && mkdir -p /workspace /home/telepi/.pi/agent \
  && chown -R telepi:telepi /workspace /home/telepi

USER telepi

CMD ["node", "dist/index.js"]
