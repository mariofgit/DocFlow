/**
 * DocFlow UI — calls same-origin POST /api/v1/convert (PRD contract).
 */

const STORAGE_KEY = "docflow_api_key";

const form = document.getElementById("convert-form");
const apiKeyInput = document.getElementById("api-key");
const rememberKey = document.getElementById("remember-key");
const fileInput = document.getElementById("file");
const outputFormat = document.getElementById("output-format");
const ocrEnabled = document.getElementById("ocr-enabled");
const submitBtn = document.getElementById("submit-btn");
const btnLabel = submitBtn.querySelector(".btn-label");
const btnSpinner = submitBtn.querySelector(".btn-spinner");
const errorEl = document.getElementById("error");
const resultsBody = document.getElementById("results-body");
const outputPanel = document.getElementById("output-panel");
const tabPreview = document.getElementById("tab-preview");
const tabRaw = document.getElementById("tab-raw");
const serverKeyHint = document.getElementById("server-key-hint");
const debugLogEl = document.getElementById("debug-log");
const debugSection = document.getElementById("debug-section");
const debugClearBtn = document.getElementById("debug-clear");
const debugCopyBtn = document.getElementById("debug-copy");

function debugLog(msg, extra) {
  if (!debugLogEl) return;
  const ts = new Date().toISOString();
  const suffix =
    extra !== undefined
      ? ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`
      : "";
  const line = `[${ts}] ${msg}${suffix}`;
  debugLogEl.textContent += (debugLogEl.textContent ? "\n" : "") + line;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
  console.debug(`[DocFlow] ${line}`);
}

function truncateText(s, max = 8000) {
  if (s == null) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [recortado, ${s.length} caracteres en total]`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function setLoading(loading) {
  submitBtn.disabled = loading;
  btnSpinner.hidden = !loading;
  btnLabel.textContent = loading ? "Convirtiendo…" : "Convertir documento";
}

function removePlaceholder() {
  const ph = resultsBody.querySelector(".placeholder-row");
  if (ph) ph.remove();
}

function addResultRow(data) {
  removePlaceholder();
  const meta = data.metadata || {};
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${escapeHtml(data.filename || "—")}</td>
    <td class="ok">${escapeHtml(data.status || "—")}</td>
    <td>${escapeHtml(data.output_format || "—")}</td>
    <td>${meta.pages != null ? escapeHtml(String(meta.pages)) : "—"}</td>
    <td>${escapeHtml(formatMs(meta.processing_time_ms))}</td>
    <td>${meta.ocr_applied ? "Sí" : "No"}</td>
  `;
  resultsBody.insertBefore(tr, resultsBody.firstChild);
}

function renderOutput(data) {
  outputPanel.hidden = false;
  const fmt = data.output_format;
  const content = data.content;

  if (fmt === "markdown" && typeof content === "string") {
    const rawMd = content;
    tabRaw.textContent = rawMd;
    if (window.marked && window.DOMPurify) {
      const html = marked.parse(rawMd, { mangle: false, headerIds: false });
      tabPreview.innerHTML = DOMPurify.sanitize(html);
    } else {
      tabPreview.textContent = rawMd;
    }
  } else {
    const jsonStr =
      typeof content === "object" && content !== null
        ? JSON.stringify(content, null, 2)
        : String(content);
    tabRaw.textContent = jsonStr;
    tabPreview.innerHTML = `<pre class="json-fallback">${escapeHtml(jsonStr)}</pre>`;
  }

  activateTab("preview");
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  tabPreview.classList.toggle("active", name === "preview");
  tabPreview.hidden = name !== "preview";
  tabRaw.classList.toggle("active", name === "raw");
  tabRaw.hidden = name !== "raw";
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

debugClearBtn?.addEventListener("click", () => {
  if (debugLogEl) debugLogEl.textContent = "";
});

debugCopyBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(debugLogEl?.textContent || "");
    debugLog("Portapapeles: registro copiado.");
  } catch (e) {
    debugLog("No se pudo copiar al portapapeles", e.message);
  }
});

debugLog("UI lista", { origin: location.origin, href: location.href });

const serverKey =
  typeof window.__DOCFLOW_PREFILL_API_KEY__ === "string"
    ? window.__DOCFLOW_PREFILL_API_KEY__
    : "";
const saved = sessionStorage.getItem(STORAGE_KEY);
// Si el servidor inyecta clave (solo entornos de confianza), tiene prioridad sobre sessionStorage.
if (serverKey) {
  apiKeyInput.value = serverKey;
  if (serverKeyHint) serverKeyHint.hidden = false;
} else if (saved) {
  apiKeyInput.value = saved;
  rememberKey.checked = true;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const key = apiKeyInput.value.trim();
  if (rememberKey.checked && key) {
    sessionStorage.setItem(STORAGE_KEY, key);
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  const file = fileInput.files?.[0];
  if (!file) {
    showError("Selecciona un archivo.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showError("El archivo supera 10 MB (límite síncrono del PRD).");
    return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("output_format", outputFormat.value);
  fd.append("ocr_enabled", ocrEnabled.checked ? "true" : "false");

  debugLog("Inicio conversión", {
    file: file.name,
    sizeBytes: file.size,
    outputFormat: outputFormat.value,
    ocrEnabled: ocrEnabled.checked,
    hasApiKey: Boolean(key),
  });

  setLoading(true);
  const t0 = performance.now();
  try {
    const headers = {};
    if (key) {
      headers["X-API-Key"] = key;
      headers.Authorization = `Bearer ${key}`;
    }
    debugLog("fetch POST /api/v1/convert", { headerKeys: Object.keys(headers) });

    const res = await fetch("/api/v1/convert", {
      method: "POST",
      headers,
      body: fd,
    });

    const elapsedMs = Math.round(performance.now() - t0);
    const requestId = res.headers.get("x-docflow-request-id");
    debugLog("Respuesta HTTP", {
      status: res.status,
      ok: res.ok,
      elapsedMs,
      requestId: requestId || null,
      contentType: res.headers.get("content-type"),
    });

    const text = await res.text();
    debugLog("Cuerpo bruto (recortado en registro)", truncateText(text, 4000));

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { detail: text || res.statusText };
    }

    if (!res.ok) {
      debugSection?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const msg =
        typeof body.detail === "string"
          ? body.detail
          : Array.isArray(body.detail)
            ? body.detail.map((d) => d.msg || d).join("; ")
            : `Error ${res.status}`;
      debugLog("Error API", { message: msg, requestId: requestId || null });
      showError(msg);
      return;
    }

    debugLog("OK", {
      requestId: requestId || null,
      pages: body.metadata?.pages,
      processingMs: body.metadata?.processing_time_ms,
      outputFormat: body.output_format,
    });
    addResultRow(body);
    renderOutput(body);
  } catch (err) {
    debugSection?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    debugLog("Fallo de red o excepción en el cliente", {
      name: err.name,
      message: err.message,
      stack: err.stack ? truncateText(err.stack, 1500) : undefined,
    });
    showError(err.message || "No se pudo conectar con el servicio.");
  } finally {
    setLoading(false);
  }
});
