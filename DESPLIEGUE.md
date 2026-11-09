# Despliegue del Mapa de calor Acuacar

Cómo quedó publicado el proyecto y qué pasos repetir para publicarlo de nuevo o
actualizarlo. Son dos piezas en dos sitios distintos:

| Pieza | Dónde vive | Cómo se actualiza |
| --- | --- | --- |
| Frontend (`web/`) | Vercel | Solo, con cada `git push` a `main` |
| Backend del asistente (`Backend/`) | Servidor `52.88.48.137` (Ubuntu, AWS) | A mano: subir archivos y reiniciar el servicio |
| Datos (`web/public/scr/*.json`) | En los dos | Vercel los toma del repo; al servidor se suben a mano |

Dirección pública del backend: `http://52.88.48.137/mapa-acuacar`

```
Navegador ──HTTPS──> Vercel (frontend)
                       │  /backend/...  (rewrite en web/next.config.mjs)
                       ▼
              http://52.88.48.137/mapa-acuacar/...
                       │  nginx (puerto 80)
                       ▼
              uvicorn 127.0.0.1:8020  (servicio mapa-acuacar)
```

> **Nunca** pegues en chats, capturas o en el repo el contenido del `.env`
> (`OPENAI_API_KEY`) ni contraseñas.

---

## 1. Backend en el servidor

Se entra por SSH como `ubuntu@52.88.48.137` (PuTTY) y los archivos se suben con
WinSCP. En el mismo servidor corren otros servicios (`mapa-calor` en el 8000,
`propension-pagos` en el 8001, `mvp-lecturas` en el 8010, `scr-ia`); **no usar
esos puertos**. El de Acuacar es el **8020**.

Para ver qué servicios de uvicorn están activos:

```bash
ps aux | grep uvicorn
```

### 1.1 Subir los archivos

Estructura que debe quedar en el servidor:

```
/home/ubuntu/Servicios/Mapa_Acuacar_Backend/
├── Backend/                 ← copia de la carpeta Backend/ del repo
│   ├── app/
│   ├── requirements.txt
│   ├── .env                 ← se crea en el servidor (paso 1.3)
│   └── .venv/               ← se crea en el servidor (paso 1.2)
└── web/public/scr/          ← los JSON de datos
    ├── data.json
    ├── data_AAAA-MM.json
    └── version.json
```

Con WinSCP:

1. Subir la carpeta local `Backend/` a `/home/ubuntu/Servicios/Mapa_Acuacar_Backend/Backend/`.
   **No subir** `.venv`, `__pycache__`, `.pytest_cache` ni el `.env` local.
2. Crear la carpeta de datos y subir **el contenido** de `web\public\scr\`:

   ```bash
   mkdir -p ~/Servicios/Mapa_Acuacar_Backend/web/public/scr
   ```

   Los archivos deben quedar directamente en `.../web/public/scr/data.json`, no
   dentro de otra subcarpeta `scr`.

De la carpeta `web/` **solo se suben los JSON**. Nada de `.next`, `node_modules`,
`src` ni `.env.local`: el frontend no corre en este servidor.

El backend busca los datos en `../web/public/scr/` respecto a `Backend/`. Si se
quieren en otra carpeta, se indica con `DATA_DIR` en el `.env`.

### 1.2 Entorno de Python

```bash
cd ~/Servicios/Mapa_Acuacar_Backend/Backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 1.3 Archivo `.env`

Crear `~/Servicios/Mapa_Acuacar_Backend/Backend/.env` (ver `Backend/.env.example`):

```
OPENAI_API_KEY=<la clave>
CORS_ORIGINS=*
```

Solo `OPENAI_API_KEY` es obligatoria. Opcionales: `OPENAI_MODEL`,
`OPENAI_TIMEOUT_SECONDS`, `OPENAI_MAX_RETRIES`, `DATA_DIR`.

### 1.4 Servicio de systemd

Archivo `/etc/systemd/system/mapa-acuacar.service`:

```ini
[Unit]
Description=Mapa de calor Acuacar - backend del asistente
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/Servicios/Mapa_Acuacar_Backend/Backend
ExecStart=/home/ubuntu/Servicios/Mapa_Acuacar_Backend/Backend/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8020 --root-path /mapa-acuacar --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Activarlo:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mapa-acuacar
```

Comprobar (tarda unos segundos en arrancar; si el primer intento falla, repetir):

```bash
curl http://127.0.0.1:8020/health
```

Debe responder `{"status":"ok"}`.

### 1.5 nginx

