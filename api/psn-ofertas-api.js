// api/psn-ofertas-api.js
// AREA 51 - Extractor independiente de PlayStation Store.
// Proyecto exclusivo: ofertaspsnDGA.
// LEY DEL PROYECTO: se conserva la consulta que ya funciona y solo se agrega
// soporte para recibir un link de categoría de PlayStation Store de forma dinámica.

const PSN_GRAPHQL = 'https://web.np.playstation.com/api/graphql/v1//op';

// -----------------------------------------------------------------------------
// RESPALDO ACTUAL - SE CONSERVA SIN CAMBIOS
// Si el HTML no manda ningún link, se usa exactamente esta configuración.
// -----------------------------------------------------------------------------
const DEFAULT_CATEGORY_ID = '3f772501-f6f8-49b7-abac-874a88ca4897';
const DEFAULT_REGION = 'es-ar';
const DEFAULT_LOCALE = 'es-AR';
const DEFAULT_SORT_NAME = 'productName';
const DEFAULT_SORT_ASCENDING = true;

const DEFAULT_FILTERS = [
  'storeDisplayClassification:FULL_GAME',
  'storeDisplayClassification:GAME_BUNDLE',
  'storeDisplayClassification:PREMIUM_EDITION',
  'storeDisplayClassification:OTHER'
];

const QUERY_HASH =
  '88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03';

// -----------------------------------------------------------------------------
// CAPA COMERCIAL - SE CONSERVA
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

function localeFromRegion(region) {
  const parts = asText(region).toLowerCase().split('-');

  if (parts.length !== 2 || parts[0].length !== 2 || parts[1].length !== 2) {
    return DEFAULT_LOCALE;
  }

  return `${parts[0]}-${parts[1].toUpperCase()}`;
}

function parseStoreUrl(storeUrl) {
  const raw = asText(storeUrl).trim();

  // Campo vacío = comportamiento anterior exacto.
  if (!raw) {
    return {
      sourceMode: 'default',
      originalUrl: '',
      region: DEFAULT_REGION,
      locale: DEFAULT_LOCALE,
      categoryId: DEFAULT_CATEGORY_ID,
      filters: [...DEFAULT_FILTERS],
      sortName: DEFAULT_SORT_NAME,
      sortAscending: DEFAULT_SORT_ASCENDING
    };
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error('El link de PlayStation Store no es válido.');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'store.playstation.com') {
    throw new Error('El enlace ingresado no pertenece a PlayStation Store.');
  }

  const match = url.pathname.match(
    /^\/([a-z]{2}-[a-z]{2})\/category\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/\d+)?\/?$/i
  );

  if (!match) {
    throw new Error(
      'El enlace de PlayStation no contiene una categoría compatible con este extractor.'
    );
  }

  const region = match[1].toLowerCase();
  const categoryId = match[2].toLowerCase();

  // Los filtros se toman ÚNICAMENTE si el link realmente los trae.
  // Ejemplo: ?FULL_GAME=storeDisplayClassification
  const filters = [];

  for (const [key, value] of url.searchParams.entries()) {
    if (value === 'storeDisplayClassification') {
      filters.push(`storeDisplayClassification:${key}`);
    }
  }

  const sortName = asText(url.searchParams.get('sortBy')).trim() || DEFAULT_SORT_NAME;
  const sortOrder = normalizeText(url.searchParams.get('sortOrder'));
  const sortAscending = sortOrder ? sortOrder !== 'desc' : DEFAULT_SORT_ASCENDING;

  return {
    sourceMode: 'dynamic',
    originalUrl: url.toString(),
    region,
    locale: localeFromRegion(region),
    categoryId,
    filters,
    sortName,
    sortAscending
  };
}

function buildVariables(page, size, source) {
  return {
    id: source.categoryId,
    pageArgs: {
      size,
      offset: (page - 1) * size
    },
    sortBy: {
      name: source.sortName,
      isAscending: source.sortAscending
    },
    filterBy: source.filters,
    facetOptions: []
  };
}

function normalizeProduct(product, page, source) {
  const price = product?.price || {};
  const id = asText(product?.id).trim();
  const storePrefix = `https://store.playstation.com/${source.region}/product/`;

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
    urlDirecta: id ? storePrefix + encodeURIComponent(id) : ''
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

async function requestPage(page, size, source) {
  const variables = buildVariables(page, size, source);

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
      'Accept-Language': `${source.locale},es;q=0.9,en;q=0.8`,
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Origin': 'https://store.playstation.com',
      'Referer': source.originalUrl || `https://store.playstation.com/${source.region}/`,
      'x-psn-store-locale': source.locale,
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

  const parsedPage = Number.parseInt(req.query.page || '1', 10);
  const page = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);

  const size = Math.max(
    1,
    Math.min(24, Number.parseInt(req.query.size || '24', 10))
  );

  try {
    const source = parseStoreUrl(req.query.storeUrl || '');
    const grid = await requestPage(page, size, source);
    const products = Array.isArray(grid.products) ? grid.products : [];
    const normalizedRows = products.map((p) => normalizeProduct(p, page, source));

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
      totalPaginasDetectadas: Number.isFinite(Number(grid?.pageInfo?.totalCount))
        ? Math.max(1, Math.ceil(Number(grid.pageInfo.totalCount) / size))
        : null,
      reportingName: grid.reportingName || '',
      queryHash: QUERY_HASH,
      fuente: {
        modo: source.sourceMode,
        url: source.originalUrl,
        region: source.region,
        locale: source.locale,
        categoryId: source.categoryId,
        filtros: source.filters,
        sortBy: source.sortName,
        sortOrder: source.sortAscending ? 'asc' : 'desc'
      },
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
