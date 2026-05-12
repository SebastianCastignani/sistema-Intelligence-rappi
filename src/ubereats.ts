import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

type DireccionConfig = {
  zona: string;
  direccion: string;
  sugerencia?: string;
};

type ProductoConfig = {
  producto: string;
  buscar_producto: string;
  buscar_producto_ubereats?: string;
};

type TiendaConfig = {
  tipo?: string;
  tienda: string;
  local: string;
  busqueda_tienda: string;
  categoria?: string;
  productos: ProductoConfig[];
};

type UberEatsConfig = {
  direcciones: DireccionConfig[];
  tiendas: TiendaConfig[];
};

type CompetitiveResult = {
  plataforma: 'Uber Eats';
  timestamp: string;
  zona: string;
  direccion: string;
  local: string;
  producto: string;
  descripcion_producto: string;
  precio_producto: number | null;
  precio_producto_original: number | null;
  descuento_producto: string;
  precio_envio: number | null;
  precio_envio_promo: string;
  tiempo_entrega: string;
  rating: number | null;
  horario_apertura: string;
  horario_cierre: string;
  disponible: boolean;
  error: string | null;
};

type UberStoreData = {
  title?: string;
  uuid?: string;
  isOpen?: boolean;
  deliveryTextVisible?: string;
  etaRange?: {
    text?: string;
    accessibilityText?: string;
  };
  rating?: {
    ratingValue?: number;
  };
  fareBadge?: {
    text?: string;
    accessibilityText?: string;
  };
  hours?: Array<{
    sectionHours?: Array<{
      startTime?: number;
      endTime?: number;
    }>;
  }>;
  catalogSectionsMap?: unknown;
};

type UberProduct = {
  uuid?: string;
  title?: string;
  itemDescription?: string;
  price?: number;
  priceTagline?: {
    text?: string;
    accessibilityText?: string;
  };
  labelPrimary?: {
    accessibilityText?: string;
  };
  promoInfo?: {
    promoBadge?: {
      accessibilityText?: string;
      content?: unknown;
    };
  };
  itemLevelPromotion?: unknown;
  isSoldOut?: boolean;
  isAvailable?: boolean;
};

const UNKNOWN = 'unknown';

const ROOT = process.cwd();
const TARGETS_PATH = path.join(ROOT, 'targets', 'rappi-targets.json');

