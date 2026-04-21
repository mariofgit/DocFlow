# DocFlow — PRD

**Origen:** Linear [NEU-577: Deploy Docling Document Conversion Service (REST API + MCP)](https://linear.app/neuforce/issue/NEU-577/deploy-docling-document-conversion-service-rest-api-mcp)  
**Última actualización en Linear:** 2026-04-20T16:41:29.900Z

_Para refrescar:_ desde la raíz del monorepo ejecuta `./linear.sh get NEU-577` (requiere `LINEAR_API_KEY` en `neuForce/.env` o `jamie-oliver-ai/scripts/.env`).

---

# PRD — Neuforce Document Conversion Service

**Project:** `docling-service`
**Owner:** Neuforce Engineering
**Status:** Draft
**Date:** 2026-04-09

---

## 1\. Overview

### 1.1 Problem Statement

Neuforce IA (Intelligent Automation) services need to ingest documents in various formats (PDF, DOCX, PPTX, HTML, images) and process their content. Raw document formats are not directly consumable by downstream AI/LLM pipelines — they require conversion into structured, readable formats (Markdown and JSON) that preserve document layout, tables, and hierarchical structure.

### 1.2 Proposed Solution

Deploy a centralized **Document Conversion Service** powered by [Docling](<https://github.com/docling-project/docling>) — IBM's open-source document parsing library — exposed via both a **REST API** and an **MCP (Model Context Protocol) server**. The service will be containerized and deployed to **AWS ECS Fargate** using **AWS CDK (TypeScript)**, accessible at a public DNS endpoint (e.g., `https://dcs.neuforce.ai`).

### 1.3 Key Decisions

| Decision | Choice | Rationale |
| -- | -- | -- |
| Compute | CPU-only (Fargate) | Cost-effective; GPU can be added later if OCR throughput becomes a bottleneck |
| Auth | API Key (header-based) | Simple, low-overhead; sufficient for service-to-service communication |
| Processing | Sync + Async | Sync for small/fast docs; async queue-based for large documents |
| Storage | Direct upload only | No S3 integration; documents are uploaded via API and results returned directly |
| IaC | AWS CDK (TypeScript) | Consistent with Neuforce infrastructure standards |

---

## 2\. Architecture

### 2.1 High-Level Architecture

```
                          ┌─────────────────────────────┐
                          │     Route 53 (Public DNS)    │
                          │  dcs.neuforce.ai       │
                          └──────────────┬──────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │   Application Load Balancer  │
                          │   (HTTPS / ACM Certificate)  │
                          └──────────────┬──────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │      ECS Fargate Service     │
                          │  ┌────────────────────────┐  │
                          │  │   API Gateway / Auth    │  │
                          │  │   (API Key Validation)  │  │
                          │  └─────────┬──────────────┘  │
                          │            │                  │
                          │  ┌─────────▼──────────────┐  │
                          │  │   Docling-Serve (REST)  │  │
                          │  │   + Docling-MCP Server  │  │
                          │  └─────────┬──────────────┘  │
                          │            │                  │
                          │  ┌─────────▼──────────────┐  │
                          │  │   Async Job Queue       │  │
                          │  │   (In-memory / Redis)   │  │
                          │  └────────────────────────┘  │
                          └──────────────────────────────┘
```

### 2.2 Components

**2.2.1 Docling-Serve (REST API)**

Based on [docling-serve](<https://github.com/docling-project/docling-serve>), this is the core conversion engine. It exposes a FastAPI-based REST API for document conversion. Key endpoints:

* `POST /convert` — Synchronous document conversion. Accepts file upload, returns Markdown or JSON.
* `POST /convert/async` — Asynchronous conversion. Returns a job ID immediately.
* `GET /jobs/{job_id}` — Poll async job status and retrieve results.
* `GET /health` — Health check for ALB target group.

**2.2.2 Docling-MCP Server**

Based on [docling-mcp](<https://github.com/docling-project/docling-mcp>), this exposes Docling's capabilities as MCP tools, allowing LLM agents (including Claude) to invoke document conversion directly. The MCP server runs alongside docling-serve in the same container, exposed via a dedicated path (`/mcp` or SSE endpoint).

MCP Tools exposed:

* `convert_document` — Convert an uploaded or URL-referenced document to Markdown/JSON.
* `get_job_status` — Check status of an async conversion job.

**2.2.3 Auth Layer**

A lightweight middleware (FastAPI middleware or sidecar) that validates API keys on every request to both REST and MCP endpoints.

* API keys are stored in **AWS Secrets Manager** or passed as environment variables.
* Requests must include the header: `X-API-Key: <key>`.
* MCP transport (SSE) must also pass the API key via headers or query parameter for initial handshake.
* Unauthorized requests receive `401 Unauthorized`.

**2.2.4 Async Job Queue**

For large document processing that exceeds sync timeout thresholds:

* An in-process task queue (using Python's `asyncio` + a lightweight job store, or Celery with an in-memory broker for MVP).
* Jobs are tracked with a unique `job_id`, status (`pending`, `processing`, `completed`, `failed`), and result payload.
* Results are held in memory with a configurable TTL (default: 1 hour) before eviction.
* **Future enhancement:** Replace in-memory queue with SQS + DynamoDB for persistence and multi-instance scalability.

---

## 3\. Functional Requirements

### 3.1 Input Formats

| Format | Extensions | Notes |
| -- | -- | -- |
| PDF | `.pdf` | Native parsing + OCR fallback for scanned pages |
| Microsoft Word | `.docx` | Full structure preservation |
| Microsoft PowerPoint | `.pptx` | Slide-by-slide conversion |
| HTML | `.html`, `.htm` | Web page content extraction |
| Images | `.png`, `.jpg`, `.jpeg`, `.tiff`, `.bmp` | OCR-based text extraction |

### 3.2 Output Formats

| Format | Content-Type | Description |
| -- | -- | -- |
| Markdown | `text/markdown` | Human-readable, preserves headings, tables, lists |
| JSON | `application/json` | Structured Docling document model with metadata, hierarchy, bounding boxes |

### 3.3 API Contract

#### Synchronous Conversion

```
POST /api/v1/convert
Headers:
  X-API-Key: <api-key>
  Content-Type: multipart/form-data

Body:
  file: <binary>
  output_format: "markdown" | "json"    (default: "markdown")
  ocr_enabled: true | false             (default: true)

Response 200:
{
  "status": "success",
  "filename": "report.pdf",
  "output_format": "markdown",
  "content": "# Report Title\n\n...",
  "metadata": {
    "pages": 12,
    "processing_time_ms": 3420,
    "ocr_applied": true
  }
}
```

#### Asynchronous Conversion

```
POST /api/v1/convert/async
Headers:
  X-API-Key: <api-key>
  Content-Type: multipart/form-data

Body:
  file: <binary>
  output_format: "markdown" | "json"
  ocr_enabled: true | false

Response 202:
{
  "job_id": "a1b2c3d4-e5f6-...",
  "status": "pending",
  "poll_url": "/api/v1/jobs/a1b2c3d4-e5f6-..."
}
```

```
GET /api/v1/jobs/{job_id}
Headers:
  X-API-Key: <api-key>

Response 200 (completed):
{
  "job_id": "a1b2c3d4-e5f6-...",
  "status": "completed",
  "filename": "report.pdf",
  "output_format": "markdown",
  "content": "# Report Title\n\n...",
  "metadata": { ... }
}

Response 200 (processing):
{
  "job_id": "a1b2c3d4-e5f6-...",
  "status": "processing",
  "progress": 45
}
```

#### MCP Endpoint

```
SSE: /mcp/sse
Headers:
  X-API-Key: <api-key>

Available Tools:
  - convert_document(file_base64, filename, output_format, ocr_enabled)
  - convert_document_from_url(url, output_format, ocr_enabled)
  - get_job_status(job_id)
```

### 3.4 File Size Limits

| Mode | Max File Size | Timeout |
| -- | -- | -- |
| Synchronous | 10 MB | 120 seconds |
| Asynchronous | 50 MB | 600 seconds |

Files exceeding 10 MB sent to the sync endpoint will receive a `413` with a message suggesting the async endpoint.

---

## 4\. Infrastructure & Deployment

### 4.1 AWS CDK Stack (TypeScript)

The infrastructure is defined as a single CDK stack: `DoclingServiceStack`.

**Resources provisioned:**

* **ECS Fargate Cluster** — Runs the Docling service container.
* **ECS Fargate Service** — Configurable via `deployment.json` (CPU, memory, desired count).
* **Application Load Balancer (ALB)** — Public-facing, HTTPS-only.
* **ACM Certificate** — Auto-validated via DNS for `documents.neuforce.ai`.
* **Route 53 A-Record** — Alias to ALB, under the provided hosted zone.
* **CloudWatch Log Group** — Centralized logging for the ECS tasks.
* **Secrets Manager Secret** — Stores API keys for auth validation.
* **ECR Repository** — Hosts the Docling service Docker image.

### 4.2 deployment.json

```json
{
  "staging": {
    "cpu": 256,
    "memory": 512,
    "desiredCount": 1,
    "public": true,
    "publicDns": {
      "hostedZoneId": "Z0756872BCLQQ2SZ29SE",
      "apexDomain": "neuforce.ai",
      "tenantSubdomainPrefix": "dom"
    }
  },
  "production": {
    "cpu": 1024,
    "memory": 2048,
    "desiredCount": 2,
    "public": true,
    "publicDns": {
      "hostedZoneId": "Z0756872BCLQQ2SZ29SE",
      "apexDomain": "neuforce.ai",
      "tenantSubdomainPrefix": "documents"
    },
    "autoScaling": {
      "minCount": 2,
      "maxCount": 6,
      "cpuTargetUtilization": 70
    }
  }
}
```

**DNS Resolution:**
The `tenantSubdomainPrefix` + `apexDomain` compose the public URL. For staging: `https://dom.neuforce.ai`, for production: `https://documents.neuforce.ai`.

### 4.3 Docker Image

The Docker image is built from a custom `Dockerfile` that:

1. Uses `python:3.11-slim` as the base image.
2. Installs `docling`, `docling-serve`, and `docling-mcp` with their dependencies.
3. Pre-downloads the required ML models (layout analysis, table structure recognition, OCR) at build time to avoid cold-start latency.
4. Exposes port `8080` for the FastAPI application.
5. Runs a supervisord or multi-process entrypoint to serve both REST and MCP endpoints.

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for OCR
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download models at build time
RUN python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"

COPY . .

EXPOSE 8080

CMD ["python", "main.py"]
```

### 4.4 CDK Stack Structure

```
docling-service/
├── cdk/
│   ├── bin/
│   │   └── app.ts                    # CDK app entry point
│   ├── lib/
│   │   └── docling-service-stack.ts  # Main stack definition
│   ├── deployment.json               # Environment configuration
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── service/
│   ├── main.py                       # FastAPI app entrypoint
│   ├── auth.py                       # API key auth middleware
│   ├── routes/
│   │   ├── convert.py                # Sync/async conversion endpoints
│   │   └── jobs.py                   # Job status endpoints
│   ├── mcp_server.py                 # MCP server setup
│   ├── queue/
│   │   └── job_manager.py            # Async job queue manager
│   ├── requirements.txt
│   └── Dockerfile
└── README.md
```

---

## 5\. Non-Functional Requirements

### 5.1 Performance

* Synchronous conversion of a 5-page PDF should complete within **15 seconds** on CPU.
* Async queue should accept jobs within **500ms** and begin processing immediately if capacity is available.
* The service should handle **10 concurrent sync requests** at the staging tier (256 CPU / 512 MB).

### 5.2 Reliability

* ECS service configured with health checks (ALB + container-level).
* Automatic task restart on failure via ECS service scheduler.
* Production environment runs a minimum of 2 tasks for availability.
* Auto-scaling based on CPU utilization (70% target) in production.

### 5.3 Security

* All traffic over HTTPS (TLS 1.2+), enforced at ALB.
* API key validation on every request (REST and MCP).
* API keys rotatable via Secrets Manager without redeployment (env var refresh or Secrets Manager SDK call).
* No document persistence — files are processed in memory and discarded after response/TTL expiry.
* ECS tasks run in private subnets with NAT gateway for outbound access (optional, depends on VPC config).

### 5.4 Observability

* **Logs:** All application logs streamed to CloudWatch Logs via `awslogs` driver.
* **Metrics:** ECS service CPU/memory utilization, ALB request count, latency (p50/p95/p99), 4xx/5xx rates.
* **Alarms:** CloudWatch alarms on 5xx rate > 5% and CPU > 85% sustained for 5 minutes.
* **Structured logging:** JSON-formatted logs with `request_id`, `job_id`, `processing_time`, `file_type`, `file_size`.

### 5.5 Cost Estimate (Staging)

| Resource | Estimated Monthly Cost |
| -- | -- |
| Fargate (256 CPU / 512 MB, 1 task, 24/7) | \~$9 |
| ALB | \~$18 |
| Route 53 Hosted Zone | \~$0.50 |
| CloudWatch Logs (10 GB) | \~$5 |
| Secrets Manager (1 secret) | \~$0.40 |
| ACM Certificate | Free |
| **Total (Staging)** | **\~$33/month** |

---

## 6\. Milestones & Phases

### Phase 1 — MVP (Weeks 1–3)

* Dockerized Docling-Serve with REST API (sync conversion only).
* API key authentication middleware.
* CDK stack: ECS Fargate + ALB + Route 53 + ACM.
* `deployment.json`-driven configuration.
* Deploy to staging (`dom.neuforce.ai`).
* Supports PDF, DOCX, PPTX, HTML, Images → Markdown + JSON.

### Phase 2 — Async & MCP (Weeks 4–5)

* Async job queue (in-memory) with `POST /convert/async` and `GET /jobs/{id}`.
* Docling-MCP server integration alongside REST on the same container.
* MCP endpoint auth (API key over SSE headers).
* Production deployment with auto-scaling.

### Phase 3 — Hardening (Weeks 6–7)

* Structured logging and CloudWatch alarms.
* Rate limiting per API key.
* Load testing (target: 50 concurrent conversions in production).
* API documentation (OpenAPI/Swagger auto-generated from FastAPI).
* Runbook and operational documentation.

### Phase 4 — Future Enhancements (Backlog)

* GPU-enabled Fargate tasks for faster OCR.
* SQS + DynamoDB for durable async job queue.
* S3 integration for large file input/output.
* Webhook callbacks for async job completion.
* Multi-tenant API key scoping and usage metering.
* Docling model fine-tuning for Neuforce-specific document layouts.

---

## 7\. Open Questions

| \# | Question | Impact | Status |
| -- | -- | -- | -- |
| 1 | What is the expected request volume (docs/day) for production sizing? | Auto-scaling config, cost | Open |
| 2 | Should API keys be scoped per-service or per-team? | Auth design | Open |
| 3 | Is there an existing VPC to deploy into, or should the stack create its own? | CDK stack design | Open |
| 4 | Do we need CORS support for browser-based uploads? | API middleware config | Open |
| 5 | What is the retention policy for async job results (TTL)? | Memory management | Default: 1hr |

---

## 8\. Appendix

### A. Docling Capabilities Reference

Docling provides advanced document understanding including:

* **Layout analysis** — Detects headings, paragraphs, tables, figures, lists, and page structure using deep learning models.
* **Table structure recognition** — Extracts table rows, columns, and cell content with structural fidelity.
* **OCR** — Tesseract-based OCR for scanned documents and images, with optional EasyOCR backend.
* **Metadata extraction** — Title, authors, language, page dimensions.
* **Chunking** — Built-in document chunking for RAG pipelines (available as a future enhancement).

### B. Related Repositories

| Repository | Purpose |
| -- | -- |
| [docling](<https://github.com/docling-project/docling>) | Core Python library for document conversion |
| [docling-serve](<https://github.com/docling-project/docling-serve>) | FastAPI REST API wrapper around Docling |
| [docling-mcp](<https://github.com/docling-project/docling-mcp>) | MCP server exposing Docling tools for LLM agents |
| [docling.ai](<https://www.docling.ai/>) | Project homepage and documentation |
