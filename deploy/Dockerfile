# A fez relay in one command — for operators who'd rather run a
# container than provision a box:
#
#   docker build -f deploy/Dockerfile -t fez-relay .
#   docker run -d --name fez-relay -p 7777:7777 -v fez-data:/var/lib/fez fez-relay
#
# The volume is not optional. Without it the SQLite store lives in the
# container's writable layer and every community on this relay
# disappears the next time you `docker run`.
FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN npx --yes esbuild packages/fez-relay/src/cli.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=/fez-relay.mjs \
      --banner:js='import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'

FROM node:22-alpine
RUN addgroup -S fez && adduser -S -G fez fez && mkdir -p /var/lib/fez && chown fez:fez /var/lib/fez
COPY --from=build /fez-relay.mjs /opt/fez/fez-relay.mjs
USER fez
VOLUME /var/lib/fez
EXPOSE 7777
# Mirrors deploy/fez-relay.service — an empty kind-whitelist argument
# would whitelist only kind 0 and reject every fez event.
ENV FEZ_KINDS=0,5,7,1059,1984,20001,20002,20003,20004,20005,22242,24134,30047,30078,30174,30315,39005,40003,40004,40005,40006,40007,40100,40101,40102,40200,40201,40300,47000,47001,47002,47003,47004,47005,47006,47010,47011,47012,47020,47030,47100,47101,47102,47103,47200
ENTRYPOINT ["sh","-c","exec node /opt/fez/fez-relay.mjs --port 7777 --store /var/lib/fez/relay.sqlite --policy rate-limit=600 --policy kind-whitelist=$FEZ_KINDS"]
