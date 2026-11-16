# syntax=docker/dockerfile:1
# Production AgentBrowser v2.0 container: non-root Chromium, jailed artifact dirs, and healthcheck.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    AGENT_BROWSER_HEADLESS=true \
    AGENT_BROWSER_UPLOAD_DIR=/data/uploads \
    AGENT_BROWSER_DOWNLOAD_DIR=/data/downloads \
    AGENT_BROWSER_TRACE_DIR=/data/traces \
    AGENT_BROWSER_WORKFLOW_DIR=/data/workflows

WORKDIR /app

# Install production dependencies first for clean layer caching.
COPY agentbrowser/package.json agentbrowser/package-lock.json ./agentbrowser/
RUN npm --prefix agentbrowser ci --omit=dev && npm cache clean --force

# Copy runtime application code and create jailed artifact directories owned by non-root pwuser.
COPY package.json LICENSE README.md ./
COPY agentbrowser/ ./agentbrowser/
RUN mkdir -p /data/uploads /data/downloads /data/traces /data/workflows \
    && chown -R pwuser:pwuser /app /data

USER pwuser
VOLUME ["/data/uploads", "/data/downloads", "/data/traces", "/data/workflows"]
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const h=process.env.AGENT_BROWSER_TOKEN?{authorization:'Bearer '+process.env.AGENT_BROWSER_TOKEN}:{};fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{headers:h}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "agentbrowser/server.mjs"]
