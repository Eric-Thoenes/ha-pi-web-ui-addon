# 👾 Pi UI — Home Assistant Add-on

Web UI del coding agent [Pi](https://pi.dev), accessibile via ingress in Home Assistant.

## Come funziona

Questo add-on avvia due processi all'interno del container:

1. **pi-web-ui** (porta `8888`) — server web con interfaccia chat per Pi
2. **Proxy ingress** (porta `3000`) — inoltra il traffico da HA ingress a pi-web-ui, gestendo prefisso percorso e WebSocket

Sessioni, skills e workspace persistono in `/data` (dentro il container).

## Installazione

1. Aggiungi questo repository a Home Assistant:
   **Impostazioni → Componenti aggiuntivi → ⋮ → Repository**
   URL: `https://github.com/Eric-Thoenes/ha-pi-web-ui-addon`

2. **Controlla aggiornamenti** (⋮ → Controlla aggiornamenti)

3. Clicca **"Pi UI"** → **Installa**

4. **Avvia** e apri dalla sidebar

## Persistenza

Tutti i dati (sessioni, workspace, skills) sono in `/data/pi-web-data` e `/data/pi-web-agent` dentro il container. I dati sopravvivono a riavvii e aggiornamenti dell'add-on.

## Configurazione

| Opzione | Default | Descrizione |
|---|---|---|
| `PI_ADDON_CWD` | `/data/workspace` | Directory di lavoro pi-web-ui |
| `PI_ADDON_DATA` | `/data/pi-web-data` | Dati persistenti sessioni |
| `PI_ADDON_AGENT` | `/data/pi-web-agent` | Skills e configurazioni |