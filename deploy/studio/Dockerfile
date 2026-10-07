# No npm dependencies, private configuration, database or build outputs copied.
FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
RUN apk add --no-cache ffmpeg=8.0.1-r1 ca-certificates
WORKDIR /app
COPY --chown=node:node studio/ ./studio/
COPY --chown=node:node backend/internal/videoplan/contract.json ./backend/internal/videoplan/contract.json
COPY --chown=node:node deploy/studio/check-runtime.mjs deploy/studio/entrypoint.sh ./deploy/studio/
USER 1000:1000
ENV NODE_ENV=production STUDIO_IMAGE_BFF_PORT=4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.STUDIO_IMAGE_BFF_PORT+'/health').then(async r=>{if(!r.ok||(await r.json()).service!=='studio-bff')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "/app/deploy/studio/entrypoint.sh"]