En `/etc/nginx/sites-enabled/scr-ia`, dentro del bloque `server` que escucha en
el puerto 80, junto al bloque de `/mvp-lecturas/`:

```nginx
location /mapa-acuacar/ {
    proxy_pass http://127.0.0.1:8020/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

Las dos barras finales (`/mapa-acuacar/` y `8020/`) son necesarias: quitan el
prefijo antes de pasar la petición al backend. `proxy_buffering off` es lo que
deja que el chat llegue por trozos.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 1.6 Verificar desde fuera

```bash
curl http://52.88.48.137/mapa-acuacar/health
```

- `{"status":"ok"}` → nginx y el servicio están bien.
- Documentación de la API: `http://52.88.48.137/mapa-acuacar/docs`
- Probar además una pregunta **con cifras** en el chat (por ejemplo "¿Qué meses
  hay disponibles?"). El saludo funciona aunque falten los datos; las cifras no.

---

## 2. Frontend en Vercel

Vercel compila `web/` desde GitHub (`luisnarv/Mapa_calor_acuacar`, rama `main`)
en cada push.

### 2.1 El puente `/backend`

Vercel sirve por HTTPS y el servidor solo habla HTTP, así que el navegador
bloquea la llamada directa (contenido mixto). Por eso `web/next.config.mjs`
tiene un rewrite: todo lo que el tablero pide a `/backend/...` Vercel lo reenvía
a `http://52.88.48.137/mapa-acuacar/...`.

### 2.2 Variables de entorno en Vercel

Proyecto → **Settings → Environment Variables**:

| Variable | Valor | Para qué |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `/backend` | Obligatoria. Hace que el tablero use el puente |
| `BACKEND_URL` | `http://52.88.48.137/mapa-acuacar` | Opcional. Solo si cambia la dirección del servidor |

`NEXT_PUBLIC_API_URL` queda fija al compilar: después de crearla o cambiarla hay
que **redesplegar** (Deployments → ⋯ → Redeploy).

### 2.3 Verificar

Abrir el mapa en Vercel y hacerle al chat una pregunta con cifras.

---

## 3. Actualizaciones

### Cambió el código del frontend
`git push` a `main`. Vercel despliega solo.

### Cambió el código del backend
1. Subir con WinSCP los archivos cambiados de `Backend/app/` al servidor.
2. Si cambió `requirements.txt`: `.venv/bin/pip install -r requirements.txt`.
3. Reiniciar:

   ```bash
   sudo systemctl restart mapa-acuacar
   ```

### Cambiaron los datos (se corrió el ETL)
Los JSON de `web/public/scr/` van a **los dos sitios**:

1. `git push` para que Vercel los publique en el mapa.
2. Subirlos con WinSCP a `/home/ubuntu/Servicios/Mapa_Acuacar_Backend/web/public/scr/`
   y reiniciar el servicio.

Si solo se hace uno de los dos, el mapa y el chat darán cifras distintas.

---

## 4. Problemas que ya nos pasaron

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `curl 127.0.0.1:8020/health` falla justo después de arrancar | El servicio aún está iniciando | Esperar unos segundos y repetir |
| Por la IP pública responde `{"detail":"Not Found"}` | El bloque de nginx no quita el prefijo | Revisar las barras finales del `location` y del `proxy_pass` (1.5) |
| El chat saluda pero las preguntas con cifras dan 502 "Error inesperado al consultar el modelo." | El backend no encuentra los JSON | Subirlos a `web/public/scr/` (1.1) y reiniciar |
| En Vercel el chat no conecta y la consola dice "Mixed Content" | Falta `NEXT_PUBLIC_API_URL=/backend` o no se redesplegó | Paso 2.2 |
| WinSCP: "No puedo abrir el archivo ...\.next\dev\lock" | Se está subiendo la carpeta `web` entera | Abortar y subir solo `web/public/scr/` |

Ver el registro del servicio (ocultando la clave):

```bash
sudo journalctl -u mapa-acuacar -n 40 --no-pager | grep -vi "api_key"
```

Estado del servicio:

```bash
sudo systemctl status mapa-acuacar
```

---

## 5. Pendientes conocidos

- El endpoint del chat no tiene autenticación ni límite de uso: cualquiera que
  conozca la dirección puede gastar la clave de OpenAI.
- El servidor no tiene dominio ni certificado HTTPS; por eso existe el puente de
  Vercel. Con un dominio y certbot se podría apuntar `NEXT_PUBLIC_API_URL`
  directo al servidor.
