FROM node:22-alpine
WORKDIR /app
# No runtime dependencies, so there's nothing to npm install.
COPY package.json ./
COPY src ./src
ENV PORT=7000
EXPOSE 7000
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO /dev/null http://127.0.0.1:7000/manifest.json || exit 1
CMD ["node", "src/server.js"]
