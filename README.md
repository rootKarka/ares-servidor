# ARES Server

API REST + WebSocket para ARES. Conecta la web de campo, el robot (ESP32) y la base de datos.
Sigue el **Contrato de comunicación v1** (+ ajustes v1.1, ver abajo).

**Stack:** Node 20+ · Fastify 5 · PostgreSQL 16 (Docker) · Drizzle ORM · TypeScript.

## Requisitos

- Node.js 20 o superior (`node -v`)
- Docker Desktop abierto (en Windows, con el motor WSL 2)

## Puesta en marcha (Windows / PowerShell)

```powershell
cd ares-server
npm install

# 1) Configuración
copy .env.example .env
#    Abre .env y completa: JWT_SECRET, las contraseñas SEED_*_PASSWORD,
#    SEED_ROBOT_TOKEN y SIM_ROBOT_TOKEN (el mismo valor en los dos).
#    Para generar JWT_SECRET (48 bytes) o un token de robot (24 bytes):
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 2) Base de datos
docker compose up -d        # levanta PostgreSQL (o: npm run db:up)
npm run db:migrate          # crea las tablas
npm run db:seed             # crea usuarios, robots y sensores

# 3) Servidor
npm run dev                 # http://localhost:4000
```

En otra terminal, el robot simulado (hace de ESP32 datos + ESP32-CAM):

```powershell
npm run sim
```

Y para el frontend, en `.env.local` de la web:

```
VITE_API_URL=http://localhost:4000
```

**Para entrar a la web:** el correo y la contraseña que pusiste en `SEED_OPERATOR_EMAIL` y
`SEED_OPERATOR_PASSWORD` (por defecto `operador@ares.local`).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm start` | Servidor sin recarga (producción) |
| `npm run db:up` / `db:down` | Levanta / apaga PostgreSQL en Docker |
| `npm run db:generate` | Genera una migración SQL tras cambiar `src/db/schema.ts` |
| `npm run db:migrate` | Aplica las migraciones (el servidor también lo hace al arrancar) |
| `npm run db:seed` | Crea o actualiza usuarios, robots y sensores (se puede repetir) |
| `npm run sim` | Robot simulado (telemetría, status, audio y video de prueba) |
| `npm run smoke` | Prueba de punta a punta (30 comprobaciones). Con el servidor corriendo y **sin** `npm run sim` activo |
| `npm test` | Pruebas unitarias (niveles y contraseñas) |
| `npm run typecheck` | Revisa los tipos de TypeScript |

## Estructura

```
src/
  server.ts            punto de entrada
  app.ts               arma Fastify: CORS, JWT, límite de intentos, rutas y WebSockets
  env.ts               lee el .env
  contract.ts          tipos del contrato (idéntico al del frontend: src/lib/contract.ts)
  hub.ts               quién está conectado, suscripciones, video/audio bajo demanda, turno de voz
  telemetry.ts         valida telemetría/status, niveles, alertas, histórico
  levels.ts            normal / advertencia / crítico, con histéresis del 5 %
  security.ts          contraseñas (scrypt) y tokens (SHA-256)
  routes/auth.ts       login, refresh (con rotación), logout, me
  routes/robots.ts     robots, sensores y umbrales, histórico de lecturas
  ws/webSocket.ts      /ws/web   (las webs)
  ws/robotSocket.ts    /ws/robot (las ESP32)
  db/                  esquema, migraciones, seed
  simulator/           robot simulado
  dev/smoke.ts         prueba de punta a punta
