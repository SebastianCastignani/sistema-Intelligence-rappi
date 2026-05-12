
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
};

type TiendaConfig = {
  tipo: 'restaurant' | 'retail';
  tienda: string;
  local: string;
  busqueda_tienda: string;
  categoria?: string;
  productos: ProductoConfig[];
};

type RappiConfig = {
  direcciones: DireccionConfig[];
  tiendas: TiendaConfig[];
};

type RappiResult = {
  plataforma: 'Rappi';
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

type StoreApiProduct = {
  name?: string;
  description?: string;
  real_price?: number;
  price?: number;
  balance_price?: number;
  real_balance_price?: number;
  discounts?: Array<{
    type?: string;
    value?: number;
    price?: number;
    apply_to_user?: boolean;
  }> | {
    discount?: number;
    type?: string;
  };
  discount_percentage?: number;
  discount?: number;
  have_discount?: boolean;
  schedules?: Array<{
    open_time?: string;
    close_time?: string;
    day?: string;
  }>;
  in_schedule?: boolean;
  is_available?: boolean;
  available?: boolean;
  in_stock?: boolean;
  stock?: number;
  presentation?: string;
  trademark?: string;
  category_name?: string;
  pum?: string;
};

type RestaurantApiData = {
  store_id?: number;
  brand_name?: string;
  name?: string;
  address?: string;
  eta?: string;
  delivery_price?: number;
  is_currently_available?: boolean;
  has_coverage?: boolean;
  rating?: {
    score?: number;
    total_reviews?: number;
  };
  schedules?: Array<{
    open_time?: string;
    close_time?: string;
    day?: string;
  }>;
  discount_tags?: Array<{
    type?: string;
    tag?: string;
    title?: string;
    message?: string;
    value?: number;
  }>;
  corridors?: Array<{
    name?: string;
    products?: StoreApiProduct[];
  }>;
};

type RetailApiBundle = {
  responses: unknown[];
  storeInfo: StoreInfo;
};

type StoreInfo = {
  local: string;
  tiempo_entrega: string;
  precio_envio: number | null;
  precio_envio_promo: string;
  rating: number | null;
};

const UNKNOWN = 'unknown';
const ROOT = process.cwd();
const TARGETS_PATH = path.join(ROOT, 'targets', 'rappi-targets.json');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'rappi-results.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'rappi-results.csv');

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

  const results: RappiResult[] = [];
  let counter = 1;

  for (const [direccionIndex, direccion] of direcciones.entries()) {
    console.log(`\n=== Dirección ${direccionIndex + 1}/${direcciones.length}: ${direccion.zona} | ${direccion.direccion} ===`);

    // Navegador nuevo por dirección.
    // Esto es más estable con Rappi que reutilizar una misma sesión para muchas ubicaciones.
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
          await openRappi(page);
          await setAddress(page, direccion);
        })(),
        45_000,
        `Timeout cargando dirección: ${direccion.zona}`
      );

      for (const tienda of config.tiendas) {
        console.log(`\nAbriendo tienda: ${tienda.tienda}`);

        if (tienda.tipo === 'restaurant') {
          const storeData = await openRestaurantAndCaptureApi(page, tienda);

          for (const producto of tienda.productos) {
            console.log(`[${counter}/${total}] Rappi | ${direccion.zona} | ${tienda.tienda} | ${producto.producto}`);

            const result = storeData
              ? buildResultFromRestaurantApi(direccion, tienda, producto, storeData)
              : emptyResult(direccion, tienda, producto, `No pude capturar endpoint restaurant-bus para ${tienda.tienda}`);

            results.push(result);
            console.log(JSON.stringify(result, null, 2));
            counter++;
          }
        } else {
          const retailData = await openRetailAndCaptureApi(page, tienda);

          for (const producto of tienda.productos) {
            console.log(`[${counter}/${total}] Rappi | ${direccion.zona} | ${tienda.tienda} | ${producto.producto}`);

            const result = retailData
              ? buildResultFromRetailApi(direccion, tienda, producto, retailData)
              : emptyResult(direccion, tienda, producto, `No pude capturar endpoint dynamic context para ${tienda.tienda}`);

            results.push(result);
            console.log(JSON.stringify(result, null, 2));
            counter++;
          }
        }

        await saveOutputs(results);
        await wait(800);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.log(`Error en dirección ${direccion.zona}: ${message}`);

      // Si falla una dirección, igual dejamos sus 3 registros vacíos y seguimos.
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
      await wait(1200);
    }
  }

  await saveOutputs(results);

  console.log(`\nListo.`);
  console.log(`JSON: ${OUTPUT_JSON}`);
  console.log(`CSV: ${OUTPUT_CSV}`);
}

