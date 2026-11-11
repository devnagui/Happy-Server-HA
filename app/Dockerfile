ARG BUILD_FROM=happy-server-upstream:ea925c2c51a5afce9fbed0816ec1e785b50f37d7
FROM ${BUILD_FROM}

LABEL io.hass.type="addon" io.hass.arch="aarch64" io.hass.version="0.1.0"
WORKDIR /repo/packages/happy-server
COPY run.mjs /opt/happy-ha/run.mjs
COPY UPSTREAM-LICENSE /opt/happy-ha/UPSTREAM-LICENSE

ENV NODE_ENV=production DB_PROVIDER=postgres PORT=3005 METRICS_ENABLED=false
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=6s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3005/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/happy-ha/run.mjs"]
CMD []
