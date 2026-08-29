// api/eliminados-api.js
// DGA - Base persistente "ELIMINADOS POR MI"
// Vercel Serverless Function + GitHub Contents API
//
// IMPORTANTE:
// - Este archivo NO modifica el extractor PSN existente.
// - Lee y escribe únicamente:
//   area51balcarce-ctrl/dga-psn-datos/eliminados.json
// - El token se toma exclusivamente desde:
//   process.env.GITHUB_DATA_TOKEN

const GITHUB_OWNER = "area51balcarce-ctrl";
const GITHUB_REPO = "dga-psn-datos";
const GITHUB_FILE_PATH = "eliminados.json";
const GITHUB_BRANCH = "main";

const GITHUB_API_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sendJson(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(status).json(payload);
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DGA-PSN-Vercel"
  };
}

async function parseRequestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

function decodeBase64Utf8(base64) {
  return Buffer.from(String(base64).replace(/\n/g, ""), "base64").toString("utf8");
}

function encodeBase64Utf8(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function sanitizeDatabase(raw) {
  const eliminados = Array.isArray(raw?.eliminados) ? raw.eliminados : [];

  return {
    eliminados: eliminados
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        nombre: String(item.nombre || "").trim(),
        nombreNormalizado:
          String(item.nombreNormalizado || "").trim() ||
          normalizeText(item.nombre || ""),
        productId: item.productId ? String(item.productId).trim() : "",
        plataformas: Array.isArray(item.plataformas)
          ? item.plataformas.map((x) => String(x).trim()).filter(Boolean)
          : [],
        fechaEliminacion: item.fechaEliminacion
          ? String(item.fechaEliminacion)
          : "",
        origen: item.origen ? String(item.origen) : "manual"
      }))
      .filter((item) => item.nombre && item.nombreNormalizado)
  };
}