async function saveOutputs(results: RappiResult[]) {
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(results, null, 2), 'utf-8');
  await fs.writeFile(OUTPUT_CSV, toCsv(results), 'utf-8');
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

async function loadConfig(): Promise<RappiConfig> {
  const raw = await fs.readFile(TARGETS_PATH, 'utf-8');
  const config = JSON.parse(raw);

  if (!Array.isArray(config.direcciones)) {
    throw new Error('targets/rappi-targets.json debe tener "direcciones" como array');
  }

  if (!Array.isArray(config.tiendas)) {
    throw new Error('targets/rappi-targets.json debe tener "tiendas" como array');
  }

  return config;
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

async function openRappi(page: Page) {
  await page.goto('https://www.rappi.com.mx/search', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  await wait(1400);

  await clickIfVisible(page.getByRole('button', { name: /aceptar|entendido|continuar/i }).first(), 1000);
  await clickIfVisible(page.getByRole('button', { name: /no gracias|después|despues/i }).first(), 1000);
}

async function setAddress(page: Page, direccion: DireccionConfig) {
  await page.keyboard.press('Escape').catch(() => {});
  await wait(500);

  await openAddressModal(page);

  const addressInput = page.getByRole('textbox', {
    name: /escribe la dirección|escribe la direccion/i,
  }).first();

  await addressInput.waitFor({ state: 'visible', timeout: 15_000 });
  await addressInput.fill(direccion.direccion);

  await wait(1300);

  const ok = await clickAddressSuggestion(page, direccion);

  if (!ok) {
    throw new Error(`No pude seleccionar sugerencia para dirección: ${direccion.direccion}`);
  }

  await clickIfVisible(page.getByRole('button', { name: /confirmar dirección|confirmar direccion/i }).first(), 8000);
  await clickIfVisible(page.getByRole('button', { name: /guardar dirección|guardar direccion/i }).first(), 8000);

  await wait(1800);
}

async function openAddressModal(page: Page) {
  const inputIsVisible = async () => {
    return await page.getByRole('textbox', {
      name: /escribe la dirección|escribe la direccion/i,
    }).first().isVisible().catch(() => false);
  };

  if (await inputIsVisible()) return;

  await page.keyboard.press('Escape').catch(() => {});
  await wait(300);

  const candidates = [
    page.getByRole('button', {
      name: /ciudad de méxico|ciudad de mexico|avenida|av\.|dirección|direccion|ubicación|ubicacion|agregar|cambiar/i,
    }).first(),
    page.locator('button, [role="button"], a').filter({
      hasText: /ciudad de méxico|ciudad de mexico|avenida|av\.|dirección|direccion|ubicación|ubicacion|agregar|cambiar/i,
    }).first(),
    page.locator('header').getByText(/ciudad de méxico|ciudad de mexico|avenida|av\.|dirección|direccion|ubicación|ubicacion/i).first(),
  ];

  for (const candidate of candidates) {
    if (await clickIfVisible(candidate, 3500)) {
      await wait(900);
      if (await inputIsVisible()) return;
    }
  }

  // Fallback visual: selector de ubicación arriba a la izquierda en desktop.
  await page.mouse.click(250, 55).catch(() => {});
  await wait(1200);

  if (await inputIsVisible()) return;

  throw new Error('No pude abrir el modal de dirección');
}

async function clickAddressSuggestion(page: Page, direccion: DireccionConfig): Promise<boolean> {
  if (direccion.sugerencia) {
    const regex = new RegExp(escapeRegex(direccion.sugerencia), 'i');

    const preferredCandidates = [
      page.getByRole('button').filter({ hasText: regex }).first(),
      page.locator('button, [role="button"], li, div').filter({ hasText: regex }).first(),
      page.getByText(regex).first(),
    ];

    for (const candidate of preferredCandidates) {
      if (await clickIfVisible(candidate, 3500)) {
        await wait(800);
        return true;
      }
    }
  }

  const candidates = page.locator('button, [role="button"], li, div');
  const count = Math.min(await candidates.count().catch(() => 0), 120);

  for (let i = 0; i < count; i++) {
    const item = candidates.nth(i);
    const text = normalizeText(await item.innerText({ timeout: 200 }).catch(() => ''));

    if (
      text.length > 12 &&
      text.length < 220 &&
      !/confirmar|guardar|ciudad|cerrar|continuar|cancelar|buscar|lo más buscados|los más buscados/i.test(text)
    ) {
      await item.click({ timeout: 1500 }).catch(() => {});
      await wait(800);
      return true;
    }
  }

  return false;
}

async function openRestaurantAndCaptureApi(page: Page, tienda: TiendaConfig): Promise<RestaurantApiData | null> {
  try {
    await page.goto('https://www.rappi.com.mx/search', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    await wait(1000);
    await searchStore(page, tienda);

    const storeCard = await findStoreCard(page, tienda);

    if (!storeCard) {
      throw new Error(`No encontré card de tienda para ${tienda.tienda}`);
    }

    let matched: RestaurantApiData | null = null;
    const handler = (response: Response) => {
      if (
        response.url().includes('/api/restaurant-bus/store/brand/id/') &&
        response.request().method() === 'POST' &&
        response.status() === 200
      ) {
        response
          .json()
          .then(data => {
            if (!matched && isRestaurantResponseForStore(data as RestaurantApiData, tienda)) {
              matched = data as RestaurantApiData;
            }
          })
          .catch(() => {});
      }
    };

    page.on('response', handler);

    await clickStoreCard(storeCard);
    await wait(2000);

    if (!matched) {
      await clickStoreCard(storeCard).catch(() => {});
      await wait(1500);
    }

    const deadline = Date.now() + 35_000;
    while (!matched && Date.now() < deadline) {
      await wait(500);
    }

    page.off('response', handler);

    if (matched) {
      await wait(800);
      return matched;
    }

    throw new Error(`Timeout esperando restaurant-bus para ${tienda.tienda}`);
  } catch (error) {
    console.log(`No pude abrir/capturar restaurant ${tienda.tienda}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function openRetailAndCaptureApi(page: Page, tienda: TiendaConfig): Promise<RetailApiBundle | null> {
  try {
    await page.goto('https://www.rappi.com.mx/search', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    await wait(1000);
    await searchStore(page, tienda);

    const storeCard = await findStoreCard(page, tienda);

    if (!storeCard) {
      throw new Error(`No encontré card de tienda para ${tienda.tienda}`);
    }

    const cardText = normalizeText(await storeCard.innerText({ timeout: 1000 }).catch(() => ''));
    const storeInfo = extractStoreInfoFromCard(cardText, tienda);

    const responsePromises: Array<Promise<unknown | null>> = [];

    const handler = (response: Response) => {
      if (
        response.url().includes('/api/web-gateway/web/dynamic/context/content/') &&
        response.request().method() === 'POST' &&
        response.status() === 200
      ) {
        responsePromises.push(
          response
            .json()
            .catch(() => null)
        );
      }
    };

    page.on('response', handler);

    await clickStoreCard(storeCard);
    await wait(2500);

    if (tienda.categoria) {
      await clickCategoryIfVisible(page, tienda.categoria);
      await wait(3000);
    }

    // Scroll leve para disparar paginación/carga de más productos si existe.
    await page.mouse.wheel(0, 900).catch(() => {});
    await wait(1500);

    page.off('response', handler);

    const settled = await Promise.allSettled(responsePromises);
    const responses = settled
      .filter((item): item is PromiseFulfilledResult<unknown | null> => item.status === 'fulfilled')
      .map(item => item.value)
      .filter(Boolean);

    if (responses.length === 0) {
      throw new Error('No se capturó respuesta dynamic context');
    }

    return {
      responses,
      storeInfo,
    };
  } catch (error) {
    console.log(`No pude abrir/capturar retail ${tienda.tienda}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function searchStore(page: Page, tienda: TiendaConfig) {
  const searchBox = page.getByRole('searchbox').first();

  await searchBox.waitFor({ state: 'visible', timeout: 30_000 });
  await searchBox.click();
  await searchBox.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await searchBox.fill(tienda.busqueda_tienda);
  await searchBox.press('Enter');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(2600);
}

async function findStoreCard(page: Page, tienda: TiendaConfig): Promise<Locator | null> {
  const localRegex = new RegExp(escapeRegexFlexible(tienda.local), 'i');
  let fallback: Locator | null = null;

  for (let scroll = 0; scroll < 6; scroll++) {
    const cards = page.locator('[data-testid^="search-result-"], article, li, div').filter({
      hasText: localRegex,
    });

    const count = Math.min(await cards.count().catch(() => 0), 80);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const text = normalizeText(await card.innerText({ timeout: 250 }).catch(() => ''));

      if (
        text.length > 10 &&
        text.length < 3500 &&
        localRegex.test(text)
      ) {
        if (/ir a la tienda|ver tienda|ver local|abrir tienda/i.test(text)) {
          return card;
        }

        if (!fallback) {
          fallback = card;
        }
      }
    }

    await page.mouse.wheel(0, 800);
    await wait(700);
  }

  return fallback;
}

function isRestaurantResponseForStore(store: RestaurantApiData, tienda: TiendaConfig): boolean {
  const candidates = [store.brand_name, store.name].filter(Boolean) as string[];
  const wanted = [tienda.local, tienda.tienda].map(value => normalizedKey(value));

  return candidates.some(candidate => {
    const normalized = normalizedKey(candidate);
    return wanted.some(target => normalized.includes(target) || target.includes(normalized));
  });
}

async function clickStoreCard(storeCard: Locator) {
  const openLink = storeCard.getByRole('link', { name: /ir a la tienda/i }).first();

  if ((await openLink.count()) > 0) {
    await openLink.click();
  } else {
    await storeCard.click();
  }
}

async function clickCategoryIfVisible(page: Page, category: string): Promise<boolean> {
  const regex = new RegExp(`^\\s*${escapeRegex(category)}\\s*$`, 'i');

  const candidates = [
    page.getByRole('link', { name: regex }).first(),
    page.getByRole('button', { name: regex }).first(),
    page.locator('a, button, [role="button"], div').filter({ hasText: regex }).first(),
  ];

  for (const candidate of candidates) {
    if (await clickIfVisible(candidate, 4000)) {
      return true;
    }
  }

  return false;
}

function buildResultFromRestaurantApi(
  direccion: DireccionConfig,
  tienda: TiendaConfig,
  productoConfig: ProductoConfig,
  store: RestaurantApiData
): RappiResult {
  const product = findProduct(flattenRestaurantProducts(store), productoConfig);

  if (!product) {
    return emptyResult(
      direccion,
      tienda,
      productoConfig,
      `Producto no encontrado en restaurant endpoint: ${productoConfig.buscar_producto}`
    );
  }

  const discountedPrice = getRestaurantDiscountedPrice(product);
  const originalPrice = getOriginalPrice(product);
  const hasDiscount = discountedPrice !== null && originalPrice !== null && discountedPrice < originalPrice;

  const schedule = product.schedules?.[0] ?? store.schedules?.[0];
  const freeShipping = getFreeShippingTag(store);
  const productDiscount = getRestaurantDiscountText(product);

  return {
    plataforma: 'Rappi',
    timestamp: new Date().toISOString(),
    zona: direccion.zona,
    direccion: direccion.direccion,
    local: store.name ?? tienda.tienda,
    producto: productoConfig.producto,
    descripcion_producto: product.description ?? product.name ?? UNKNOWN,
    precio_producto: discountedPrice ?? product.price ?? product.real_price ?? null,
    precio_producto_original: hasDiscount ? originalPrice : null,
    descuento_producto: productDiscount,
    precio_envio: freeShipping ? 0 : store.delivery_price ?? null,
    precio_envio_promo: freeShipping ?? UNKNOWN,
    tiempo_entrega: store.eta ?? UNKNOWN,
    rating: store.rating?.score ?? null,
    horario_apertura: schedule?.open_time ?? UNKNOWN,
    horario_cierre: schedule?.close_time ?? UNKNOWN,
    disponible: Boolean(store.has_coverage !== false && store.is_currently_available !== false && product.in_schedule !== false),
    error: null,
  };
}

function buildResultFromRetailApi(
  direccion: DireccionConfig,
  tienda: TiendaConfig,
  productoConfig: ProductoConfig,
  retail: RetailApiBundle
): RappiResult {
  const products = flattenRetailProducts(retail.responses);
  const product = findProduct(products, productoConfig);

  if (!product) {
    return emptyResult(
      direccion,
      tienda,
      productoConfig,
      `Producto no encontrado en retail endpoint: ${productoConfig.buscar_producto}`
    );
  }

  const price = product.price ?? product.balance_price ?? null;
  const original = product.real_price ?? product.real_balance_price ?? null;
  const hasDiscount = price !== null && original !== null && price < original;

  return {
    plataforma: 'Rappi',
    timestamp: new Date().toISOString(),
    zona: direccion.zona,
    direccion: direccion.direccion,
    local: retail.storeInfo.local,
    producto: productoConfig.producto,
    descripcion_producto: product.description ?? product.name ?? UNKNOWN,
    precio_producto: price,
    precio_producto_original: hasDiscount ? original : null,
    descuento_producto: getRetailDiscountText(product),
    precio_envio: retail.storeInfo.precio_envio,
    precio_envio_promo: retail.storeInfo.precio_envio_promo,
    tiempo_entrega: retail.storeInfo.tiempo_entrega,
    rating: retail.storeInfo.rating,
    horario_apertura: UNKNOWN,
    horario_cierre: UNKNOWN,
    disponible: Boolean(product.is_available !== false && product.in_stock !== false && product.stock !== 0),
    error: null,
  };
}

function flattenRestaurantProducts(store: RestaurantApiData): StoreApiProduct[] {
  const products: StoreApiProduct[] = [];

  for (const corridor of store.corridors ?? []) {
    for (const product of corridor.products ?? []) {
      products.push(product);
    }
  }

  return products;
}

function flattenRetailProducts(responses: unknown[]): StoreApiProduct[] {
  const products: StoreApiProduct[] = [];

  const visit = (value: unknown) => {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;

    const looksLikeProduct =
      typeof obj.name === 'string' &&
      (
        typeof obj.price === 'number' ||
        typeof obj.real_price === 'number' ||
        typeof obj.balance_price === 'number'
      ) &&
      (
        typeof obj.product_id === 'string' ||
        typeof obj.product_id === 'number' ||
        typeof obj.master_product_id === 'string' ||
        typeof obj.master_product_id === 'number'
      );

    if (looksLikeProduct) {
      products.push(obj as StoreApiProduct);
    }

    for (const child of Object.values(obj)) {
      visit(child);
    }
  };

  for (const response of responses) {
    visit(response);
  }

  // Deduplicamos por nombre + precio + presentación.
  const seen = new Set<string>();

  return products.filter(product => {
    const key = `${normalizedKey(product.name ?? '')}|${product.price}|${product.real_price}|${normalizedKey(product.presentation ?? '')}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function findProduct(products: StoreApiProduct[], productoConfig: ProductoConfig): StoreApiProduct | null {
  const wanted = normalizedKey(productoConfig.buscar_producto);
  const output = normalizedKey(productoConfig.producto);

  const exact = products.find(product => normalizedKey(product.name ?? '') === wanted);
  if (exact) return exact;

  const includes = products.find(product => normalizedKey(product.name ?? '').includes(wanted));
  if (includes) return includes;

  const wantedTokens = tokenize(wanted);
  const byTokens = products.find(product => {
    const haystack = normalizedKey(`${product.name ?? ''} ${product.description ?? ''} ${product.presentation ?? ''}`);
    return wantedTokens.every(token => haystack.includes(token));
  });
  if (byTokens) return byTokens;

  const outputTokens = tokenize(output);
  const byOutputTokens = products.find(product => {
    const haystack = normalizedKey(`${product.name ?? ''} ${product.description ?? ''} ${product.presentation ?? ''}`);
    return outputTokens.every(token => haystack.includes(token));
  });

  return byOutputTokens ?? null;
}

function tokenize(value: string): string[] {
  // Tokens mínimos útiles. Evita que "L", "Pet", etc. dominen el match.
  const tokens = value.match(/[a-z0-9]+/g) ?? [];

  return tokens.filter(token => token.length >= 2);
}

function getRestaurantDiscountedPrice(product: StoreApiProduct): number | null {
  if (Array.isArray(product.discounts)) {
    const applicable = product.discounts.find(discount => discount.price !== undefined && discount.apply_to_user !== false);

    if (applicable?.price !== undefined) {
      return applicable.price;
    }
  }

  return product.price ?? product.real_price ?? null;
}

function getOriginalPrice(product: StoreApiProduct): number | null {
  return product.real_price ?? product.real_balance_price ?? product.price ?? product.balance_price ?? null;
}

function getRestaurantDiscountText(product: StoreApiProduct): string {
  if (Array.isArray(product.discounts)) {
    const applicable = product.discounts.find(discount => discount.value !== undefined && discount.apply_to_user !== false);

    if (applicable?.value !== undefined && applicable.value > 0) {
      return `-${Math.round(applicable.value)}%`;
    }
  }

  if (product.discount_percentage !== undefined && product.discount_percentage > 0) {
    return `-${Math.round(product.discount_percentage)}%`;
  }

  return UNKNOWN;
}

function getRetailDiscountText(product: StoreApiProduct): string {
  const price = product.price ?? product.balance_price ?? null;
  const original = product.real_price ?? product.real_balance_price ?? null;

  if (price !== null && original !== null && original > price) {
    return `-${Math.round((1 - price / original) * 100)}%`;
  }

  if (product.discount !== undefined && product.discount > 0) {
    const value = product.discount <= 1 ? product.discount * 100 : product.discount;
    return `-${Math.round(value)}%`;
  }

  if (!Array.isArray(product.discounts) && product.discounts?.discount && product.discounts.discount > 0) {
    const value = product.discounts.discount <= 1 ? product.discounts.discount * 100 : product.discounts.discount;
    return `-${Math.round(value)}%`;
  }

  return UNKNOWN;
}

function getFreeShippingTag(store: RestaurantApiData): string | null {
  const tag = store.discount_tags?.find(discount => {
    return (
      discount.type === 'free_shipping' ||
      /env[ií]o gratis|envio gratis|free shipping/i.test(`${discount.tag ?? ''} ${discount.title ?? ''} ${discount.message ?? ''}`)
    );
  });

  return tag?.tag ?? tag?.title ?? null;
}

function extractStoreInfoFromCard(cardText: string, tienda: TiendaConfig): StoreInfo {
  const text = normalizeText(cardText);

  return {
    local: extractLocalNameFromCard(text, tienda),
    tiempo_entrega: extractDeliveryTime(text),
    precio_envio: extractDeliveryFee(text),
    precio_envio_promo: extractDeliveryPromo(text),
    rating: extractRating(text),
  };
}

function extractLocalNameFromCard(text: string, tienda: TiendaConfig): string {
  const localRegex = new RegExp(`.{0,30}${escapeRegexFlexible(tienda.local)}.{0,80}`, 'i');
  const match = text.match(localRegex);

  if (match?.[0]) {
    const cleaned = normalizeText(match[0])
      .replace(/\d+\s*(?:-|a)?\s*\d*\s*min.*$/i, '')
      .replace(/\$.*$/i, '')
      .replace(/Ir a la tienda.*$/i, '')
      .trim();

    if (cleaned.length >= 2 && cleaned.length <= 120) return cleaned;
  }

  return tienda.tienda;
}

function extractDeliveryTime(text: string): string {
  const match = normalizeText(text).match(/(\d+\s*(?:-|a)?\s*\d*\s*min(?:\s*o prog\.)?)/i);
  return match?.[1] ? normalizeText(match[1]) : UNKNOWN;
}

function extractDeliveryFee(text: string): number | null {
  const normalized = normalizeText(text);

  if (/env[ií]o\s*gratis|envio\s*gratis/i.test(normalized)) {
    return 0;
  }

  const afterTime = normalized.match(/\d+\s*(?:-|a)?\s*\d*\s*min(?:\s*o prog\.)?\s*•?\s*\$?\s*([\d,.]+)/i);

  if (afterTime?.[1]) {
    return normalizePrice(afterTime[1]);
  }

  return null;
}

function extractDeliveryPromo(text: string): string {
  const normalized = normalizeText(text);

  if (/env[ií]o\s*gratis|envio\s*gratis/i.test(normalized)) {
    return 'Gratis';
  }

  return UNKNOWN;
}

function extractRating(text: string): number | null {
  const normalized = normalizeText(text);

  const patterns = [
    /★\s*([0-5](?:\.\d)?)/i,
    /\$\s*[\d,.]+\s*•\s*([0-5](?:\.\d)?)/i,
    /•\s*([0-5](?:\.\d)?)\s*(?:Env[ií]o|Ir a la tienda|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match?.[1]) {
      const value = Number(match[1]);

      if (Number.isFinite(value) && value >= 0 && value <= 5) {
        return value;
      }
    }
  }

  return null;
}

function normalizePrice(value: string): number | null {
  const parsed = Number(value.replace(/[^\d.,]/g, '').replace(/,/g, ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function emptyResult(
  direccion: DireccionConfig,
  tienda: TiendaConfig,
  producto: ProductoConfig,
  error: string | null
): RappiResult {
  return {
    plataforma: 'Rappi',
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

function toCsv(rows: RappiResult[]): string {
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
