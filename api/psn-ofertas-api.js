// api/psn-ofertas.js
// AREA 51 - Extractor independiente de ofertas PS Store Argentina.
// NO modifica ningún archivo existente del proyecto.

const PSN_GRAPHQL = 'https://web.np.playstation.com/api/graphql/v1/op';
const CATEGORY_ID = '3f772501-f6f8-49b7-abac-874a88ca4897';
const LOCALE = 'es-AR';
const STORE_PREFIX = 'https://store.playstation.com/es-ar/product/';

// Persisted-query hashes observados para categoryGridRetrieve.
// Se prueban en orden para tolerar cambios de PlayStation.
const QUERY_HASHES = [
  '9845afc0dbaab4965f6563fffc703f588c8e76792000e8610843b8d3ee9c4c09',
  '4ce7d410a4db2c8b635a48c1dcec375906ff63b19dadd87e073f8fd0c0481d35'
];

const CLASSIFICATIONS = [
  'FULL_GAME',
  'GAME_BUNDLE',
  'PREMIUM_EDITION',
  'OTHER'
];

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function buildVariables(page, size) {
  return {
    id: CATEGORY_ID,
    pageArgs: {
      size,
      offset: (page - 1) * size
    },
    sortBy: {
      name: 'productName',
      isAscending: true
    },
    filterBy: [
      {
        name: 'storeDisplayClassification',
        values: CLASSIFICATIONS
      }
    ],
    facetOptions: []
  };
}

function normalizeProduct(product, page) {
  const price = product?.price || {};
  const id = asText(product?.id).trim();

  return {
    pagina: page,
    nombre: asText(product?.name).trim(),
    plataformas: Array.isArray(product?.platforms)
      ? product.platforms.join(', ')
      : asText(product?.platforms).trim(),
    clasificacion: asText(product?.storeDisplayClassification).trim(),
    precioOriginal: asText(price?.basePrice).trim(),
    precioPromo: asText(price?.discountedPrice || price?.basePrice).trim(),
    descuento: asText(price?.discountText).trim(),
    productId: id,
    urlDirecta: id ? STORE_PREFIX + encodeURIComponent(id) : ''
  };
}

async function requestPage(page, size) {
  const variables = buildVariables(page, size);

  for (const hash of QUERY_HASHES) {
    const extensions = {
      persistedQuery: {
        version: 1,
        sha256Hash: hash
      }
    };

    const url = new URL(PSN_GRAPHQL);
    url.searchParams.set('operationName', 'categoryGridRetrieve');
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('extensions', JSON.stringify(extensions));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-AR,es;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Origin': 'https://store.playstation.com',
        'Referer': 'https://store.playstation.com/',
        'x-psn-store-locale': LOCALE
      }
    });

    const raw = await response.text();
    let json;

    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }

    const grid = json?.data?.categoryGridRetrieve;
    if (response.ok && grid && !json?.errors) {
      return { grid, hash };
    }
  }

  throw new Error(
    'PlayStation no aceptó la consulta de catálogo. Puede haber cambiado el persisted-query hash.'
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const page = Math.max(1, Math.min(150, Number.parseInt(req.query.page || '1', 10)));
  const size = Math.max(1, Math.min(48, Number.parseInt(req.query.size || '24', 10)));

  try {
    const { grid, hash } = await requestPage(page, size);
    const products = Array.isArray(grid.products) ? grid.products : [];
    const rows = products
      .filter((p) => CLASSIFICATIONS.includes(p?.storeDisplayClassification))
      .map((p) => normalizeProduct(p, page));

    return res.status(200).json({
      ok: true,
      pagina: page,
      cantidad: rows.length,
      pageInfo: grid.pageInfo || null,
      reportingName: grid.reportingName || '',
      queryHash: hash,
      productos: rows
    });
  } catch (error) {
    console.error('[AREA51 PSN extractor]', error);
    return res.status(500).json({
      ok: false,
      pagina: page,
      error: error?.message || 'Error desconocido al consultar PlayStation Store'
    });
  }
}
