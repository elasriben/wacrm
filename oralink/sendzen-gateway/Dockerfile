FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
