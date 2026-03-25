FROM node:22-alpine

RUN apk add --no-cache git bash

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# Create non-root user and workspace
RUN adduser -D -u 1001 telepi \
  && mkdir -p /workspace /home/telepi/.pi/agent /home/telepi/.npm-global \
  && chown -R telepi:telepi /workspace /home/telepi

USER telepi

# Configure npm global prefix to a user-writable directory so that
# pi-coding-agent can install extensions (e.g. npm:pi-mcporter) without root.
ENV NPM_CONFIG_PREFIX=/home/telepi/.npm-global
ENV PATH="/home/telepi/.npm-global/bin:${PATH}"

CMD ["node", "dist/index.js"]
