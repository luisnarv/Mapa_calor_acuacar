# Mapa SCR — Acuacar (Cartagena)

Tablero de efectividad y pérdidas de las órdenes de suspensión y reconexión de Acuacar.
Es el tablero SCR de Air-E (`Aire_Cobros_SCR`) adaptado a la tabla
`dbanalitica.historico_acuacar_scr`. Con chatbot (`Backend/`); sin cobros.

```
Acuacar/
├── etl/            Python · PostgreSQL -> web/public/scr/*.json
│   ├── run_etl.py
│   └── etl/        config (consulta), transform (estado/causa), taxonomy (controlables),
│                   geo (GPS -> barrio), payload (JSON del tablero)
├── scripts/
│   ├── preparar_geografia.py  zonas, corregimientos, veredas, barrios y límite -> web/public/geojson/
│   └── validar.py             cruza el JSON contra la base con SQL independiente
├── config/tarifas.json        código de tarifa -> descripción (Excel «TARIFA Y ZONAS»)
├── cartagena/                 geojson fuente de barrios (solo referencia visual)
├── Backend/                   FastAPI · chatbot con OpenAI y tool calling (ver Backend/README.md)
├── web/                       Next.js · el tablero (copia del de Air-E) y el chat
└── obsoleto/                  lo que quedó del visor de ElectroHuila
```

## Puesta en marcha

```bash
cp .env.example .env                    # y completa DATABASE_URL
pip install -r etl/requirements.txt
python scripts/preparar_geografia.py    # solo cuando cambien las zonas o los barrios
python etl/run_etl.py                   # escribe web/public/scr/
python scripts/validar.py               # debe decir OK en las 4 líneas
npm install --prefix web && npm run dev --prefix web

# chatbot (otra terminal): necesita OPENAI_API_KEY en Backend/.env
pip install -r Backend/requirements.txt && python -m uvicorn app.main:app --app-dir Backend --reload
```

## Cómo se homologó Acuacar con Air-E

| Tablero (Air-E) | Acuacar (`historico_acuacar_scr`) |
|---|---|
| Estado Efectiva | `efectividad = 'Efectiva'` |
| Estado Perdida | `efectividad = 'No efectiva'` (no existe «Fallida») |
| Fuera del cálculo | `Anulada` y `Pendiente` |
| Causa | `causal_no_efectiva` |
| Subacción | `tipo_imposibilidad` |
| Técnico | `brigada_movilidad` |
| Brigada | `contratista_desc` (siempre ISES) |
| Tipo OS / Actividad | `proceso` |
| Zona | polígono curado según el GPS; fuera de todo polígono, la columna `zona` |
| Barrio | por GPS contra `web/public/geojson/barrios.geojson`; si el GPS no cae en un polígono, el de la dirección (texto entre paréntesis) |
| Fecha | `fecha_finalizacion`, o `fecha_imposibilidad`, o `fecha_apertura` |

**Causas no controlables** (no penalizan a la brigada en la efectividad ajustada):
Oposición del usuario y Estado del servicio. Está en `etl/etl/taxonomy.py`.

**Zonas, corregimientos y veredas:** vienen de `GEO_FIELDOPS/datos/curados/`
(`cartagena_zonas_acuacar`, `cartagena_corregimientos_visor`, `cartagena_veredas_visor`).
**La zona de cada orden la fija el polígono curado según su GPS**, aunque difiera de la
columna `zona` de la base (coinciden en el 61 %). El 18,5 % de las órdenes (4.978) cae fuera
de todo polígono: esas toman la zona de la base, porque los polígonos curados no cubren toda
la ciudad. La zona de la base va siempre en `ZONA_BASE` dentro del ETL. Los códigos
`C011`…`C022` se normalizan a `C11`…`C22`.

**Caché del navegador:** el tablero guarda los datos 1 hora en IndexedDB. El ETL escribe
`web/public/scr/version.json` con la hora de generación y la caché se descarta sola cuando
cambia; el botón «Actualizar información» sigue limpiándola a mano.

**Polígonos de barrio:** si el polígono oficial cubre menos de la mitad de las órdenes que la
dirección dice que son de ese barrio (o no existe), `preparar_geografia.py` lo reemplaza por
uno dibujado con el GPS de esas órdenes (37 barrios, entre ellos Villa Estrella, San José de
los Campanos, Manzanillo del Mar y La Carolina). Los alias de escritura, como
«VEREDA ZAPATERO» a «ZAPATERO», están en `config/alias_barrios.json`.

**Barrio = barrio + zona.** Un barrio atraviesa varias zonas y el tablero asigna una zona
por unidad; por eso el nombre lleva la zona, por ejemplo `ALAMEDA LA VICTORIA (C17)`.

## Pendiente de homologar

- Tarifas 81 y 82 (24 órdenes) no están en la hoja TARIFAS del Excel oficial.
- «Suspensión solicitada» no existe en Acuacar; el campo queda en `SIN DATO` y está oculto.
- Pesos del índice de riesgo: son los de Air-E sin el peso de «Fallidas», repartido
  proporcionalmente (`Tablero.js`). No están validados con Acuacar.
- El 18 % de las órdenes cae fuera de los polígonos de barrio y queda en `SIN BARRIO`.
- Código heredado de Air-E que ya no se usa (cobros, gestores, cargue de órdenes) sigue
  en `web/src/components/`.
