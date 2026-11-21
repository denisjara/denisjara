# Metrado Lab — metrados de obra sobre planos

App web para **metrar directamente sobre el plano**: abre un PDF de CAD, un DXF o una imagen, fija la
escala y mide longitudes, áreas y cantidades por partida. La hoja de metrados se arma sola y se exporta
a Excel con sus fórmulas.

- **Web:** https://denisjara.github.io/denisjara/metrados/
- **Versión portátil:** [`descargas/Metrado-Lab.html`](descargas/Metrado-Lab.html) — un único archivo
  que se abre con doble clic, sin instalar nada y sin conexión.

Todo ocurre en el navegador. **Los planos no se suben a ningún servidor**: se leen y se guardan solo en
el equipo de quien los abre.

## Cómo se usa

1. **Abre el plano** (botón «Abrir plano» o arrastrando el archivo). Cada página de un PDF es una lámina.
2. **Fija la escala** y compruébala midiendo una cota con la Regla (`M`).
   - PDF: escala gráfica 1:N (la app propone la que encuentra escrita en el plano) o calibración con una cota.
   - DXF: unidad de dibujo (metros, centímetros, milímetros…); la app muestra cuánto mide el dibujo con esa unidad.
   - Imagen: calibración con una cota (dos puntos y su distancia real).
3. **Crea las partidas** (a medida o del catálogo de partidas habituales en edificación) y mide: cada clic
   coloca un punto y el cursor **se engancha a los vértices del plano** (extremos, intersecciones, puntos
   medios, perpendiculares).
4. **Revisa la hoja de metrados**, ajusta veces, altos, anchos o descuentos y **expórtala** (Excel con
   fórmulas, CSV o copiar y pegar).

### Herramientas

| Tecla | Herramienta | Qué hace |
|---|---|---|
| `V` | Seleccionar | Elegir una medición, arrastrar sus vértices (con enganche), borrarla |
| `L` | Longitud | Polilínea; `Intro` termina, `C` cierra, `Retroceso` quita el último punto |
| `A` | Área | Polígono; `Intro` o doble clic lo cierra |
| `R` | Rectángulo | Área por dos esquinas |
| `C` | Conteo | Un punto por elemento |
| `T` | Tomar trazo | Clic sobre una línea, polilínea o contorno del plano: se mide tal como está dibujado |
| `B` | Área automática | Detecta el recinto cerrado bajo el cursor; puede cerrar los vanos de puerta |
| `M` | Regla | Medir sin guardar (distancia, Δx, Δy y ángulo) |
| `K` | Calibrar | Dos puntos de una cota conocida |

Mientras se dibuja: `Mayús` = ortogonal; teclear un número + `Intro` = tramo de esa longitud exacta;
`D` = descuento; `S` = enganche sí/no; arrastrar o `Espacio` = mover el plano; rueda = zoom; `F` = ver todo.
En pantallas táctiles: un toque coloca el punto, mantener pulsado apunta con precisión y dos dedos hacen zoom.

### Lectura automática (pestaña «Lectura»)

La app ya leyó la geometría del plano, así que puede medir grupos enteros de una vez: **todo lo de una
capa** (DXF y PDF con capas), **todo lo de un color y grosor** (PDF), **bloques** de un DXF (cuenta las
inserciones) y **rótulos de texto** (cuántas veces aparece «P-1», «V-2»…). Cada grupo se puede resaltar
en el plano antes de medirlo.

### Partidas y fórmulas

Cada fila de la hoja es `N.º de veces × (lo que se lee del plano) × (multiplicadores de la partida)`:

| Se lee del plano | Multiplicadores posibles | Ejemplos |
|---|---|---|
| Longitud | ancho, alto, factor | muros (L × alto), cimientos (L × ancho × alto), acero (L × kg/m) |
| Área | espesor/alto, factor | pisos, losas (A × espesor), ladrillo de techo (A × und/m²) |
| Perímetro | alto, factor | contrazócalo de un ambiente, tarrajeo por ambiente (P × alto) |
| Cantidad | largo, ancho, alto, factor | puertas, puntos de luz, zapatas (N × l × a × h) |

Los descuentos (vanos, ductos) son filas que restan. También hay filas manuales para lo que no está en el plano.

## Qué tan exacta es la lectura

La app no reconoce imágenes ni adivina: **lee las coordenadas que el archivo contiene**.

- **DXF**: coordenadas del dibujo en precisión doble. Rectas y arcos se miden con fórmula cerrada; elipses
  y splines como curvas Bézier (las splines no racionales de grado ≤ 3 se convierten sin error; las demás
  se muestrean muy fino). Bloques, capas y sombreados se leen tal cual.
- **PDF vectorial**: se leen los vértices del PDF a través de pdf.js; el enganche coloca cada punto
  exactamente sobre ellos. El límite es el del propio archivo: un PDF de CAD suele guardar las coordenadas
  con una resolución en torno a 0,02 mm de papel (±1 mm reales a escala 1:50).
- **Escaneos y fotos**: no hay vértices; la precisión depende de la imagen y de dónde se haga clic.
  Conviene calibrar con la cota más larga y trabajar con mucho zoom.
