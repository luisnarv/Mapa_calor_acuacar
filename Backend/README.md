# Backend — chatbot del tablero SCR de Acuacar

API FastAPI con un asistente (OpenAI + tool calling) que responde sobre las órdenes de
suspensión y reconexión de Acuacar y puede filtrar el mapa. Es el chatbot del tablero de
Air-E (`Aire_Cobros_SCR`) adaptado a Acuacar: solo SCR, sin cargue de archivos, sin cobros.

```
web (ChatBot.js) ──POST /api/v1/openai/chat/stream──► FastAPI
                                                        │  ciclo de tool calling (máx. 4 rondas)
                                                        ▼
                                         ToolRunner ─► MetricsService ─► payload_store
                                                                              │
                                                       web/public/scr/*.json ◄┘  (los mismos que lee el mapa)
```

El modelo **no calcula ni escribe SQL**: llama herramientas y estas agregan sobre
`web/public/scr/data*.json`, la misma fuente del tablero. El chat y el mapa no pueden
discrepar porque hay una sola copia. El backend recarga los archivos solo cuando el ETL
los regenera.

## Puesta en marcha

```bash
cd Backend
pip install -r requirements.txt
cp .env.example .env          # y completa OPENAI_API_KEY
python -m uvicorn app.main:app --reload --reload-dir app
python -m pytest -q
```

El tablero llama a `http://127.0.0.1:8000` (cámbialo con `ACUACAR_API_URL`). Docs en
`/docs`, salud en `/health`.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/v1/openai/chat` | Respuesta completa, con los filtros del mapa en `acciones` |
| POST | `/api/v1/openai/chat/stream` | Por trozos (SSE): `{"delta"}`, `{"accion"}`, `{"error"}`; cierra con `data: [DONE]` |

## Herramientas del asistente (`app/services/tools.py`)

`efectividad`, `ranking`, `causas_no_efectivas`, `buscar_barrio`, `meses_disponibles`,
`filtrar_mapa`, `ordenes_de_tecnico`, `comparar_periodos`, `serie_mensual`.

## Reglas de Acuacar que el chat respeta

- **Solo hay dos estados:** Efectiva y Perdida (`efectividad = 'No efectiva'`). No existe «Fallida».
- **Dos efectividades:** `ef_pct` (cruda) y `ef_adj` (ajustada, descuenta las causas no
  controlables: Oposición del usuario y Estado del servicio). Se citan siempre las dos.
- **Zona = polígono del GPS**, no la columna `zona` de la base. `SIN ZONA` no es una zona operativa.
- **Barrio = barrio + zona** (`ALBORNOZ (C15)`): pasar solo el nombre suma todas sus zonas.
- **«Estrato 3»** suma sus códigos de tarifa (31, 32, 36).
- **Un filtro de catálogo que no resuelve** (zona `C99`) devuelve `filtro_no_reconocido`,
  nunca el total sin filtrar.
- **Los datos no son en vivo:** cada resultado trae `datos_hasta`, y un mes incompleto se avisa.

## Qué no está (todavía)

- **Feedback y trazas** (pulgares, `chat_interaccion`): `conversacion_id` ya viaja en cada
  petición para agregarlo después.
- **Búsqueda en las actas** (`OBSERVACION`): el ETL no la vuelca al payload.
- **Recomendador de técnicos y cargue de órdenes por ejecutar.**
- El endpoint no tiene autenticación ni límite de peticiones, y `ChatRequest.model` es libre:
  quien llame elige con qué modelo se le responde.
- El prompt vive en `app/prompts/sistema.md` y todo lo que tenga llega tal cual al modelo.

## Pruebas

`tests/conftest.py` arma un payload sintético con conteos conocidos a mano. Las pruebas
**nunca** leen `web/public/scr/`: el ETL lo regenera y las cifras cambiarían solas. OpenAI
se reemplaza por un cliente falso (`tests/test_chat.py`).
