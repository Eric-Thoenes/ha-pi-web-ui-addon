# Pi Web UI addon — build image
# Base: immagine node ufficiale (arm64/amd64). Installa pi-web-ui (include il pi-coding-agent).
ARG NODE_IMG=node:22-slim
FROM ${NODE_IMG}

RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# pi-web-ui 0.76.0 include @earendil-works/pi-coding-agent come dipendenza
RUN npm install -g pi-web-ui@0.76.0 \
    && npm cache clean --force

COPY proxy.mjs /proxy.mjs
COPY run.sh /run.sh
RUN chmod +x /run.sh && mkdir -p /data

EXPOSE 3000 8888
ENTRYPOINT ["/run.sh"]