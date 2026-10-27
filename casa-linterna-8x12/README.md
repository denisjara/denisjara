# CASA LINTERNA · Vivienda unifamiliar en lote de 8.00 × 12.00 m

Proyecto de arquitectura (anteproyecto / proyecto básico) — **versión 2**:

| Zona | Medidas | Área | Sistema |
|---|---|---|---|
| Área libre — cochera / reuniones (frente a la calle) | 8.00 × 5.00 m | 40.00 m² (41.7 %) | Sin muros. Cobertura metálica a una sola agua sobre 4 columnas con pedestales |
| Vivienda (material noble) | 8.00 × 7.00 m | 56.00 m² por piso, 2 pisos | Albañilería confinada + pórticos de C°A° |
| Terraza (3er nivel) | 8.00 × 7.00 m | 56.00 m² | Cobertura metálica liviana a una sola agua |

![Vista desde la calle](entregables/renders/render-calle.png)

## Entregables

| Archivo | Contenido | Se abre con |
|---|---|---|
| `entregables/CasaLinterna_Planos_A1.pdf` | 6 láminas A1 vectoriales (plantas de 1er piso, 2do piso y terraza, techos, 4 cortes, 2 elevaciones, estructura de coberturas, detalles de pedestal y de apoyo, vistas 3D, cuadros de vanos, ambientes, áreas y metálicos) | Cualquier visor PDF / plotter |
| `entregables/CasaLinterna_Planos.dxf` | Mismo juego de planos para CAD: espacio modelo a escala real (m) + 6 layouts A1 con viewports 1/50 y 1/10, capas normalizadas, bloques con atributos y cotas nativas | AutoCAD, BricsCAD, ZWCAD, DraftSight |
| `entregables/CasaLinterna_Modelo.ifc` | Modelo BIM IFC4: elementos con geometría validada (muros, losas, columnas, vigas, pedestales, escaleras, puertas, ventanas, coberturas, estructura metálica, celosías, mobiliario) + espacios con áreas y Psets | Revit, ArchiCAD, Tekla, BIMcollab, BlenderBIM |
| `entregables/visor-3d.html` | Visor 3D interactivo: pisos, coberturas, capas, **corte en vivo**, selección de elementos con datos BIM y las 6 láminas | Navegador |
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
   (P-01 0.80×2.10, V-04 2.40×2.30, …), losas con hueco de escalera, escaleras en U nativas
   (`StairsEditScope`), la cobertura como techo por extrusión, habitaciones con nombre y acabado,
   plantas, cortes, vista 3D y láminas. Columnas, vigas, estructura metálica, celosías y marco volado
   se crean como `DirectShape` con su categoría BIM y material, para no depender de familias cargadas.
   Luego: **Archivo › Guardar como › CasaLinterna.rvt**.
   El script se escribió contra la API pública de Revit pero **no pudo ejecutarse aquí**; cada bloque
   reporta en consola lo que crea u omite.
2. **Vía IFC.** En Revit: **Archivo › Abrir › IFC** › `CasaLinterna_Modelo.ifc` › Guardar como `.rvt`.
   Es inmediato, pero Revit importa los elementos como geometría IFC (menos editable que la opción 1).

Si usas un servidor **MCP para Revit** que ejecute Python, puedes enviarle el mismo script; si tu
servidor solo ejecuta C#, usa la opción 2 o pyRevit.

## Concepto y programa

El área libre se ubica **al frente** para que funcione como cochera para 2 autos y como espacio de
reuniones: queda totalmente abierta, sin muros ni cerramientos. La cubre una estructura metálica a una
sola agua (10 %, cae hacia la calle) sobre 4 columnas en las esquinas, con una luz libre de 7.10 m
entre ellas y 2.45 m de altura libre mínima.

La escalera en U va al centro de la fachada, dentro de una **linterna** de vidrio con celosía de
listones. Detrás de la escalera, un **pozo de luz** de 2.30 × 1.80 m con un árbol, abierto desde el 1er
piso hasta la terraza, ilumina el comedor, la cocina y los dormitorios posteriores (el fondo del lote es
medianera ciega).

**1er piso · NPT ±0.00** — Sala (9.37 m²), recibo con ingreso (5.23), estar (4.60), comedor (7.46) y
cocina (7.46) abiertos al patio de luz, baño de visitas (2.36).

**2do piso · NPT +2.80** — **4 dormitorios, cada uno con su baño**, alrededor de la galería:

| Ambiente | Área | Baño propio | Luz y ventilación |
|---|---|---|---|
| Dormitorio 1 y 2 (frente) | 6.88 m² c/u (cama 1.35 × 1.90) | 2.12 m² con ventana | Fachada |
| Dormitorio 3 y 4 (fondo) | 5.00 m² c/u (cama 1.05 × 1.90) | 2.09 m², ventilación por ducto | Pozo de luz |

**Terraza · NPT +5.60** — 41 m² útiles bajo cobertura (pendiente 5.7 % hacia la fachada), con lavandería,
tendal, parrilla, sala exterior y jardineras. Sobre el pozo de luz la cobertura es de policarbonato.

| Cuadro de áreas | m² |
|---|---|
| Terreno | 96.00 |
| Techado 1er piso | 56.00 |
| Techado 2do piso | 56.00 |
| **Total material noble** | **112.00** |
| Terraza con cobertura liviana | 56.00 |
| Área libre (cochera con cobertura liviana) | 40.00 (41.7 %) |

## Criterios técnicos

- **Estructura (referencial):** columnas 0.25 × 0.25, vigas 0.25 × 0.40, losa aligerada h = 0.20, muros de
  ladrillo KK e = 0.15 y tabiques de baño e = 0.10. Ejes 1-2-3-4 (2.65 / 2.45 / 2.65 m) y A-B-C (3.75 / 3.00 m).
  **Debe diseñarla y firmarla un ingeniero civil colegiado** (E.020, E.030, E.060, E.070, E.090).
- **Escalera:** 16 contrapasos de 0.175 m, pasos de 0.25 m, tramos de 1.05 m, descanso contra la linterna.
- **Cobertura de cochera:** 4 columnas CM-1 (tubo 150×150×4) sobre placa base 300×300×12 con 4 pernos
  Ø5/8", **pedestales de C°A° 0.40 × 0.40** (0.50 m sobre el piso, protegen de golpes de los autos) y
  zapatas 0.90 × 0.90; 2 vigas VM-2 (tubo 150×300×4), 6 vigas VM-1 (tubo 100×200×3 @ 1.45), correas
  50×100×2 @ 0.95, panel termoacústico TR4 de 50 mm, arriostres Ø1/2", canaleta frontal y 2 bajantes de 3".
  Ver los detalles 1 y 2 de la lámina A-04.
- **Cobertura de terraza:** 12 columnas CT-1 (tubo 100×100×3) sobre las columnas de concreto, 4 vigas VT-1
  (tubo 100×250×3), correas @ 1.00, panel TR4 + policarbonato sobre el pozo, canaleta y 2 bajantes por fachada.
- **Normativa de referencia (Perú, RNE):** A.010, A.020, E.030, E.060, E.070, E.090, IS.010. Verifica los
  parámetros urbanísticos de tu municipalidad (altura máxima, retiros, porcentaje de área libre y si la
  cobertura liviana del área libre requiere trámite).

## Cómo se construyó (flujo paramétrico)

Todo sale de un único modelo paramétrico en Python (`src/model.py`): cada elemento es un prisma
(polígono YZ extruido en X) con categoría BIM, material, nivel y fase. De esa fuente única se generan:

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