const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'ubereats-results.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'ubereats-results.csv');

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const config = await loadConfig();

  const maxDirecciones = process.env.MAX_DIRECCIONES
    ? Number(process.env.MAX_DIRECCIONES)
    : config.direcciones.length;

  const direcciones = config.direcciones.slice(0, maxDirecciones);

  const total = direcciones.reduce((acc) => {
    return acc + config.tiendas.reduce((sum, tienda) => sum + tienda.productos.length, 0);
  }, 0);

  const results: CompetitiveResult[] = [];
  let counter = 1;

  for (const [direccionIndex, direccion] of direcciones.entries()) {
    console.log(`\n=== Dirección ${direccionIndex + 1}/${direcciones.length}: ${direccion.zona} | ${direccion.direccion} ===`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({
        headless: process.env.HEADLESS !== 'false',
        slowMo: process.env.HEADLESS === 'false' ? 80 : 0,
      });

      context = await createContext(browser);
      const page = await context.newPage();

      await withTimeout(
        (async () => {
          await openUberEats(page);
          await setAddress(page, direccion);
        })(),
        65_000,
        `Timeout cargando dirección: ${direccion.zona}`
      );

      for (const tienda of config.tiendas) {
        console.log(`\nAbriendo tienda: ${tienda.tienda}`);

        const storeData = await openStoreAndCaptureApi(page, tienda);

        for (const producto of tienda.productos) {
          console.log(`[${counter}/${total}] Uber Eats | ${direccion.zona} | ${tienda.tienda} | ${producto.producto}`);

          const result = storeData
            ? buildResultFromStore(direccion, tienda, producto, storeData)
            : emptyResult(direccion, tienda, producto, `No pude capturar getStoreV1 para ${tienda.tienda}`);

          results.push(result);
          console.log(JSON.stringify(result, null, 2));
          counter++;
        }

        await saveOutputs(results);
        await wait(1000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.log(`Error en dirección ${direccion.zona}: ${message}`);

      for (const tienda of config.tiendas) {
        for (const producto of tienda.productos) {
          const result = emptyResult(direccion, tienda, producto, `Error cargando dirección: ${message}`);

          results.push(result);
          console.log(`[${counter}/${total}] ERROR | ${direccion.zona} | ${tienda.tienda} | ${producto.producto}`);
          console.log(JSON.stringify(result, null, 2));
          counter++;
        }
      }

      await saveOutputs(results);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      console.log(`Cerrado navegador para: ${direccion.zona}`);
      await wait(1000);
    }
  }

  await saveOutputs(results);

  console.log(`\nListo.`);
  console.log(`JSON: ${OUTPUT_JSON}`);
  console.log(`CSV: ${OUTPUT_CSV}`);
}

async function loadConfig(): Promise<UberEatsConfig> {
  const raw = await fs.readFile(TARGETS_PATH, 'utf-8');
  const config = JSON.parse(raw);

  if (!Array.isArray(config.direcciones)) {
    throw new Error('targets/rappi-targets.json debe tener "direcciones" como array');
  }

  if (!Array.isArray(config.tiendas)) {
    throw new Error('targets/rappi-targets.json debe tener "tiendas" como array');
  }

  return {
    direcciones: config.direcciones,
    tiendas: config.tiendas,
  };
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    viewport: { width: 1440, height: 950 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
}

async function openUberEats(page: Page) {
  await page.goto('https://www.ubereats.com/mx?next=%2Fmx%2Fsearch', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  await wait(1800);

  await clickIfVisible(page.getByRole('button', { name: /Aceptar|Accept/i }).first(), 2500);
}

async function setAddress(page: Page, direccion: DireccionConfig) {
  const addressBox = page.getByRole('combobox', {
    name: /Ingresa la dirección|Ingresa la direccion|dirección de entrega|direccion de entrega/i,
  }).first();

  await addressBox.waitFor({ state: 'visible', timeout: 25_000 });
  await addressBox.click();
  await addressBox.fill(direccion.direccion);

  await wait(1400);

  await addressBox.press('Enter').catch(() => {});
  await wait(1800);

  const confirmButtons = [
    page.getByRole('button', { name: /Entregar aquí|Entregar aqui|Confirmar|Guardar|Continuar|Listo/i }).first(),
    page.locator('button').filter({ hasText: /Entregar aquí|Entregar aqui|Confirmar|Guardar|Continuar|Listo/i }).first(),
  ];

  for (const button of confirmButtons) {
    await clickIfVisible(button, 2500);
    await wait(800);
  }

  await page.getByTestId('search-input').waitFor({ state: 'visible', timeout: 35_000 });
}

async function openStoreAndCaptureApi(page: Page, tienda: TiendaConfig): Promise<UberStoreData | null> {
  try {
    await page.goto('https://www.ubereats.com/mx/search', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    }).catch(() => {});

    await wait(1200);
    await searchStore(page, tienda);

    const responsePromises: Array<Promise<UberStoreData | null>> = [];

    const handler = (response: Response) => {
      if (
        response.url().includes('/_p/api/getStoreV1') &&
        response.request().method() === 'POST' &&
        response.status() === 200
      ) {
        responsePromises.push(
          response
            .json()
            .then(payload => payload?.data as UberStoreData)
            .catch(() => null)
        );
      }
    };

    page.on('response', handler);

    const storeLink = await findStoreLink(page, tienda);

    if (!storeLink) {
      page.off('response', handler);
      throw new Error(`No encontré link de tienda para ${tienda.tienda}`);
    }

    await storeLink.click({ timeout: 10_000 });

    await wait(6500);

    const deliveryTextVisible = await extractVisibleDeliveryText(page);

    if (deliveryTextVisible) {
      console.log(`Texto envío visible: ${deliveryTextVisible}`);
    } else {
      console.log('Texto envío visible: no detectado');
    }

    page.off('response', handler);

    const settled = await Promise.allSettled(responsePromises);

    const responses = settled
      .filter((item): item is PromiseFulfilledResult<UberStoreData | null> => item.status === 'fulfilled')
      .map(item => item.value)
      .filter((item): item is UberStoreData => Boolean(item));

    const matching = responses.find(response => isMatchingStore(response, tienda));

    if (matching) {
      return {
        ...matching,
        deliveryTextVisible,
      };
    }

    if (responses.length > 0) {
      const names = responses.map(response => response.title).filter(Boolean).join(' | ');
      console.log(`Capturé getStoreV1, pero ninguno matcheó exactamente ${tienda.tienda}. Respuestas: ${names}`);

      return {
        ...responses[responses.length - 1],
        deliveryTextVisible,
      };
    }

    throw new Error(`No se capturó getStoreV1 para ${tienda.tienda}`);
  } catch (error) {
    console.log(`No pude abrir/capturar ${tienda.tienda}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function searchStore(page: Page, tienda: TiendaConfig) {
  const searchInput = page.getByTestId('search-input').first();

  await searchInput.waitFor({ state: 'visible', timeout: 30_000 });
  await searchInput.click();
  await searchInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await searchInput.fill(tienda.busqueda_tienda);
  await searchInput.press('Enter');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(3200);
}

async function findStoreLink(page: Page, tienda: TiendaConfig): Promise<Locator | null> {
  const regex = new RegExp(escapeRegexFlexible(tienda.local), 'i');

  for (let scroll = 0; scroll < 5; scroll++) {
    const links = page.getByRole('link').filter({ hasText: regex });
    const count = Math.min(await links.count().catch(() => 0), 30);

    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const text = normalizeText(await link.innerText({ timeout: 500 }).catch(() => ''));

      if (text.length >= 2 && regex.test(text)) {
        return link;
      }
    }

    await page.mouse.wheel(0, 800).catch(() => {});
    await wait(700);
  }

  return null;
}

async function extractVisibleDeliveryText(page: Page): Promise<string> {
  const bodyText = normalizeText(
    await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
  );

  const patterns = [
    /Costo de env[ií]o\s*:\s*MXN\s*0\s*\([^)]*\)/i,
    /Costo de env[ií]o\s*:\s*MXN\s*[\d,.]+/i,
    /Costo de env[ií]o\s*:\s*MX\s*\$?\s*[\d,.]+/i,
    /Costo de env[ií]o\s*:\s*\$\s*[\d,.]+/i,
    /Costo de env[ií]o\s*:\s*Gratis/i,
    /Env[ií]o gratis[^.]{0,120}/i,
    /MXN\s*0\s*\([^)]*usuarios nuevos[^)]*\)/i,
    /Costo de env[ií]o\s*:\s*\$?\s*0/i,
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);

    if (match?.[0]) {
      const cleaned = cleanDeliveryText(match[0]);

      if (isValidDeliveryText(cleaned)) {
        return cleaned;
      }
    }
  }

  const index = bodyText.search(/costo de env[ií]o/i);

  if (index >= 0) {
    const fallback = cleanDeliveryText(bodyText.slice(index, index + 140));

    if (isValidDeliveryText(fallback)) {
      return fallback;
    }
  }

  return '';
}

function isMatchingStore(store: UberStoreData, tienda: TiendaConfig): boolean {
  const haystack = normalizedKey(store.title ?? '');
  const local = normalizedKey(tienda.local);
  const tiendaName = normalizedKey(tienda.tienda);

  return haystack.includes(local) || haystack.includes(tiendaName);
}

function buildResultFromStore(
  direccion: DireccionConfig,
  tienda: TiendaConfig,
  productoConfig: ProductoConfig,
  store: UberStoreData
): CompetitiveResult {
  const products = collectProducts(store);
  const product = findProduct(products, productoConfig);

  if (!product) {
    const examples = products
      .map(item => item.title)
      .filter(Boolean)
      .slice(0, 10)
      .join(' | ');

    return emptyResult(
      direccion,
      tienda,
      productoConfig,
      `Producto no encontrado en getStoreV1: ${getSearchText(productoConfig)}. Local capturado: ${store.title ?? UNKNOWN}. Ejemplos: ${examples}`
    );
  }

  const priceInfo = extractUberPrice(product);
  const discount = extractDiscount(product);
  const hours = extractHours(store);

  return {
    plataforma: 'Uber Eats',
    timestamp: new Date().toISOString(),
    zona: direccion.zona,
    direccion: direccion.direccion,
    local: store.title ?? tienda.tienda,
    producto: productoConfig.producto,
    descripcion_producto: product.itemDescription ?? product.title ?? UNKNOWN,
    precio_producto: priceInfo.price,
    precio_producto_original: priceInfo.originalPrice,
    descuento_producto: discount,
    precio_envio: extractDeliveryFee(store),
    precio_envio_promo: extractDeliveryPromo(store),
    tiempo_entrega: normalizeText(store.etaRange?.text ?? store.etaRange?.accessibilityText ?? UNKNOWN),
    rating: store.rating?.ratingValue ?? null,
    horario_apertura: hours.open,
    horario_cierre: hours.close,
    disponible: Boolean(store.isOpen !== false && product.isAvailable !== false && product.isSoldOut !== true),
    error: null,
  };
}

function collectProducts(store: UberStoreData): UberProduct[] {
  const products: UberProduct[] = [];

  const visit = (value: unknown) => {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;

    const looksLikeProduct =
      typeof obj.title === 'string' &&
      (
        typeof obj.price === 'number' ||
        typeof (obj.priceTagline as Record<string, unknown> | undefined)?.text === 'string'
      ) &&
      typeof obj.uuid === 'string';

    if (looksLikeProduct) {
      products.push(obj as UberProduct);
    }

    for (const child of Object.values(obj)) {
      visit(child);
    }
  };

  visit(store.catalogSectionsMap);

  const seen = new Set<string>();

  return products.filter(product => {
    const key = `${product.uuid}|${normalizedKey(product.title ?? '')}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function findProduct(products: UberProduct[], productoConfig: ProductoConfig): UberProduct | null {
  const searchText = getSearchText(productoConfig);
  const wantedTokens = tokenize(searchText);
  const outputTokens = tokenize(productoConfig.producto);
  const hasSpecificSize = wantedTokens.some(token => /\d/.test(token));

  const exactTitle = products.find(product => normalizedKey(product.title ?? '') === normalizedKey(searchText));
  if (exactTitle) return exactTitle;

  const titleIncludes = products.find(product => normalizedKey(product.title ?? '').includes(normalizedKey(searchText)));
  if (titleIncludes) return titleIncludes;

  const byTokensTitle = products.find(product => {
    const haystack = normalizedKey(product.title ?? '');
    return wantedTokens.every(token => haystack.includes(normalizedKey(token)));
  });

  if (byTokensTitle) return byTokensTitle;

  const byTokensAll = products.find(product => {
    const haystack = normalizedKey(`${product.title ?? ''} ${product.itemDescription ?? ''}`);
    return wantedTokens.every(token => haystack.includes(normalizedKey(token)));
  });

  if (byTokensAll) return byTokensAll;

  if (hasSpecificSize) {
    return null;
  }

  const outputExact = products.find(product => normalizedKey(product.title ?? '') === normalizedKey(productoConfig.producto));
  if (outputExact) return outputExact;

  return products.find(product => {
    const haystack = normalizedKey(`${product.title ?? ''} ${product.itemDescription ?? ''}`);
    return outputTokens.every(token => haystack.includes(normalizedKey(token)));
  }) ?? null;
}

function getSearchText(productoConfig: ProductoConfig): string {
  return productoConfig.buscar_producto_ubereats ?? productoConfig.buscar_producto;
}

function extractUberPrice(product: UberProduct): { price: number | null; originalPrice: number | null } {
  const visiblePrice = parseFirstMoney(product.priceTagline?.text);
  const originalFromAccessibility = parseOriginalMoney(product.priceTagline?.accessibilityText);
  const originalFromLabel = parseOriginalMoney(product.labelPrimary?.accessibilityText);

  const fallbackPrice = normalizeUberPrice(product.price);

  const price = visiblePrice ?? fallbackPrice;
  const originalPrice = originalFromAccessibility ?? originalFromLabel;

  return {
    price,
    originalPrice: originalPrice && price && originalPrice > price ? originalPrice : null,
  };
}

function extractDiscount(product: UberProduct): string {
  const badge =
    product.promoInfo?.promoBadge?.accessibilityText ??
    extractTextDeep(product.promoInfo?.promoBadge?.content) ??
    extractTextDeep(product.itemLevelPromotion);

  const badgeText = normalizeText(badge ?? '');
  const match = badgeText.match(/-\s*\d+\s*%|\d+\s*%/);

  if (match) {
    return match[0].replace(/\s+/g, '');
  }

  const priceInfo = extractUberPrice(product);

  if (priceInfo.price && priceInfo.originalPrice && priceInfo.originalPrice > priceInfo.price) {
    return `-${Math.round((1 - priceInfo.price / priceInfo.originalPrice) * 100)}%`;
  }

  return UNKNOWN;
}

function extractDeliveryFee(store: UberStoreData): number | null {
  const visibleText = cleanDeliveryText(store.deliveryTextVisible ?? '');

  if (isValidDeliveryText(visibleText)) {
    if (/gratis|free|mxn\s*0|mx\$?\s*0|\$\s*0/i.test(visibleText)) {
      return 0;
    }

    const fromVisibleText = parseMoneyAny(visibleText);

    if (fromVisibleText !== null) {
      return fromVisibleText;
    }
  }

  const deliveryText = findDeliveryText(store);

  if (isValidDeliveryText(deliveryText)) {
    if (/gratis|free|mxn\s*0|mx\$?\s*0|\$\s*0/i.test(deliveryText)) {
      return 0;
    }

    const fromDeliveryText = parseMoneyAny(deliveryText);

    if (fromDeliveryText !== null) {
      return fromDeliveryText;
    }
  }

  const fareText = cleanDeliveryText(`${store.fareBadge?.text ?? ''} ${store.fareBadge?.accessibilityText ?? ''}`);

  if (isValidDeliveryText(fareText)) {
    if (/gratis|free|mxn\s*0|mx\$?\s*0|\$\s*0/i.test(fareText)) {
      return 0;
    }

    const feeFromFare = parseMoneyAny(fareText);

    if (feeFromFare !== null) {
      return feeFromFare;
    }
  }

  return null;
}

function extractDeliveryPromo(store: UberStoreData): string {
  const visibleText = cleanDeliveryText(store.deliveryTextVisible ?? '');

  if (isValidDeliveryText(visibleText)) {
    return visibleText;
  }

  const deliveryText = findDeliveryText(store);

  if (isValidDeliveryText(deliveryText)) {
    return deliveryText;
  }

  const fareText = cleanDeliveryText(`${store.fareBadge?.text ?? ''} ${store.fareBadge?.accessibilityText ?? ''}`);

  if (isValidDeliveryText(fareText)) {
    return fareText;
  }

  return UNKNOWN;
}

function extractHours(store: UberStoreData): { open: string; close: string } {
  const first = store.hours?.[0]?.sectionHours?.[0];

  if (!first || first.startTime === undefined || first.endTime === undefined) {
    return { open: UNKNOWN, close: UNKNOWN };
  }

  return {
    open: minutesToTime(first.startTime),
    close: minutesToTime(first.endTime),
  };
}

function minutesToTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hh = Math.floor(normalized / 60);
  const mm = normalized % 60;

  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function parseFirstMoney(value: string | undefined): number | null {
  if (!value) return null;

  const match = normalizeText(value).match(/\$\s*([\d,.]+)/);

  if (!match?.[1]) return null;

  return normalizePrice(match[1]);
}

function parseOriginalMoney(value: string | undefined): number | null {
  if (!value) return null;

  const matches = [...normalizeText(value).matchAll(/\$\s*([\d,.]+)/g)]
    .map(match => normalizePrice(match[1]))
    .filter((n): n is number => n !== null);

  return matches.length >= 2 ? matches[1] : null;
}

function normalizeUberPrice(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;

  if (value >= 1000) return value / 100;

  return value;
}

function normalizePrice(value: string): number | null {
  const parsed = Number(value.replace(/[^\d.,]/g, '').replace(/,/g, ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function parseMoneyAny(value: string): number | null {
  const text = normalizeText(value);

  const match = text.match(/(?:MXN|MX\$|\$)\s*([\d,.]+)/i);

  if (match?.[1]) {
    return normalizePrice(match[1]);
  }

  if (/costo de env[ií]o|delivery fee|env[ií]o/i.test(text) && /\b0\b/.test(text)) {
    return 0;
  }

  return null;
}

function cleanDeliveryText(value: string): string {
  const text = normalizeText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';

  if (!isValidDeliveryText(text)) return '';

  const match = text.match(/Costo de env[ií]o\s*:\s*(?:MXN|MX\$|\$)?\s*[\d,.]+(?:\s*\([^)]*\))?/i);

  if (match?.[0]) {
    return normalizeText(match[0]);
  }

  const freeMatch = text.match(/Env[ií]o gratis[^.]{0,120}/i);

  if (freeMatch?.[0]) {
    return normalizeText(freeMatch[0]);
  }

  return text;
}

function isValidDeliveryText(value: string): boolean {
  const text = normalizeText(value);

  if (!text) return false;

  const looksLikeFaq =
    /cómo puedo obtener entregas/i.test(text) ||
    /como puedo obtener entregas/i.test(text) ||
    /sin costo de env[ií]o en mis pedidos/i.test(text) ||
    /preguntas frecuentes/i.test(text) ||
    /<\/?h\d/i.test(text);

  if (looksLikeFaq) return false;

  const looksLikeDeliveryValue =
    /costo de env[ií]o\s*:/i.test(text) ||
    /env[ií]o gratis/i.test(text) ||
    /delivery fee/i.test(text) ||
    /mxn\s*0/i.test(text) ||
    /mx\$?\s*0/i.test(text) ||
    /\$\s*0/i.test(text);

  return looksLikeDeliveryValue;
}

function findDeliveryText(value: unknown): string {
  const candidates: string[] = [];

  const visit = (item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      const text = cleanDeliveryText(item);

      if (isValidDeliveryText(text)) {
        candidates.push(text);
      }

      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    if (typeof item !== 'object') return;

    for (const child of Object.values(item as Record<string, unknown>)) {
      visit(child);
    }
  };

  visit(value);

  const best =
    candidates.find(text => /costo de env[ií]o/i.test(text)) ??
    candidates.find(text => /usuarios nuevos/i.test(text)) ??
    candidates.find(text => /mxn\s*0|mx\$?\s*0|\$\s*0/i.test(text)) ??
    candidates.find(text => /env[ií]o|envio/i.test(text));

  return cleanDeliveryText(best ?? '');
}

function extractTextDeep(value: unknown): string | null {
  const texts: string[] = [];

  const visit = (item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      texts.push(item);
      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    if (typeof item !== 'object') return;

    for (const child of Object.values(item as Record<string, unknown>)) {
      visit(child);
    }
  };

  visit(value);

  const joined = normalizeText(texts.join(' '));

  return joined || null;
}

function emptyResult(
  direccion: DireccionConfig,
  tienda: TiendaConfig,
  producto: ProductoConfig,
  error: string | null
): CompetitiveResult {
  return {
    plataforma: 'Uber Eats',
    timestamp: new Date().toISOString(),
    zona: direccion.zona,
    direccion: direccion.direccion,
    local: UNKNOWN,
    producto: producto.producto,
    descripcion_producto: UNKNOWN,
    precio_producto: null,
    precio_producto_original: null,
    descuento_producto: UNKNOWN,
    precio_envio: null,
    precio_envio_promo: UNKNOWN,
    tiempo_entrega: UNKNOWN,
    rating: null,
    horario_apertura: UNKNOWN,
    horario_cierre: UNKNOWN,
    disponible: false,
    error,
  };
}

async function saveOutputs(results: CompetitiveResult[]) {
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(results, null, 2), 'utf-8');
  await fs.writeFile(OUTPUT_CSV, toCsv(results), 'utf-8');
}

function toCsv(rows: CompetitiveResult[]): string {
  const headers = [
    'plataforma',
    'timestamp',
    'zona',
    'direccion',
    'local',
    'producto',
    'descripcion_producto',
    'precio_producto',
    'precio_producto_original',
    'descuento_producto',
    'precio_envio',
    'precio_envio_promo',
    'tiempo_entrega',
    'rating',
    'horario_apertura',
    'horario_cierre',
    'disponible',
    'error',
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map(header => csvValue((row as any)[header])).join(','));
  }

  return lines.join('\n');
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

async function clickIfVisible(locator: Locator, timeout = 2000): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedKey(value: string): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegexFlexible(value: string): string {
  return escapeRegex(value.trim())
    .replace(/\\\s+/g, '\\s*')
    .replace(/\s+/g, '\\s*');
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});