async function readGithubDatabase(token) {
  const response = await fetch(
    `${GITHUB_API_URL}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    {
      method: "GET",
      headers: githubHeaders(token),
      cache: "no-store"
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data?.message || `GitHub respondió HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  if (!data?.content || !data?.sha) {
    const error = new Error("GitHub no devolvió content/sha de eliminados.json");
    error.status = 502;
    throw error;
  }

  let parsed;

  try {
    parsed = JSON.parse(decodeBase64Utf8(data.content));
  } catch {
    const error = new Error("eliminados.json existe pero no contiene JSON válido");
    error.status = 500;
    throw error;
  }

  return {
    sha: data.sha,
    database: sanitizeDatabase(parsed)
  };
}

async function writeGithubDatabase(token, database, sha, message) {
  const content = JSON.stringify(sanitizeDatabase(database), null, 2) + "\n";

  const response = await fetch(GITHUB_API_URL, {
    method: "PUT",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(content),
      sha,
      branch: GITHUB_BRANCH
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data?.message || `GitHub respondió HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

async function updateWithRetry(token, updater, commitMessage) {
  const MAX_ATTEMPTS = 2;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const current = await readGithubDatabase(token);
      const result = updater(current.database);

      if (!result.changed) {
        return {
          changed: false,
          database: result.database,
          extra: result.extra || {}
        };
      }

      await writeGithubDatabase(
        token,
        result.database,
        current.sha,
        commitMessage
      );

      return {
        changed: true,
        database: result.database,
        extra: result.extra || {}
      };
    } catch (error) {
      lastError = error;

      const retryable = error?.status === 409 || error?.status === 422;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastError;
}

module.exports = async function handler(req, res) {
  const token = process.env.GITHUB_DATA_TOKEN;

  if (!token) {
    return sendJson(res, 500, {
      ok: false,
      error: "CONFIGURACION_INCOMPLETA",
      mensaje: "Falta la variable privada GITHUB_DATA_TOKEN en Vercel."
    });
  }

  const method = String(req.method || "GET").toUpperCase();

  try {
    // GET: leer eliminados
    if (method === "GET") {
      const { database } = await readGithubDatabase(token);

      return sendJson(res, 200, {
        ok: true,
        cantidad: database.eliminados.length,
        eliminados: database.eliminados
      });
    }

    // POST: agregar eliminado
    if (method === "POST") {
      const body = await parseRequestBody(req);

      const nombre = String(body.nombre || "").trim();
      const nombreNormalizado = normalizeText(nombre);
      const productId = body.productId
        ? String(body.productId).trim()
        : "";

      const plataformas = Array.isArray(body.plataformas)
        ? [...new Set(
            body.plataformas
              .map((x) => String(x).trim())
              .filter(Boolean)
          )]
        : [];

      if (!nombre || !nombreNormalizado) {
        return sendJson(res, 400, {
          ok: false,
          error: "NOMBRE_REQUERIDO",
          mensaje: "Debés enviar el campo nombre."
        });
      }

      const nuevo = {
        nombre,
        nombreNormalizado,
        productId,
        plataformas,
        fechaEliminacion: new Date().toISOString(),
        origen: "manual"
      };

      const result = await updateWithRetry(
        token,
        (database) => {
          const existente = database.eliminados.find(
            (item) => item.nombreNormalizado === nombreNormalizado
          );

          if (existente) {
            return {
              changed: false,
              database,
              extra: {
                yaExistia: true,
                registro: existente
              }
            };
          }

          const updated = {
            eliminados: [...database.eliminados, nuevo].sort((a, b) =>
              a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })
            )
          };

          return {
            changed: true,
            database: updated,
            extra: {
              yaExistia: false,
              registro: nuevo
            }
          };
        },
        `DGA PSN: eliminar ${nombre}`
      );

      return sendJson(res, result.changed ? 201 : 200, {
        ok: true,
        agregado: result.changed,
        yaExistia: Boolean(result.extra.yaExistia),
        cantidad: result.database.eliminados.length,
        registro: result.extra.registro,
        eliminados: result.database.eliminados
      });
    }

    // DELETE: restaurar eliminado
    if (method === "DELETE") {
      const body = await parseRequestBody(req);

      const nombreOriginal = String(body.nombre || "").trim();
      const nombreNormalizado = normalizeText(
        body.nombreNormalizado || nombreOriginal
      );

      if (!nombreNormalizado) {
        return sendJson(res, 400, {
          ok: false,
          error: "NOMBRE_REQUERIDO",
          mensaje: "Debés enviar nombre o nombreNormalizado."
        });
      }

      const result = await updateWithRetry(
        token,
        (database) => {
          const existente = database.eliminados.find(
            (item) => item.nombreNormalizado === nombreNormalizado
          );

          if (!existente) {
            return {
              changed: false,
              database,
              extra: {
                encontrado: false,
                registro: null
              }
            };
          }

          return {
            changed: true,
            database: {
              eliminados: database.eliminados.filter(
                (item) => item.nombreNormalizado !== nombreNormalizado
              )
            },
            extra: {
              encontrado: true,
              registro: existente
            }
          };
        },
        `DGA PSN: restaurar ${nombreOriginal || nombreNormalizado}`
      );

      return sendJson(res, 200, {
        ok: true,
        restaurado: result.changed,
        encontrado: Boolean(result.extra.encontrado),
        cantidad: result.database.eliminados.length,
        registro: result.extra.registro,
        eliminados: result.database.eliminados
      });
    }

    res.setHeader("Allow", "GET, POST, DELETE");

    return sendJson(res, 405, {
      ok: false,
      error: "METODO_NO_PERMITIDO",
      mensaje: "Métodos permitidos: GET, POST y DELETE."
    });
  } catch (error) {
    console.error("ERROR eliminados-api:", error);

    const status =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;

    return sendJson(res, status, {
      ok: false,
      error: "ERROR_ELIMINADOS_API",
      mensaje: error?.message || "Error interno inesperado.",
      githubStatus: error?.status || null
    });
  }
};
