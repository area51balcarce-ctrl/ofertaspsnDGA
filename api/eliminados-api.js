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

// GitHub Contents omite "content" en archivos grandes (> 1 MB), aunque entrega "sha".
// En ese caso recuperamos el contenido por Git Blobs sin modificar el archivo.
const GITHUB_BLOB_API_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/`;

const RETRYABLE_GITHUB_GET_STATUSES = new Set([429, 500, 502, 503, 504]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubGetJson(url, token) {
  const MAX_READ_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: githubHeaders(token),
        cache: "no-store"
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) return data;

      const error = new Error(
        data?.message || `GitHub respondió HTTP ${response.status}`
      );
      error.status = response.status;
      lastError = error;

      // No reintentar permisos inválidos, 404 ni restricciones de acceso.
      if (!RETRYABLE_GITHUB_GET_STATUSES.has(response.status) ||
          attempt === MAX_READ_ATTEMPTS) {
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (error?.status && !RETRYABLE_GITHUB_GET_STATUSES.has(error.status)) {
        throw error;
      }
      if (attempt === MAX_READ_ATTEMPTS) throw error;
    }

    await wait(350 * attempt);
  }

  throw lastError;
}

async function readGithubDatabase(token) {
  const data = await githubGetJson(
    `${GITHUB_API_URL}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    token
  );

  if (!data?.sha) {
    const error = new Error("GitHub no devolvió el SHA de eliminados.json");
    error.status = 502;
    throw error;
  }

  let base64 = data.content;

  // Para archivos de más de 1 MB, Contents API responde content vacío y
  // encoding "none". Git Blobs permite leer el archivo completo por SHA.
  if (!base64 || data.encoding === "none") {
    const blob = await githubGetJson(
      `${GITHUB_BLOB_API_URL}${encodeURIComponent(data.sha)}`,
      token
    );

    if (!blob?.content || blob.encoding !== "base64" || blob.sha !== data.sha) {
      const error = new Error(
        "GitHub no devolvió el contenido completo de eliminados.json"
      );
      error.status = 502;
      throw error;
    }
    base64 = blob.content;
  } else if (data.encoding !== "base64") {
    const error = new Error("Codificación inesperada de eliminados.json");
    error.status = 502;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(decodeBase64Utf8(base64));
  } catch {
    const error = new Error("eliminados.json existe pero no contiene JSON válido");
    error.status = 500;
    throw error;
  }

  // No convertir un archivo con formato incorrecto en una lista vacía:
  // una escritura posterior podría borrar los eliminados anteriores.
  if (!parsed || !Array.isArray(parsed.eliminados)) {
    const error = new Error("eliminados.json no contiene una lista eliminados válida");
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

    // POST: agregar eliminado (individual o lote)
    if (method === "POST") {
      const body = await parseRequestBody(req);

      // NUEVO: eliminación múltiple en una sola escritura de eliminados.json.
      // El POST individual de siempre se conserva debajo, sin cambios de contrato.
      if (Array.isArray(body.items)) {
        if (body.items.length === 0) {
          return sendJson(res, 400, {
            ok: false,
            error: "ITEMS_REQUERIDOS",
            mensaje: "Debés enviar al menos un juego en items."
          });
        }

        if (body.items.length > 1000) {
          return sendJson(res, 400, {
            ok: false,
            error: "LOTE_DEMASIADO_GRANDE",
            mensaje: "El lote no puede superar los 1000 registros por operación."
          });
        }

        const mapaNuevos = new Map();

        for (const rawItem of body.items) {
          const nombre = String(rawItem?.nombre || "").trim();
          const nombreNormalizado = normalizeText(nombre);
          if (!nombre || !nombreNormalizado) continue;

          const productId = rawItem?.productId
            ? String(rawItem.productId).trim()
            : "";

          const plataformas = Array.isArray(rawItem?.plataformas)
            ? [...new Set(
                rawItem.plataformas
                  .map((x) => String(x).trim())
                  .filter(Boolean)
              )]
            : [];

          if (!mapaNuevos.has(nombreNormalizado)) {
            mapaNuevos.set(nombreNormalizado, {
              nombre,
              nombreNormalizado,
              productId,
              plataformas,
              fechaEliminacion: new Date().toISOString(),
              origen: "manual"
            });
          } else {
            const existente = mapaNuevos.get(nombreNormalizado);
            existente.plataformas = [
              ...new Set([...existente.plataformas, ...plataformas])
            ];
            if (!existente.productId && productId) existente.productId = productId;
          }
        }

        const nuevos = [...mapaNuevos.values()];

        if (nuevos.length === 0) {
          return sendJson(res, 400, {
            ok: false,
            error: "ITEMS_INVALIDOS",
            mensaje: "El lote no contiene juegos válidos."
          });
        }

        const result = await updateWithRetry(
          token,
          (database) => {
            const existentes = new Set(
              database.eliminados.map((item) => item.nombreNormalizado)
            );

            const aAgregar = nuevos.filter(
              (item) => !existentes.has(item.nombreNormalizado)
            );

            if (aAgregar.length === 0) {
              return {
                changed: false,
                database,
                extra: {
                  agregados: [],
                  yaExistian: nuevos.map((item) => item.nombre)
                }
              };
            }

            const updated = {
              eliminados: [...database.eliminados, ...aAgregar].sort((a, b) =>
                a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })
              )
            };

            return {
              changed: true,
              database: updated,
              extra: {
                agregados: aAgregar,
                yaExistian: nuevos
                  .filter((item) => existentes.has(item.nombreNormalizado))
                  .map((item) => item.nombre)
              }
            };
          },
          `DGA PSN: eliminar lote de ${nuevos.length} juegos`
        );

        return sendJson(res, result.changed ? 201 : 200, {
          ok: true,
          lote: true,
          agregados: result.extra.agregados.length,
          yaExistian: result.extra.yaExistian.length,
          cantidad: result.database.eliminados.length,
          registros: result.extra.agregados,
          eliminados: result.database.eliminados
        });
      }

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
