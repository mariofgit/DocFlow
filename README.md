# DocFlow — servicio Docling (NEU-577)

Repositorio **DocFlow**: conversión de documentos con [Docling](https://github.com/docling-project/docling): API **síncrona** (`POST /api/v1/convert`), autenticación `X-API-Key`, límites 10 MB / 120 s, y la **misma imagen Docker** para desarrollo local (Docker Compose) y **AWS ECS Fargate** (CDK).

| Ruta | Descripción |
|------|-------------|
| [`service/`](service/) | FastAPI, `Dockerfile` multi-stage, `entrypoint.sh` (Gunicorn + Uvicorn workers) |
| [`service/ui/`](service/ui/) | Interfaz web mínima (mismo origen que la API; la conversión sigue usando `X-API-Key`) |
| [`docker-compose.yml`](docker-compose.yml) | Orquestación local |
| [`.env.example`](.env.example) | Plantilla de secretos locales (equivale a Secrets Manager en AWS) |
| [`cdk/`](cdk/) | Infra TypeScript: VPC, Fargate, ALB HTTPS, ACM, Route 53, CloudWatch, API key en Secrets Manager |
| [`cdk/deployment.json`](cdk/deployment.json) | CPU, memoria, DNS y `gunicornWorkers` por entorno |

---

## Local demo

### Prerrequisitos

- Docker y Docker Compose v2
- Un PDF de prueba (&lt; 10 MB), por ejemplo `samples/local-demo.pdf`

### 1. Configurar secretos locales

En la raíz de este repositorio (`DocFlow/`):

```bash
cp .env.example .env
```

Edita `.env` y define `DOCLING_API_KEY` con un valor de prueba. **Mismo nombre de variable** que inyecta AWS en el contenedor desde Secrets Manager (`DOCLING_API_KEY`).

### 2. Construir y levantar

```bash
cd DocFlow
docker compose build
docker compose up
```

El servicio queda en **http://127.0.0.1:8080** (mapeo `8080:8080`).

**Interfaz web (PoC):** abre **http://127.0.0.1:8080/** (redirige a `/ui/`). Con **Docker Compose**, la clave del `.env` se **precarga** en el formulario (`DOCFLOW_UI_PREFILL_API_KEY`; el navegador no puede leer `.env` por sí solo). Elige archivo y **Convertir documento**. En **ECS** no actives esa variable: la clave iría en el HTML visible.

### 3. Comprobar salud

```bash
curl -sS http://127.0.0.1:8080/health
```

### 4. Conversión PDF → Markdown

Opción A — script (recomendado):

```bash
chmod +x scripts/demo-convert.sh
export DOCLING_API_KEY='el-mismo-de-tu-.env'
./scripts/demo-convert.sh samples/local-demo.pdf
```

Opción B — `curl` directo:

```bash
curl -sS -X POST "http://127.0.0.1:8080/api/v1/convert" \
  -H "X-API-Key: ${DOCLING_API_KEY}" \
  -F "file=@samples/local-demo.pdf" \
  -F "output_format=markdown" \
  -F "ocr_enabled=true"
```

Opción C — cliente HTTP: [`scripts/demo-convert.http`](scripts/demo-convert.http).

### Desarrollo sin Compose (opcional)

```bash
cd service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DOCLING_API_KEY=dev-local
uvicorn main:app --reload --host 0.0.0.0 --port 8080
```

En producción (imagen Docker / ECS) el proceso se lanza con **Gunicorn** y workers **Uvicorn** vía [`service/entrypoint.sh`](service/entrypoint.sh).

---

## AWS deployment

La pila CDK construye la imagen desde **`service/`** con el **mismo `Dockerfile`** que usa Docker Compose (`ecs.ContainerImage.fromAsset(serviceDir)`). Variables alineadas:

| Variable | Local (`.env` / compose) | ECS (task) |
|----------|---------------------------|------------|
| `DOCLING_API_KEY` | Definida en `.env` | Inyectada desde Secrets Manager (`password`) |
| `PORT` | `8080` | `8080` |
| `GUNICORN_WORKERS` | Opcional en `.env` | Opcional desde `deployment.json` → `gunicornWorkers` |
| `GUNICORN_TIMEOUT` | Por defecto `130` en imagen | Igual si no se sobrescribe |

### Prerrequisitos

- Node 18+, AWS CLI configurada, permisos para ECS, ECR, VPC, ALB, ACM, Route 53, Secrets Manager
- Hosted zone y valores en [`cdk/deployment.json`](cdk/deployment.json) válidos para tu cuenta

### Desplegar (staging)

```bash
cd DocFlow/cdk
npm install
npm run build
npx cdk deploy -c env=staging
```

Ajusta el contexto `env` (`staging` o `production`) según las claves en `deployment.json`.

### Tras el deploy

1. **URL:** ver output del stack (`ServiceUrl`), p. ej. `https://<tenantSubdomainPrefix>.<apexDomain>`.
2. **API key:** el stack crea el secreto `docling-service/<env>/api-key` (JSON con campo `password`). Ese valor es el que debes enviar en `X-API-Key` (y es el que el task expone como `DOCLING_API_KEY`).

```bash
aws secretsmanager get-secret-value \
  --secret-id docling-service/staging/api-key \
  --query SecretString --output text
```

3. **Probar conversión** contra la URL pública con el mismo `curl` que en local, cambiando host y clave.

### Imagen multi-arquitectura

En Apple Silicon, para coincidir con Fargate **linux/amd64**:

```bash
docker build --platform linux/amd64 -t docling-service:local ./service
```

`cdk deploy` usa el asset de Docker según tu entorno; si synth/build fallan por arquitectura, configura buildx según la guía de CDK.

---

## Despliegue en Railway (sin AWS)

La app ya usa la variable **`PORT`** que Railway inyecta. En la **raíz del repo** están [`railway.toml`](railway.toml) y [`Dockerfile.railway`](Dockerfile.railway): el contexto de build es la raíz del repo y las rutas usan el prefijo **`service/`** (así no dependes de “Root Directory” en el panel).

### Cambios en el código (este repo)

- **`railway.toml`** + **`Dockerfile.railway`**: build estable en Railway con contexto = raíz del monorepo.
- **Docker Compose / CDK** siguen usando **`service/Dockerfile`** sin cambios.
- **No** hace falta tocar FastAPI; opcionalmente variables como en local (`GUNICORN_WORKERS`, timeouts).

### Qué hacer tú en Railway

1. Crea un proyecto y **conecta el repo** de DocFlow (GitHub).
2. Deja **Root Directory vacío** (raíz del repo), o **`/`**. Railway debe leer [`railway.toml`](railway.toml) en la raíz y construir con **`Dockerfile.railway`**. Si el panel sobrescribe el Dockerfile, pon **`Dockerfile.railway`** explícitamente.
3. **Variables** (mínimo):
   - **`DOCLING_API_KEY`**: genera un secreto largo y guárdalo (mismo uso que en local).
   - **No** definas `DOCFLOW_UI_PREFILL_API_KEY` en público (evitaría inyectar la clave en el HTML).
4. **Recursos:** Docling es pesado; usa un plan con **suficiente RAM** (orden de **varios GB**). Si hay OOM, sube memoria o deja `GUNICORN_WORKERS=1`.
5. Opcional en variables:
   - `GUNICORN_WORKERS=1`
   - `SYNC_TIMEOUT_SECONDS=300`
   - `GUNICORN_TIMEOUT=320`
6. Tras el deploy, abre la **URL pública** que asigne Railway y prueba:
   - `GET https://<tu-servicio>.up.railway.app/health`
   - `POST /api/v1/convert` con `X-API-Key` y `multipart` igual que en local.

**Build:** la primera imagen puede tardar mucho (pip + modelos). Si el build corta por tiempo, revisa límites del plan o contacta soporte de Railway.

---

## Despliegue en Fly.io

Usa el mismo [`Dockerfile.railway`](Dockerfile.railway) (contexto = raíz del repo). Config: [`fly.toml`](fly.toml).

### Prerrequisitos

- Cuenta en [Fly.io](https://fly.io) y CLI: `brew install flyctl` (o [instalación oficial](https://fly.io/docs/hands-on/install-flyctl/)).
- **RAM:** el `fly.toml` pide **4 GB**; en planes gratuitos puede no bastar — revisa [precios / límites](https://fly.io/docs/about/pricing/).

### Pasos

1. **Login:** `fly auth login`
2. **Nombre de app** (único global), por ejemplo:
   ```bash
   fly apps create docflow-tuusuario
   ```
3. Edita **`fly.toml`**: cambia `app = "docflow-reemplaza-esto"` por el **mismo** nombre que creaste.
4. **Secreto obligatorio:**
   ```bash
   fly secrets set DOCLING_API_KEY="tu-secreto-largo"
   ```
   No uses `DOCFLOW_UI_PREFILL_API_KEY` en público.
5. **Desde la raíz del repo DocFlow:**
   ```bash
   fly deploy
   ```
6. **Probar:** `fly status`, `fly logs`, y en el navegador `https://<tu-app>.fly.dev/health` y la UI en `/`.

Variables no secretas (`GUNICORN_*`, `SYNC_TIMEOUT_*`, `PORT`) ya van en `[env]` del `fly.toml`; ajústalas ahí o con `fly secrets` si prefieres.

---

## Si la UI muestra «Failed to fetch», 504 o el worker muere

1. **Revisa los logs:** `docker compose logs --tail=200 docling-api`. Si aparece `Worker ... SIGKILL` / *Perhaps out of memory*, Docker necesita **más RAM** para el contenedor (en Docker Desktop: *Settings → Resources → Memory*). El `docker-compose.yml` fija `mem_limit: 4g` como referencia.
2. **Primera conversión con OCR en imágenes:** Docling puede **descargar modelos RapidOCR** dentro del contenedor en esa primera petición; puede tardar varios minutos y usar mucha RAM. Las siguientes peticiones suelen ir más rápido. Para una prueba rápida, desactiva **OCR** en la UI o prueba un PDF pequeño.
3. **Timeouts:** en Compose ya se amplían `SYNC_TIMEOUT_SECONDS` y `GUNICORN_TIMEOUT` para cubrir esa primera carga. Ajusta si hace falta.
4. **401 en `favicon.ico`:** es cosmético; el navegador pide el favicon sin API key. La app responde 204 en `/favicon.ico`.

---

## Referencias

- Ticket: [NEU-577](https://linear.app/neuforce/issue/NEU-577)
- [Docling](https://github.com/docling-project/docling)
