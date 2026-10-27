# CASA LINTERNA · Vivienda unifamiliar en lote de 8.00 × 17.00 m

Proyecto de arquitectura (anteproyecto / proyecto básico) — **versión 4**. Frente de 8.00 m a la calle:

| Zona | Medidas | Área | Sistema |
|---|---|---|---|
| Cochera / reuniones (al frente, junto a la calle) | 8.00 × 5.00 m | 40.00 m² | Sin muros. Cobertura metálica a una sola agua (cae hacia la calle) sobre 2 columnas con pedestales |
| Vivienda (material noble) | 8.00 × 12.00 m | 73.42 m² techados por piso, 2 pisos | Albañilería confinada + pórticos de C°A°, con pozo de luz y patio de servicio al fondo |
| Terraza (3er nivel) | 8.00 × 9.65 m | 77.20 m² | Cobertura metálica liviana a una sola agua |

La sala, el comedor y los dos dormitorios delanteros (con balcón) miran a la cochera techada.

![Vista desde la calle](entregables/renders/render-calle.png)

## Entregables

| Archivo | Contenido | Se abre con |
|---|---|---|
| `entregables/CasaLinterna_Planos_A1.pdf` | 8 láminas A1 vectoriales (plantas de 1er piso, 2do piso y terraza, techos, estructura de coberturas, detalles de pedestal y de apoyo, 2 cortes longitudinales, 2 transversales, elevaciones principal y posterior, vistas 3D, cuadros de vanos, ambientes, áreas y metálicos) | Cualquier visor PDF / plotter |
| `entregables/CasaLinterna_Planos.dxf` | Mismo juego de planos para CAD: espacio modelo a escala real (m) + 8 layouts A1 con viewports 1/50, 1/75 y 1/20, capas normalizadas, bloques con atributos y cotas nativas | AutoCAD, BricsCAD, ZWCAD, DraftSight |
| `entregables/CasaLinterna_Modelo.ifc` | Modelo BIM IFC4: elementos con geometría validada (muros, losas, columnas, vigas, pedestales, escaleras, puertas, ventanas, coberturas, estructura metálica, celosías, mobiliario) + espacios con áreas y Psets | Revit, ArchiCAD, Tekla, BIMcollab, BlenderBIM |
| `entregables/visor-3d.html` | Visor 3D interactivo: pisos, coberturas, capas, **corte en vivo**, selección de elementos con datos BIM y las 8 láminas | Navegador |
| `entregables/laminas/A-0x.png` | Láminas en imagen (150 dpi) | — |
| `entregables/renders/*.png` | Vistas 3D | — |
| `revit/crear_modelo_revit.py` + `revit/casa_linterna_revit.json` | Script que **construye el modelo nativo en Revit** (ver abajo) | pyRevit, RevitPythonShell, Dynamo |

### Sobre el archivo nativo de Revit (.rvt)

El formato `.rvt` es binario y propietario: solo Revit puede escribirlo, y Revit no corre en el
entorno donde se generó este proyecto. Hay dos caminos para tenerlo, ambos en un par de minutos:

1. **Modelo nativo editable (recomendado).** Abre Revit 2022 o superior con la plantilla métrica de
   arquitectura y ejecuta `revit/crear_modelo_revit.py` con pyRevit o RevitPythonShell (el `.json`
   debe estar en la misma carpeta). El script crea niveles, ejes, tipos de muro/losa/techo con el
   espesor exacto, muros nativos, puertas y ventanas como **tipos paramétricos** duplicados por medida
   (P-01 0.80×2.10, MP-03 2.60×2.40, …), losas con hueco de escalera, balcones, escaleras en U nativas
   (`StairsEditScope`), la cobertura como techo por extrusión, habitaciones con nombre y acabado,
   plantas, cortes, vista 3D y láminas. Columnas, vigas, estructura metálica, celosías, mobiliario y autos
   se crean como `DirectShape` con su categoría BIM y material, para no depender de familias cargadas.
   Luego: **Archivo › Guardar como › CasaLinterna.rvt**.
   El script se escribió contra la API pública de Revit pero **no pudo ejecutarse aquí**; cada bloque
   reporta en consola lo que crea u omite.
2. **Vía IFC.** En Revit: **Archivo › Abrir › IFC** › `CasaLinterna_Modelo.ifc` › Guardar como `.rvt`.
   Es inmediato, pero Revit importa los elementos como geometría IFC (menos editable que la opción 1).

Si usas un servidor **MCP para Revit** que ejecute Python, puedes enviarle el mismo script; si tu
servidor solo ejecuta C#, usa la opción 2 o pyRevit.

## Concepto y programa

El lote tiene 8 m de frente y 17 m de fondo. Los primeros 5 m son la **cochera**: queda abierta, sin
muros, bajo una cobertura metálica a una sola agua (10 %, cae hacia la calle) sobre 2 columnas junto a
la vereda y apoyada en la fachada. Caben 2 autos lado a lado con un pasillo central hacia la puerta, y
sin los autos funciona como zona de reuniones. Junto a la fachada, una banda de policarbonato deja
pasar la luz hacia los balcones y la sala.

Detrás, la vivienda de 8 × 12 m. Como las dos medianeras son ciegas y el lote es profundo, la vivienda
tiene un **pozo de luz** central (1.80 × 2.10 m, cubierto con policarbonato a nivel de la terraza) y un
**patio de servicio** al fondo (7.70 × 2.20 m): así ventilan e iluminan, como pide el RNE, los ambientes
que no pueden dar a la cochera.

