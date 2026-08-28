// api/psn-ofertas-api.js
// AREA 51 - Extractor independiente de ofertas PS Store Argentina.
// Proyecto exclusivo: ofertaspsnDGA.
// Se conserva intacta la consulta a PlayStation que ya funciona.
// Esta versión AGREGA una capa comercial después de normalizar los productos.

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

// -----------------------------------------------------------------------------
// CAPA COMERCIAL - NUEVA
// -----------------------------------------------------------------------------

const EXCLUDED_TYPES = [
  'VIRTUAL_CURRENCY',
  'ADD_ON_PACK',
  'SEASON_PASS',
  'ITEM',
  'CHARACTER',
  'LEVEL',
  'OTHER',
  'COSTUME',
  'VEHICLE',
  'MAP',
  'EPISODE',
  'WEAPONS',
  'TICKET',
  'TRACK'
];

const EXCLUDED_NAME_TERMS = [
  'DLC',
  'Add-on',
  'Season Pass',
  'Expansion',
  'Expansion Pass',
  'Content Pack',
  'Character Pack',
  'Costume Pack',
  'Skin Pack',
  'Weapon Pack',
  'Map Pack',
  'Currency',
  'Coins',
  'Points',
  'Credits',
  'In-game currency'
];

const excludedGames = [
  '0 Degrees',
  '15in1 Solitaire',
  'Super Puzzles Dream',
  'Kittengumi: The Sakuran Chronicles - Chapter 0',
  'Garten of Banban 0',
  'Arcade Archives',
  'Rock Band',
  'Primal Carnage: Extinction',
  'Audica',
  '112th Seed',
  '10-Second Ghost',
  '11-11 Memories Retold',
  '20th Century Beauties',
  '2Dark',
  '30 Sport Games in 1',
  '34 Sports Games',
  '30 Billiards',
  '4PGP'
];

// VR conservador: NO se elimina por contener simplemente "VR" o "PS VR".
// Solo se descarta si el nombre contiene una señal fuerte de exclusividad/requisito VR.
const VR_EXCLUSIVE_TERMS = [
  'VR Only',
  'VR-Only',
  'Virtual Reality Only',
  'VR Experience',
  'PS VR Required',
  'PS VR2 Required',
  'PSVR Required',
  'PSVR2 Required',
  'PlayStation VR Required',
  'PlayStation VR2 Required'
];

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeText(value) {
  return asText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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

function matchesNormalizedTerm(text, term) {
  return normalizeText(text).includes(normalizeText(term));
}

function getCommercialExclusion(row) {
  const type = asText(row.clasificacion).trim().toUpperCase();

  if (EXCLUDED_TYPES.includes(type)) {
    return {
      motivoExclusion: 'TIPO_EXCLUIDO',
      detalleExclusion: type
    };
  }

  const extraTerm = EXCLUDED_NAME_TERMS.find((term) =>
    matchesNormalizedTerm(row.nombre, term)
  );

  if (extraTerm) {
    return {
      motivoExclusion: 'CONTENIDO_EXTRA',
      detalleExclusion: extraTerm
    };
  }

  const vrTerm = VR_EXCLUSIVE_TERMS.find((term) =>
    matchesNormalizedTerm(row.nombre, term)
  );

  if (vrTerm) {
    return {
      motivoExclusion: 'VR_EXCLUSIVO',
      detalleExclusion: vrTerm
    };
  }

  const blacklisted = excludedGames.find((game) =>
    matchesNormalizedTerm(row.nombre, game)
  );

  if (blacklisted) {
    return {
      motivoExclusion: 'LISTA_NEGRA',
      detalleExclusion: blacklisted
    };
  }

  return null;
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
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Origin': 'https://store.playstation.com',
      'Referer': 'https://store.playstation.com/',
      'x-psn-store-locale': LOCALE,
      'x-apollo-operation-name': 'categoryGridRetrieve',
      'apollo-require-preflight': 'true'
    }
  });

  const raw = await response.text();
  let json;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `PlayStation devolvió una respuesta no JSON. HTTP ${response.status}.`
    );
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
      `PlayStation GraphQL: ${json.errors
        .map((e) => e?.message || 'Error')
        .join(' | ')}`
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
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
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
    const normalizedRows = products.map((p) => normalizeProduct(p, page));

    const comerciales = [];
    const descartados = [];

    for (const row of normalizedRows) {
      const exclusion = getCommercialExclusion(row);

      if (exclusion) {
        descartados.push({
          ...row,
          ...exclusion
        });
      } else {
        comerciales.push(row);
      }
    }

    const descartadosPorMotivo = descartados.reduce((acc, row) => {
      const key = row.motivoExclusion || 'OTRO';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return res.status(200).json({
      ok: true,
      pagina: page,
      cantidadOriginal: normalizedRows.length,
      cantidad: comerciales.length,
      cantidadComercial: comerciales.length,
      cantidadDescartados: descartados.length,
      descartadosPorMotivo,
      pageInfo: grid.pageInfo || null,
      reportingName: grid.reportingName || '',
      queryHash: QUERY_HASH,
      productos: comerciales,
      descartados
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