- **La escala manda**: un «1/50» escrito en un PDF que se exportó «ajustado a página» da medidas falsas.
  Por eso la calibración con una cota muestra cuánto difiere de la escala nominal.
- **Área automática** mide el recinto *tal como está dibujado*: una puerta abierta o un mueble pegado al
  muro lo recortan. Para ambientes, oculta las capas de puertas y mobiliario y deja activo el cierre de
  vanos; el contorno detectado se resalta antes de medir.
- **Redondeo**: como en una hoja hecha a mano, cada medida se redondea a los decimales del proyecto
  (2, 3 o 4) antes de multiplicar, el parcial se redondea igual y el total es la suma de parciales.
  El Excel exportado usa esas mismas fórmulas y da los mismos números.

### Formatos

| Formato | Soporte |
|---|---|
| PDF | Vectorial (con capas si las trae) y escaneado; varias páginas |
| DXF | ASCII, cualquier versión. Entidades: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE, HATCH, SOLID, INSERT (bloques anidados y matrices), TEXT, MTEXT, ATTRIB, DIMENSION, LEADER |
| Imagen | PNG, JPG, WebP, GIF, BMP |
| DWG | No: en AutoCAD, «Guardar como → DXF» (o imprimir a PDF). La geometría se lee igual de exacta |

No se dibujan (se avisa al abrir): MLEADER, tablas complejas, sólidos 3D, imágenes referenciadas y el
espacio papel de un DXF (se trabaja sobre el espacio modelo).

## Datos y privacidad

- El proyecto y sus planos se guardan solos en el navegador (IndexedDB). Es una comodidad, no una copia de
  seguridad: para eso está «Guardar copia del proyecto (.zip)», que incluye los planos originales.
- La app no hace ninguna petición a terceros. Su política de seguridad de contenido (CSP) no permite
  conexiones salientes.

## Desarrollo

```bash
cd metrados
npm ci
npm run dev                # http://127.0.0.1:5174
npm test                   # geometría, lectores de PDF y DXF, recintos, Excel y ZIP
npm run typecheck
npm run build              # web → dist/
npm run build:standalone   # un solo archivo → standalone/Metrado-Lab.html
```

Requiere Node ≥ 22.13. Los tests del Excel lo validan además con `openpyxl` y lo recalculan con LibreOffice
si están instalados (si no, esas comprobaciones se saltan solas).

### Estructura

```
src/core/      cálculo puro, sin navegador
  geometry.ts    rectas, arcos (bulge) y Bézier: longitud y área analíticas
  vector.ts      geometría de la lámina en arrays tipados, índice espacial y enganche
  boundary.ts    área automática: cara del grafo plano que contiene un punto
  metrado.ts     fórmulas de partidas, redondeo y hoja de metrados
  model.ts       modelo del proyecto y validación de lo que se lee de disco
  units.ts       escalas, unidades, formato y detección de «ESC 1/50»
  catalog.ts     catálogo de partidas
src/io/        lectura y escritura de archivos
  pdf/           pdf.js: geometría vectorial, capas, estilos y textos de cada página
  dxf/           lector DXF propio y conversión a lámina
  xlsx.ts zip.ts escritor de Excel y de ZIP sin dependencias
  sample.ts      plano de ejemplo (PDF y DXF) con medidas conocidas, usado también por los tests
src/viewer/    visor: capa del plano (nítida a cualquier zoom), capa de mediciones, herramientas y entrada
src/app/       estado (con deshacer/rehacer), acciones, guardado local, exportación
src/ui/        interfaz (React)
scripts/       CSP de producción y empaquetado de la versión portátil
tests/         pruebas (vitest)
```

Dos decisiones que conviene conocer antes de tocar el código:

- **La geometría nunca se mide teselada.** Un trazo guarda rectas, arcos y Bézier exactos; la versión en
  segmentos (`flatten*`) solo sirve para dibujar, enganchar y detectar recintos.
- **La lectura de PDF depende de la lista de operadores de pdf.js** (`constructPath` y su formato de datos),
  que cambia entre versiones mayores. `tests/pdf-extract.test.ts` y `tests/sample.test.ts` fallan si deja
  de leerse bien; por eso Dependabot no propone versiones mayores de `pdfjs-dist`.

### Publicación

GitHub Pages solo admite un sitio por repositorio, así que el workflow de FutStat Lab
(`.github/workflows/futstat-daily.yml`) compila también esta app y la publica en `/metrados/` del mismo
sitio. Si su compilación fallara, FutStat Lab se publica igualmente y el workflow avisa.

La versión portátil de `descargas/` se regenera con `npm run build:standalone` y se copia a mano
(`cp standalone/Metrado-Lab.html descargas/`).

### Comprobado en navegador

Además de los tests, la versión 1.0 se probó con Chromium (Playwright): abrir el PDF y el DXF de ejemplo,
medir con clics imprecisos y comprobar que el enganche da las medidas exactas, exportar el Excel y
recalcularlo con LibreOffice, recargar para comprobar el guardado, tema oscuro, móvil y la versión portátil
abierta desde disco. No se ha probado en Firefox ni en Safari.