**1er piso · NPT ±0.00** — Sala (12.65 m²) y comedor (11.90) abiertos a la cochera con mamparas
corredizas, baño de visitas (1.80), hall con escalera en U, cocina (13.20) hacia el patio y el pozo de
luz, **dormitorio 1 (9.25 m²) con baño propio (3.23)**, patio de servicio con lavandería.

**2do piso · NPT +2.80** — **4 dormitorios, cada uno con su baño**, alrededor del hall:

| Ambiente | Área | Baño | Ancho | Luz y ventilación |
|---|---|---|---|---|
| Dormitorio 2 | 9.35 m² + balcón 3.58 | 3.13 m² | 3.73 m | Cochera (balcón) |
| Dormitorio 3 | 9.70 m² + balcón 3.63 | 3.13 m² | 3.83 m | Cochera (balcón) |
| Dormitorio 4 | 9.25 m² | 3.23 m² | 3.73 m | Patio posterior |
| Dormitorio 5 | 9.60 m² | 3.23 m² | 3.83 m | Patio posterior |

Cada dormitorio es para una persona: cama de 1.05 × 1.90 con velador, closet y escritorio.
Con el dormitorio del 1er piso son **5 dormitorios con baño propio**.

**Terraza · NPT +5.60** — 62 m² útiles bajo cobertura (pendiente 5 % hacia el patio), con parrilla,
comedor exterior, sala, tendal y celosía de madera hacia la calle.

| Cuadro de áreas | m² |
|---|---|
| Terreno | 136.00 |
| Techado 1er piso | 73.42 |
| Techado 2do piso | 73.42 (+ 7.21 de balcones) |
| **Total material noble** | **154.05** |
| Terraza con cobertura liviana | 77.20 |
| Cochera con cobertura liviana | 40.00 (29.4 %) |
| Patio de servicio + pozo de luz (abiertos) | 22.58 (16.6 %) |

## Criterios técnicos

- **Estructura (referencial):** columnas 0.25 × 0.25, vigas 0.25 × 0.40, losa aligerada h = 0.20, muros de
  ladrillo KK e = 0.15 y tabiques de baño e = 0.10. Ejes A-B-C (3.83 / 3.92 m) y 1-2-3-4 (3.53 / 2.35 / 3.53 m).
  **Debe diseñarla y firmarla un ingeniero civil colegiado** (E.020, E.030, E.060, E.070, E.090).
- **Escalera:** 16 contrapasos de 0.175 m, pasos de 0.25 m, tramos de 1.00 m.
- **Cobertura de la cochera:** 2 columnas CM-1 (tubo 150×150×4) sobre placa base 300×300×12 con 4 pernos
  Ø5/8", **pedestales de C°A° 0.40 × 0.40** (0.50 m sobre el piso, protegen de golpes de los autos) y
  zapatas 0.90 × 0.90; viga frontal VM-2 (tubo 150×300×4, 7.40 m de luz entre columnas), 7 vigas VM-1
  (tubo 100×200×3 @ 1.233) apoyadas en la vivienda con el ángulo AN-1, correas 50×100×2, panel TR4 de
  50 mm + banda de policarbonato, arriostres Ø1/2", canaleta frontal y 2 bajantes. Altura +5.60 → +5.10.
  Ver los detalles 1 y 2 de la lámina A-04.
- **Cobertura de terraza:** 12 columnas CT-1 (tubo 100×100×3) sobre las columnas de concreto, 3 vigas VT-1
  (tubo 100×250×3), correas @ 1.00, panel TR4 + policarbonato sobre el pozo de luz, canaleta y 2 bajantes al patio.
- **Bloques realistas:** autos con su perfil lateral real (capó, parabrisas, techo, pasos de rueda, ruedas
  circulares con aro, faros, stops, placas y espejos); camas con cabecero, almohadas, edredón y veladores
  con lámpara; sofás con cojines; sillas con respaldo; inodoros, lavatorios, duchas; plantas y árboles.
- **Normativa de referencia (Perú, RNE):** A.010, A.020, E.030, E.060, E.070, E.090, IS.010. Verifica los
  parámetros urbanísticos de tu municipalidad (altura máxima, retiros, porcentaje de área libre y si la
  cobertura liviana de la cochera requiere trámite).

## Cómo se construyó (flujo paramétrico)

Todo sale de un único modelo paramétrico en Python (`src/model.py`): cada elemento es un prisma
(polígono YZ extruido en X; x = ancho, y = fondo) con categoría BIM, material, nivel y fase. De esa fuente única se generan:

- `views.py` — plantas, cortes y elevaciones con **eliminación real de líneas ocultas** (geometría
  booleana con shapely), poché por material y anotaciones.
- `drawing.py` — bloques paramétricos (puertas, ventanas, sanitarios, mobiliario) que en DXF se
  escriben como bloques reutilizables por medida con atributos `CODIGO/ANCHO/ALTO`.
- `sheets.py` / `dxf_export.py` — maquetación A1, rótulo, cuadros y exportación PDF/DXF.
- `ifc_export.py` — IFC4 con estilos, materiales, Psets y espacios.
- `revit_export.py` + `revit/crear_modelo_revit.py` — datos semánticos y automatización de Revit.

Cambiar una medida en `model.py` y ejecutar `python3 src/build_all.py` regenera todos los entregables
de forma coherente. Nota: los bloques DXF son bloques estándar con atributos (uno por medida); ezdxf no
puede escribir bloques dinámicos de AutoCAD con parámetros/acciones.

Requisitos para regenerar: `pip install ezdxf ifcopenshell matplotlib shapely pillow` y Node con
Playwright (solo para los renders).

---
*Propietario, ubicación y proyectista quedan en blanco en el rótulo para completarse.*
