const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "127.0.0.1";
const APP_ROOT = __dirname;
const WORKSPACE_ROOT = path.resolve(APP_ROOT, "..", "..");
const PUBLIC_ROOT = path.join(APP_ROOT, "public");
const ALLOWED_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "tmp",
  "logs"
]);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function safeJoinWithinWorkspace(relativePath) {
  const normalizedInput = typeof relativePath === "string" ? relativePath.trim() : "";
  if (!normalizedInput) {
    throw new Error("No se proporciono una ruta.");
  }

  const absolutePath = path.resolve(WORKSPACE_ROOT, normalizedInput);
  const relativeFromRoot = path.relative(WORKSPACE_ROOT, absolutePath);

  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error("La ruta esta fuera del workspace.");
  }

  return absolutePath;
}

async function parseRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    throw new Error("El cuerpo de la peticion no es JSON valido.");
  }
}

async function listJsonlFiles(directory, baseDirectory = directory, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(baseDirectory, absolutePath);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await listJsonlFiles(absolutePath, baseDirectory, files);
      continue;
    }

    if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(relativePath);
    }
  }

  return files;
}

function validateJsonlContent(content) {
  const text = typeof content === "string" ? content : "";

  if (text === "") {
    return {
      lineCount: 0,
      hasTrailingNewline: false
    };
  }

  const lines = text.split(/\r?\n/);
  const hasTrailingNewline = text.endsWith("\n");
  const lastIndex = hasTrailingNewline ? lines.length - 2 : lines.length - 1;

  for (let index = 0; index <= lastIndex; index += 1) {
    const line = lines[index];

    if (!line || !line.trim()) {
      throw new Error(`La linea ${index + 1} esta vacia.`);
    }

    try {
      JSON.parse(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "JSON invalido";
      throw new Error(`La linea ${index + 1} no contiene JSON valido: ${detail}`);
    }
  }

  return {
    lineCount: Math.max(lastIndex + 1, 0),
    hasTrailingNewline
  };
}

function getErrorStatusCode(error) {
  const message = error instanceof Error ? error.message : "";

  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT") {
      return 404;
    }

    if (error.code === "EACCES") {
      return 403;
    }
  }

  if (
    message.startsWith("No se proporciono") ||
    message.startsWith("El cuerpo") ||
    message.startsWith("La linea") ||
    message.startsWith("La ruta esta fuera")
  ) {
    return 400;
  }

  return 500;
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStaticAsset(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const assetPath = path.join(PUBLIC_ROOT, normalizedPath);
  const relativeAsset = path.relative(PUBLIC_ROOT, assetPath);

  if (relativeAsset.startsWith("..") || path.isAbsolute(relativeAsset)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const asset = await fs.readFile(assetPath);
    response.writeHead(200, {
      "Content-Type": getMimeType(assetPath),
      "Content-Length": asset.length,
      "Cache-Control": "no-store"
    });
    response.end(asset);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }

    throw error;
  }
}

async function handleApiRequest(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/files") {
    const files = await listJsonlFiles(WORKSPACE_ROOT);
    files.sort((left, right) => left.localeCompare(right));

    sendJson(response, 200, {
      workspaceRoot: WORKSPACE_ROOT,
      files
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/meta") {
    sendJson(response, 200, {
      workspaceRoot: WORKSPACE_ROOT,
      allowedExtensions: [...ALLOWED_EXTENSIONS]
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/load") {
    const body = await parseRequestBody(request);
    const requestedPath = typeof body.path === "string" ? body.path : "";
    const absolutePath = safeJoinWithinWorkspace(requestedPath);

    if (!ALLOWED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      sendJson(response, 400, {
        error: "Solo se permiten archivos .jsonl o .ndjson."
      });
      return;
    }

    const [content, stats] = await Promise.all([
      fs.readFile(absolutePath, "utf-8"),
      fs.stat(absolutePath)
    ]);

    sendJson(response, 200, {
      path: path.relative(WORKSPACE_ROOT, absolutePath),
      content,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/save") {
    const body = await parseRequestBody(request);
    const requestedPath = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : "";
    const absolutePath = safeJoinWithinWorkspace(requestedPath);

    if (!ALLOWED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      sendJson(response, 400, {
        error: "Solo se permiten archivos .jsonl o .ndjson."
      });
      return;
    }

    const validation = validateJsonlContent(content);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");

    sendJson(response, 200, {
      path: path.relative(WORKSPACE_ROOT, absolutePath),
      saved: true,
      lineCount: validation.lineCount,
      hasTrailingNewline: validation.hasTrailingNewline
    });
    return;
  }

  sendJson(response, 404, { error: "Ruta no encontrada." });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, url);
      return;
    }

    await serveStaticAsset(url.pathname, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    const statusCode = getErrorStatusCode(error);
    sendJson(response, statusCode, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JSONL viewer running at http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});
