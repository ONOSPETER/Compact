# Build context: the project root (the folder that contains critical/ and compact/)
FROM node:22-slim
WORKDIR /app
COPY critical/package.json ./critical/
RUN cd critical && npm install --omit=dev
COPY compact/runtime/package.json ./compact/runtime/
RUN cd compact/runtime && npm install --omit=dev
COPY critical ./critical
COPY compact ./compact
ENV COMPACT_DIR=/app/compact COMPACT_CRITICAL_DIR=/app/critical PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["node", "compact/runtime/runner.mjs"]
