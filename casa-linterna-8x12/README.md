# CASA LINTERNA · Vivienda unifamiliar en lote de 13.00 × 12.00 m

Proyecto de arquitectura (anteproyecto / proyecto básico) — **versión 3**:

| Zona | Medidas | Área | Sistema |
|---|---|---|---|
| Vivienda (material noble) | 8.00 × 12.00 m | 96.00 m² por piso, 2 pisos | Albañilería confinada + pórticos de C°A° |
| Franja libre — cochera / reuniones (desde la calle hasta el fondo) | 5.00 × 12.00 m | 60.00 m² (38.5 %) | Sin muros. Cobertura metálica a una sola agua sobre 4 columnas con pedestales |
| Terraza (3er nivel) | 8.00 × 12.00 m | 96.00 m² | Cobertura metálica liviana a una sola agua |

Todas las ventanas, mamparas y los 3 balcones miran hacia la franja techada.

![Vista desde la calle](entregables/renders/render-calle.png)

## Entregables

| Archivo | Contenido | Se abre con |
|---|---|---|
| `entregables/CasaLinterna_Planos_A1.pdf` | 8 láminas A1 vectoriales (plantas de 1er piso, 2do piso y terraza, techos, estructura de coberturas, detalles de pedestal y de apoyo, 4 cortes, 2 elevaciones, vistas 3D, cuadros de vanos, ambientes, áreas y metálicos) | Cualquier visor PDF / plotter |
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

La vivienda ocupa 8 m del frente y los 12 m de fondo; a su lado, la franja de 5 × 12 m queda abierta
de la calle al fondo, sin muros, bajo una cobertura metálica a una sola agua (10 %, cae hacia el
lindero lateral). Sirve para 2 autos en tándem y, al fondo, para reuniones familiares con parrilla,
mesa exterior y un árbol. Todas las ventanas, mamparas y balcones miran hacia esa franja; la
medianera opuesta queda ciega. Junto a la fachada, una banda de policarbonato deja entrar luz a los
ambientes.

**1er piso · NPT ±0.00** — Vestíbulo (9.24 m²), sala (20.77), comedor (16.17) y cocina (15.01) en
secuencia abierta a la franja con mamparas corredizas; **dormitorio 1 (9.10) con baño propio (4.42)**;
baño de visitas (2.54); escalera en U junto a la medianera.

**2do piso · NPT +2.80** — **3 dormitorios amplios, cada uno con baño propio y balcón** hacia la franja:

| Ambiente | Área | Baño | Ancho libre |
|---|---|---|---|
| Dormitorio 2 | 17.99 m² | 2.88 m² | 3.95 m |
| Dormitorio 3 | 16.56 m² | 4.43 m² | 3.60 m |
| Dormitorio 4 (principal) | 20.60 m² + walk-in 3.62 | 4.73 m² | 3.85 m |

Con 12 m de largo, un 4to dormitorio en el 2do piso obligaría a anchos de ~2.40 m (angostos); por eso
se proponen 3 dormitorios amplios arriba + 1 dormitorio con baño abajo = **4 dormitorios con baño**.

**Terraza · NPT +5.60** — 84 m² útiles bajo cobertura (pendiente 5 %), con lavandería, tendal, sala y
comedor exterior.

| Cuadro de áreas | m² |
|---|---|
| Terreno | 156.00 |
| Techado 1er piso | 96.00 |
| Techado 2do piso | 96.00 (+ 9.60 de balcones) |
| **Total material noble** | **192.00** |
| Terraza con cobertura liviana | 96.00 |
| Franja libre (cochera / reuniones con cobertura liviana) | 60.00 (38.5 %) |

## Criterios técnicos

- **Estructura (referencial):** columnas 0.25 × 0.25, vigas 0.25 × 0.40, losa aligerada h = 0.20, muros de
  ladrillo KK e = 0.15 y tabiques de baño e = 0.10. Ejes 1-2-3-4 (a lo largo del fondo) y A-B-C-D.
  **Debe diseñarla y firmarla un ingeniero civil colegiado** (E.020, E.030, E.060, E.070, E.090).
- **Escalera:** 16 contrapasos de 0.175 m, pasos de 0.25 m, tramos de 1.00 m.
- **Cobertura de la franja:** 4 columnas CM-1 (tubo 150×150×4) sobre placa base 300×300×12 con 4 pernos
  Ø5/8", **pedestales de C°A° 0.40 × 0.40** y zapatas 0.90 × 0.90; viga VM-2 (tubo 150×300×4) sobre las
  columnas, 9 vigas VM-1 (tubo 100×200×3 @ 1.425) apoyadas en la vivienda con ángulo AN-1, correas 50×100×2,
  panel TR4 de 50 mm + banda de policarbonato, arriostres Ø1/2", canaleta y 4 bajantes. Altura +5.60 → +5.10.
  Ver detalles 1 y 2 de la lámina A-04.
- **Cobertura de terraza:** 12 columnas CT-1 (tubo 100×100×3) sobre las columnas de concreto, 4 vigas VT-1
  (tubo 100×250×3), correas @ 1.00, panel TR4, canaleta y 2 bajantes.
- **Bloques realistas:** autos modelados por secciones (capó, parabrisas, cabina, ruedas con aro, faros,
  espejos) y unidos como superficie continua en el visor; camas con cabecero, almohadas y edredón,
  sofás con cojines, sillas con respaldo, inodoros, lavatorios, duchas, plantas y árbol.
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