drizzle/               migraciones SQL generadas
```

## Cómo funciona (resumen)

- **Login:** `POST /api/auth/login` entrega un `accessToken` (JWT, 15 min) y un `refreshToken`
  (30 días, un solo uso: cada renovación entrega uno nuevo). Máximo 10 intentos de login por minuto por IP.
- **Web:** se conecta a `/ws/web`, manda `auth` con el JWT, luego `subscribe` al robot y a los streams
  que quiere (`telemetry`, `status`, `video`, `audio`).
- **Robot:** cada placa se conecta a `/ws/robot` y manda `hello` con `robotId`, `device` (`data` o `cam`)
  y su token. Si la misma placa se reconecta, la conexión nueva reemplaza a la vieja (la vieja se cierra con 4409).
- **Video y micrófono bajo demanda:** el servidor le manda `video.start` / `audio.listen.start` al robot solo
  cuando alguna web los pide, y `stop` cuando ya nadie los necesita (no se gasta 4G en vano).
- **Niveles y alertas:** el robot solo manda valores; el servidor calcula el nivel con los umbrales de la base,
  emite `alert` al cambiar de nivel y guarda una lectura por sensor cada 5 s.
- **Hablar al robot (PTT):** un operador a la vez, máximo 60 s por turno; `observador` no puede hablar.
- **Latido:** el servidor hace ping cada 15 s y corta los sockets que no responden.

## Ajustes v1.1 al contrato

Respecto al documento original (todos aditivos):

- `ping` (web → servidor) y `pong` (servidor → web) con el mismo `t`, para medir la latencia.
- `GET /api/robots` → `{ "robots": [RobotSummary] }`; `GET /api/robots/:id` → `RobotSummary`.
- `GET /api/robots/:id/sensors` → `{ "sensors": [SensorConfig] }` (un elemento por sensor físico;
  en el DHT11 el umbral aplica a la temperatura).
- `PUT /api/robots/:id/sensors/:sensor/thresholds` con `{ warn, crit, direction }` → `SensorConfig`.
  Rechaza umbrales incoherentes con `400 invalid_thresholds`.
- `POST /api/auth/refresh` rota el token: devuelve `{ accessToken, refreshToken }` nuevos.
  `POST /api/auth/logout` con `{ refreshToken }` lo revoca. `GET /api/auth/me` devuelve el usuario.
- Código de cierre `4409`: se envía al socket **viejo** cuando la misma placa se reconecta.
- Código de error `ptt_timeout` cuando se acaba el turno de 60 s.
- Los cierres de alerta (`state: "cleared"`) llevan `level: "normal"` y el mismo `id` que la alerta abierta.

## Conectar la ESP32 en desarrollo local

Usa la IP de tu PC en la red WiFi (`ipconfig`), por ejemplo `ws://192.168.1.50:4000/ws/robot`
(sin TLS en local, así que `ws.begin(...)` y no `beginSSL`). Windows pedirá permiso en el firewall para Node:
acepta para redes **privadas**. En producción se usa `wss://` con el dominio del hosting.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `Falta JWT_SECRET en el archivo .env` | No copiaste `.env.example` a `.env` o falta completar un valor |
| `ECONNREFUSED 5432` | Docker Desktop no está abierto o el contenedor no arrancó: `docker compose up -d` |
| El puerto 5432 ya está en uso | Cambia en `docker-compose.yml` a `"5433:5432"` y en `DATABASE_URL` a `...@localhost:5433/ares` |
| La web dice "No se pudo conectar con el servidor" | El servidor no está corriendo, o `VITE_API_URL` no apunta a `http://localhost:4000` (reinicia la web tras cambiar `.env.local`) |
| Error de CORS en el navegador | Agrega el origen de tu web (por ejemplo `http://localhost:8080`) a `CORS_ORIGINS` y reinicia el servidor |
| El simulador imprime `token rechazado (4401)` | `SIM_ROBOT_TOKEN` no coincide con `SEED_ROBOT_TOKEN`: pon el mismo y corre `npm run db:seed` |
| Quiero empezar de cero | `docker compose down -v` borra los datos; luego `db:migrate` y `db:seed` |

## Pendiente (siguientes pasos)

Evidencias (subida de capturas), reportes, mensajes entre operadores, CRUD de usuarios y robots para la web de
administración, y desplegar con HTTPS (`wss://`).
