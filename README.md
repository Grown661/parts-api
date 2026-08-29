# parts-api

REST-API für einen FPV-Teile-Katalog — komplett dependency-frei mit Node.js-Builtins gebaut.
Kein Express, kein npm install: der komplette HTTP-Stack (Routing, Validierung, Rate-Limiting,
CORS, Pagination, OpenAPI-Doku) ist von Hand implementiert.

## Problem

Wer FPV-Drohnen baut, verliert schnell den Überblick über Teile, Preise und Gewichte.
Diese API ist das Backend für einen Teile-Katalog: Motoren, Flight Controller, Kameras,
Akkus — durchsuchbar, filterbar, mit Lagerbestand.

Gleichzeitig ist das Projekt eine Referenz dafür, wie eine saubere REST-API **ohne
Framework** aussieht: Man sieht jeden Baustein (Routing, Body-Parsing, Fehlerbehandlung),
den ein Framework sonst versteckt.

## Features

- **Volles CRUD** auf `parts` (Create, Read, Update, Delete)
- **Filter & Suche**: `?category=motor`, `?q=xing`
- **Pagination**: `?page=2&limit=10` → `{ data, page, total, totalPages }`
- **Input-Validierung** mit klaren 400-Fehlermeldungen pro Feld
- **Rate-Limiting**: 60 Requests/Minute/IP (In-Memory), danach `429 Too Many Requests`
- **CORS** aktiviert (nutzbar aus jedem Frontend)
- **OpenAPI-3-Spec** unter `/openapi.json` — handgeschrieben, importierbar in Postman/Insomnia
- **HTML-Doku-Seite** unter `/`, generiert aus der OpenAPI-Spec
- **Seed-Daten**: 8 echte FPV-Teile beim ersten Start
- **JSON-Persistenz** unter `data/parts.json` mit serialisierter Schreib-Queue

## Stack

- Node.js (>= 18), **nur Builtins**: `node:http`, `node:crypto`, `node:fs/promises`, `node:url`
- Persistenz: JSON-Datei (bewusst simpel — der Austausch gegen SQLite/Postgres wäre ein
  einzelnes Modul)

## Setup & Start

```bash
node server.js
# parts-api laeuft auf http://localhost:8215 (8 Teile im Store)
```

Optional per Umgebungsvariablen:

```bash
PORT=8300 RATE_LIMIT=120 node server.js
```

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/` | HTML-Doku-Seite (aus der OpenAPI-Spec generiert) |
| GET | `/openapi.json` | OpenAPI-3-Spec |
| GET | `/api/parts` | Liste mit `?category=`, `?q=`, `?page=`, `?limit=` |
| GET | `/api/parts/:id` | Einzelnes Teil |
| POST | `/api/parts` | Teil anlegen (JSON-Body) |
| PUT | `/api/parts/:id` | Teil aktualisieren (voll oder teilweise) |
| DELETE | `/api/parts/:id` | Teil löschen (204) |

### Beispiele

```bash
# Alle Motoren, Seite 1
curl "http://localhost:8215/api/parts?category=motor&page=1&limit=5"

# Teil anlegen
curl -X POST http://localhost:8215/api/parts \
  -H "Content-Type: application/json" \
  -d '{"name":"EMAX RS2205 2300KV","category":"motor","price":15.9,"weight_g":30,"in_stock":true}'

# Validierungsfehler ansehen
curl -X POST http://localhost:8215/api/parts \
  -H "Content-Type: application/json" -d '{"name":"x"}'
# -> 400 mit Fehlerliste pro Feld
```

### Datenmodell

```json
{
  "id": "a1b2c3d4e5f6",
  "name": "iFlight XING2 2207 1855KV",
  "category": "motor",
  "price": 21.9,
  "weight_g": 34.5,
  "in_stock": true
}
```

Kategorien: `motor`, `fc`, `esc`, `camera`, `vtx`, `rx`, `prop`, `battery`, `frame`, `antenna`, `other`

## Screenshot

_(Screenshot folgt)_

## Lizenz

MIT
