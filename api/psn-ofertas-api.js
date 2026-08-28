// api/psn-ofertas-api.js
// AREA 51 - Extractor independiente de ofertas PS Store Argentina.
// Proyecto exclusivo: ofertaspsnDGA.

const PSN_GRAPHQL = 'https://web.np.playstation.com/api/graphql/v1//op';
const CATEGORY_ID = '3f772501-f6f8-49b7-abac-874a88ca4897';
const LOCALE = 'es-AR';
const STORE_PREFIX = 'https://store.playstation.com/es-ar/product/';

const QUERY_HASH =
  '88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03';

const FILTERS = [
  'storeDisplayClassification:FULL_GAME',
  'storeDisplayClassification:GAME_BUNDLE',
  'storeDisplayClassification:PREMIUM_EDITION',
  'storeDisplayClassification:OTHER'
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
    filterBy: FILTERS,
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

  const extensions = {
    persistedQuery: {
      version: 1,
      sha256Hash: QUERY_HASH
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
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
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
    throw new Error(`PlayStation devolvió una respuesta no JSON. HTTP ${response.status}.`);
  }

  if (!response.ok) {
    const apiMessage =
      json?.errors?.[0]?.message ||
      json?.message ||
      `HTTP ${response.status}`;
    throw new Error(`PlayStation rechazó la consulta: ${apiMessage}`);
  }

  if (json?.errors?.length) {
    throw new Error(
      `PlayStation GraphQL: ${json.errors.map((e) => e?.message || 'Error').join(' | ')}`
    );
  }

  const grid = json?.data?.categoryGridRetrieve;

  if (!grid) {
    throw new Error(
      'PlayStation respondió OK pero no devolvió data.categoryGridRetrieve.'
    );
  }

  return grid;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const page = Math.max(
    1,
    Math.min(150, Number.parseInt(req.query.page || '1', 10))
  );

  const size = Math.max(
    1,
    Math.min(24, Number.parseInt(req.query.size || '24', 10))
  );

  try {
    const grid = await requestPage(page, size);
    const products = Array.isArray(grid.products) ? grid.products : [];
    const rows = products.map((p) => normalizeProduct(p, page));

    return res.status(200).json({
      ok: true,
      pagina: page,
      cantidad: rows.length,
      pageInfo: grid.pageInfo || null,
      reportingName: grid.reportingName || '',
      queryHash: QUERY_HASH,
      productos: rows
    });
  } catch (error) {
    console.error('[AREA51 PSN extractor]', error);

    return res.status(500).json({
      ok: false,
      pagina: page,
      error:
        error?.message ||
        'Error desconocido al consultar PlayStation Store'
    });
  }
}
