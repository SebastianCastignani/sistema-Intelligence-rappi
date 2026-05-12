# Competitive Intelligence Scraper - Rappi + Uber Eats

## Descripción

Este proyecto obtiene información competitiva de productos en plataformas de delivery en México.

Actualmente cubre:

- Rappi
- Uber Eats

Para cada dirección configurada, el scraper consulta 3 productos:

- McDonald's → Big Mac
- Burger King → Whopper
- 7 Eleven → Coca-Cola 600 ml

El resultado se exporta en formato JSON y CSV.

---

## Plataformas incluidas

### Rappi

El scraper usa Playwright para navegar la web, cargar ubicación, abrir tiendas y capturar endpoints internos utilizados por el frontend.

Según el tipo de tienda, se capturan distintos endpoints internos:

- Restaurantes: endpoints de tipo `restaurant-bus`
- Retail / convenience stores: endpoints de tipo `web-gateway dynamic context`

Rappi devuelve datos estructurados como:

- Local
- Producto
- Descripción
- Precio
- Precio original
- Descuento
- Costo de envío
- Promo de envío
- Tiempo de entrega
- Rating
- Horarios cuando están disponibles
- Disponibilidad

---

### Uber Eats

El scraper usa Playwright para navegar la web, cargar ubicación, buscar tiendas y capturar el endpoint interno usado por el frontend:

```text
/_p/api/getStoreV1?localeCode=mx
```

Además, para el costo de envío, el scraper lee el texto visible de la página, porque en algunos casos ese dato no aparece claramente dentro del JSON del endpoint.

Ejemplo de texto visible detectado:

```text
Costo de envío: MXN0 (usuarios nuevos)
```

Uber Eats devuelve datos estructurados como:

* Local
* Producto
* Descripción
* Precio
* Precio original
* Descuento
* Tiempo de entrega
* Rating
* Horarios cuando están disponibles
* Disponibilidad

---

## Nota sobre DiDi Food

DiDi Food fue evaluada como tercera plataforma, pero durante las pruebas presentó restricciones de acceso.

Se intentó:

* Ingresar normalmente a la web.
* Cargar ubicación.
* Crear una cuenta.
* Probar navegación simulando ubicación desde México.

En todos los casos el comportamiento fue el mismo: la plataforma no permitió avanzar de forma estable para cargar ubicación y consultar productos.

Por ese motivo, DiDi Food fue descartada del alcance final para evitar una implementación inestable o dependiente de un flujo bloqueado.

Se priorizó entregar dos plataformas funcionando correctamente, con manejo de errores, output estructurado y resultados exportables.

---

## Configuración

Las direcciones, tiendas y productos se configuran en:

```text
targets/rappi-targets.json
```

Este archivo es usado por ambos scrapers:

```text
src/rappi.ts
src/ubereats.ts
```

Ejemplo de configuración de producto:

```json
{
  "tipo": "retail",
  "tienda": "7 Eleven",
  "local": "7 Eleven",
  "busqueda_tienda": "7 eleven",
  "categoria": "Bebidas",
  "productos": [
    {
      "producto": "Coca-Cola 600 ml",
      "buscar_producto": "Coca-Cola Original Refresco 600 mL Pet",
      "buscar_producto_ubereats": "Coca-Cola 600 ml"
    }
  ]
}
```

Rappi usa:

```text
buscar_producto
```

Uber Eats usa:

```text
buscar_producto_ubereats
```

Esto permite usar el mismo archivo de configuración aunque el nombre del producto sea distinto entre plataformas.

---

## Instalación

Desde la raíz del proyecto:

```bash
npm install
npm run install:browsers
pip install -r requirements.txt
```

---

## Scripts disponibles

### Rappi

Probar 1 dirección:

```bash
npm run scrape:rappi:1direccion
```

Probar 3 direcciones:

```bash
npm run scrape:rappi:3direcciones
```

Ejecutar todas las direcciones:

```bash
npm run scrape:rappi:headed
```

Outputs:

```text
output/rappi-results.json
output/rappi-results.csv
```

---

### Uber Eats

Probar 1 dirección:

```bash
npm run scrape:ubereats:1direccion
```

Probar 3 direcciones:

```bash
npm run scrape:ubereats:3direcciones
```

Ejecutar todas las direcciones:

```bash
npm run scrape:ubereats:headed
```

Outputs:

```text
output/ubereats-results.json
output/ubereats-results.csv
```

---

## Guía rápida: generar el reporte

1) Configurar la clave de Anthropic en el archivo `.env`:

```text
ANTHROPIC_API_KEY=tu_clave
```

2) Ejecutar el script del reporte:

```bash
python scripts/generate_report.py
```

El PDF se genera en:

```text
output/competitive-insights.pdf
```

---

## Estructura de salida

Cada registro devuelve este formato:

