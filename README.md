# Pi Web UI — Home Assistant Add-on Repository

Add-on Home Assistant che espone **pi-web-ui** (interfaccia web del coding
agent Pi) come istanza indipendente, accessibile via **ingress** di Home
Assistant.

## Installazione

1. In Home Assistant: **Impostazioni → Applicazioni → ⋮ → Archivi digitali**
   (oppure "Aggiungi repository")
2. Incolla l'URL di questo repository GitHub e conferma
3. Aggiorna: **⋮ → Controlla gli aggiornamenti**
4. Nel negozio compare **"Pi Web UI — istanza autonoma"** → **Installa**

## Contenuto

- `repository.json` — manifest del repository add-on
- `pi_web_ui_agent/` — l'add-on (config.yaml, Dockerfile, run.sh, proxy.mjs)

## Note tecniche

- Base image: `node:22-slim`
- Installa `pi-web-ui@0.76.0` (include `@earendil-works/pi-coding-agent`)
- Il server pi-web-ui gira su `:8888`, un piccolo proxy Node lo espone su
  `:3000` gestendo `X-Ingress-Path` (riscrittura path asset + tunnel WebSocket)
- Dati persistenti in `/data/pi-web-data` e `/data/pi-web-agent`