```json
{
  "plataforma": "Rappi",
  "timestamp": "2026-05-12T03:56:46.148Z",
  "zona": "Norte - Monterrey Centro",
  "direccion": "Av. Constitución 201, Centro, Monterrey, Nuevo León",
  "local": "Mc Donald's - Hidalgo",
  "producto": "Big Mac",
  "descripcion_producto": "Hamburguesa con 2 carnes de res, con salsa especial de Big Mac y queso derretido",
  "precio_producto": 125,
  "precio_producto_original": null,
  "descuento_producto": "unknown",
  "precio_envio": 0,
  "precio_envio_promo": "Envío Gratis: Aplican TyC",
  "tiempo_entrega": "12 min",
  "rating": 3.4,
  "horario_apertura": "12:00:00",
  "horario_cierre": "22:45:00",
  "disponible": true,
  "error": null
}
```

---

## Campos del output

| Campo                      | Descripción                                    |
| -------------------------- | ---------------------------------------------- |
| `plataforma`               | Plataforma consultada: Rappi o Uber Eats       |
| `timestamp`                | Fecha y hora de extracción                     |
| `zona`                     | Nombre descriptivo de la zona                  |
| `direccion`                | Dirección consultada                           |
| `local`                    | Nombre del local encontrado                    |
| `producto`                 | Producto objetivo                              |
| `descripcion_producto`     | Descripción del producto                       |
| `precio_producto`          | Precio final detectado                         |
| `precio_producto_original` | Precio original si existe descuento            |
| `descuento_producto`       | Descuento detectado                            |
| `precio_envio`             | Costo de envío detectado                       |
| `precio_envio_promo`       | Texto promocional de envío                     |
| `tiempo_entrega`           | Tiempo estimado de entrega                     |
| `rating`                   | Rating del local si está disponible            |
| `horario_apertura`         | Horario de apertura si está disponible         |
| `horario_cierre`           | Horario de cierre si está disponible           |
| `disponible`               | Indica si el producto/local fue encontrado     |
| `error`                    | Motivo del error si no se pudo obtener el dato |

---

## Manejo de errores

Cuando una tienda, producto o dirección no está disponible, el scraper no corta la ejecución.

Devuelve un registro con:

```json
{
  "disponible": false,
  "error": "Motivo del error"
}
```

Esto permite mantener la estructura del dataset y revisar posteriormente qué direcciones, tiendas o productos no pudieron ser consultados.

Ejemplos de casos esperados:

* El local no existe en esa zona.
* El producto no está disponible.
* La plataforma no devuelve resultados.
* La ubicación no pudo cargarse correctamente.
* El endpoint interno no fue capturado.

---

## Variabilidad por horario y disponibilidad

Las plataformas de delivery no devuelven siempre los mismos resultados. La disponibilidad de tiendas y productos puede cambiar según:

- Horario de apertura/cierre del local.
- Cobertura activa para la dirección consultada.
- Stock del producto.
- Disponibilidad de repartidores.
- Promociones activas.
- Reglas internas de cada plataforma.

Por ese motivo, algunos registros pueden aparecer como `disponible: false` aunque el producto exista en otra zona u horario.

El campo `timestamp` permite identificar el momento exacto en que se realizó cada consulta.

---

## Resultado esperado

Con 20 direcciones y 3 productos:

```text
20 direcciones × 3 productos = 60 registros por plataforma
```

Con Rappi + Uber Eats:

```text
2 plataformas × 20 direcciones × 3 productos = 120 registros potenciales
```

El número final puede variar si alguna tienda o producto no está disponible en una zona determinada.

---

## Decisiones técnicas

### Uso de Playwright

Se usa Playwright para:

* Abrir la plataforma.
* Cargar la dirección.
* Buscar el local.
* Abrir la tienda.
* Capturar las respuestas del frontend.
* Extraer información estructurada.

### Uso de endpoints internos

En lugar de depender únicamente del HTML visible, el scraper captura endpoints internos consumidos por el frontend.

Esto permite obtener datos más estructurados y reducir problemas asociados a:

* Cambios visuales.
* Carruseles.
* Scroll infinito.
* Productos no visibles inicialmente.
* Texto difícil de parsear desde pantalla.

### Lectura visual complementaria

En Uber Eats, el costo de envío puede aparecer visible en pantalla pero no siempre estar claramente disponible en el JSON.

Por eso, para ese campo se complementa la captura del endpoint con lectura del texto visible de la página.

---

## Consideraciones finales

El proyecto prioriza estabilidad y trazabilidad.

Si una consulta falla, el scraper continúa con la siguiente dirección o producto y deja el error documentado en el output.

Esto permite usar los resultados como base para análisis posterior, limpieza, visualización o carga en una base de datos.

---

## Posibles mejoras

- Agregar pasos de seguimiento con equipos internos (Pricing, Operations, Strategy) para definir métricas más útiles para el negocio.
- Enviar los datos a una base de datos para usar Power BI, Tableau u otras herramientas de BI.
- Mejorar el scraping para hacerlo más estable y amigable a la vista (menores flakiness, mejores logs y fallbacks).
- Empaquetar el proyecto en una imagen Docker para ejecutar en Lambdas o jobs programados.
- Mejorar el diccionario de búsqueda para detectar productos y locales con más precisión.

---

