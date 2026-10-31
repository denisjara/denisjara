"""
Genera edificio-demo.ifc: un edificio pequeño de 2 niveles para probar nwd-mcp en Navisworks.

Contiene losas, muros, columnas, vigas, puertas, ventanas, una escalera, ductos y tuberías,
todos con nombres en español y conjuntos de propiedades (Pset_*Common + "Datos_Demo").
Incluye a propósito una tubería que atraviesa una viga (choque para Clash Detective).

Uso:  pip install ifcopenshell numpy
      python generar_modelo.py
"""
import math
import os

import numpy as np
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.api.root, ifcopenshell.api.unit, ifcopenshell.api.context, ifcopenshell.api.aggregate
import ifcopenshell.api.material, ifcopenshell.api.geometry, ifcopenshell.api.spatial, ifcopenshell.api.pset
api = ifcopenshell.api
import ifcopenshell.guid

SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edificio-demo.ifc")

m = api.root.create_entity(ifcopenshell.file(schema="IFC4"), ifc_class="IfcProject", name="Proyecto Demo nwd-mcp") if False else None
model = ifcopenshell.file(schema="IFC4")
proyecto = api.root.create_entity(model, ifc_class="IfcProject", name="Proyecto Demo nwd-mcp")
api.unit.assign_unit(model, length={"is_metric": True, "raw": "METERS"})  # metros
ctx = api.context.add_context(model, context_type="Model")
body = api.context.add_context(model, context_type="Model", context_identifier="Body",
                               target_view="MODEL_VIEW", parent=ctx)

sitio = api.root.create_entity(model, ifc_class="IfcSite", name="Terreno Demo")
edificio = api.root.create_entity(model, ifc_class="IfcBuilding", name="Edificio Demo")
api.aggregate.assign_object(model, relating_object=proyecto, products=[sitio])
api.aggregate.assign_object(model, relating_object=sitio, products=[edificio])

# ------------------------------------------------------------------ materiales
materiales = {n: api.material.add_material(model, name=n, category=c) for n, c in [
    ("Hormigón H30", "concrete"), ("Acero A630", "steel"), ("Albañilería ladrillo", "brick"),
    ("Madera pino", "wood"), ("Vidrio templado", "glass"), ("Acero galvanizado", "steel"),
    ("Cobre", "copper"), ("PVC", "plastic"),
]}

# ------------------------------------------------------------------ geometría
def p3(x, y, z):
    return model.createIfcCartesianPoint((float(x), float(y), float(z)))


def d3(x, y, z):
    return model.createIfcDirection((float(x), float(y), float(z)))


def eje(origen=(0, 0, 0), z=(0, 0, 1), x=(1, 0, 0)):
    return model.createIfcAxis2Placement3D(p3(*origen), d3(*z), d3(*x))


def caja(w, d, h):
    """Prisma w (X) x d (Y) x h (Z) con esquina en el origen local."""
    perfil = model.createIfcRectangleProfileDef(
        "AREA", None, model.createIfcAxis2Placement2D(model.createIfcCartesianPoint((w / 2, d / 2)), None), w, d)
    solido = model.createIfcExtrudedAreaSolid(perfil, eje(), d3(0, 0, 1), h)
    return model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solido])


def cilindro(radio, largo, direccion):
    """Cilindro que nace en el origen local y avanza 'largo' en la dirección dada (eje X o Y)."""
    if direccion == "X":
        pos = eje(z=(1, 0, 0), x=(0, 1, 0))
    else:
        pos = eje(z=(0, 1, 0), x=(1, 0, 0))
    perfil = model.createIfcCircleProfileDef("AREA", None, None, radio)
    solido = model.createIfcExtrudedAreaSolid(perfil, pos, d3(0, 0, 1), largo)
    return model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solido])


def ubicar(elem, x, y, z, rot_z_grados=0):
    a = math.radians(rot_z_grados)
    mtx = np.array([[math.cos(a), -math.sin(a), 0, x],
                    [math.sin(a), math.cos(a), 0, y],
                    [0, 0, 1, z],
                    [0, 0, 0, 1]], dtype=float)
    api.geometry.edit_object_placement(model, product=elem, matrix=mtx, is_si=True)


contador = {}
secuencia = [0]


def crear(clase, nombre, nivel, rep, x, y, z, material, disciplina, pset_comun=None, extra=None, tipo_predef=None, rot=0):
    contador[nombre] = contador.get(nombre, 0) + 1
    secuencia[0] += 1
    etiqueta = f"{nombre} {contador[nombre]:02d}"
    e = api.root.create_entity(model, ifc_class=clase, name=etiqueta, predefined_type=tipo_predef)
    api.spatial.assign_container(model, relating_structure=nivel, products=[e])
    api.geometry.assign_representation(model, product=e, representation=rep)
    ubicar(e, x, y, z, rot)
    api.material.assign_material(model, products=[e], material=materiales[material])
    if pset_comun:
        nombre_pset, valores = pset_comun
        ps = api.pset.add_pset(model, product=e, name=nombre_pset)
        api.pset.edit_pset(model, pset=ps, properties=valores)
    datos = {
        "Disciplina": disciplina,
        "Codigo": f"{disciplina[:3].upper()}-{secuencia[0]:04d}",
        "Material": material,
        "Nivel": nivel.Name,
        "Estado": "Diseño",
    }
    if extra:
        datos.update(extra)
    ps = api.pset.add_pset(model, product=e, name="Datos_Demo")
    api.pset.edit_pset(model, pset=ps, properties=datos)
    return e


# ------------------------------------------------------------------ edificio
LARGO, ANCHO, ALTURA, ESP_MURO, ESP_LOSA = 12.0, 8.0, 3.2, 0.2, 0.2
niveles = []
for i in range(2):
    nv = api.root.create_entity(model, ifc_class="IfcBuildingStorey", name=f"Nivel {i + 1}")
    nv.Elevation = i * ALTURA
    api.aggregate.assign_object(model, relating_object=edificio, products=[nv])
    niveles.append(nv)

for i, nv in enumerate(niveles):
    z0 = i * ALTURA
    alto_muro = ALTURA - ESP_LOSA

    # Losa de piso
    crear("IfcSlab", "Losa", nv, caja(LARGO, ANCHO, ESP_LOSA), 0, 0, z0, "Hormigón H30", "Estructura",
          ("Pset_SlabCommon", {"IsExternal": False, "LoadBearing": True, "FireRating": "F120"}),
          {"Espesor_m": ESP_LOSA, "Area_m2": LARGO * ANCHO, "Costo_CLP": 4_800_000}, tipo_predef="FLOOR")

    # Muros perimetrales
    for (x, y, w, d, ori) in [(0, 0, LARGO, ESP_MURO, "Sur"), (0, ANCHO - ESP_MURO, LARGO, ESP_MURO, "Norte"),
                              (0, 0, ESP_MURO, ANCHO, "Oeste"), (LARGO - ESP_MURO, 0, ESP_MURO, ANCHO, "Este")]:
        crear("IfcWall", "Muro exterior", nv, caja(w, d, alto_muro), x, y, z0 + ESP_LOSA, "Albañilería ladrillo",
              "Arquitectura", ("Pset_WallCommon", {"IsExternal": True, "LoadBearing": False, "FireRating": "F60"}),
              {"Orientacion": ori, "Largo_m": max(w, d), "Costo_CLP": 1_200_000})

    # Muro interior
    crear("IfcWall", "Muro interior", nv, caja(0.15, ANCHO - 1.4, alto_muro - 0.5), 6.0, 0.7, z0 + ESP_LOSA,
          "Albañilería ladrillo", "Arquitectura",
          ("Pset_WallCommon", {"IsExternal": False, "LoadBearing": False, "FireRating": "F30"}),
          {"Largo_m": ANCHO - 1.4, "Costo_CLP": 650_000})

    # Columnas en las esquinas y al centro de los lados largos
    for (x, y) in [(0.3, 0.3), (5.8, 0.3), (11.3, 0.3), (0.3, 7.3), (5.8, 7.3), (11.3, 7.3)]:
        crear("IfcColumn", "Columna", nv, caja(0.4, 0.4, alto_muro), x, y, z0 + ESP_LOSA, "Hormigón H30", "Estructura",
              ("Pset_ColumnCommon", {"IsExternal": False, "LoadBearing": True}),
              {"Seccion": "40x40 cm", "Costo_CLP": 380_000})

    # Vigas bajo la losa superior (dirección X)
    for y in [0.3, 7.3]:
        crear("IfcBeam", "Viga", nv, caja(LARGO - 0.6, 0.3, 0.5), 0.3, y + 0.05, z0 + ALTURA - 0.5, "Hormigón H30",
              "Estructura", ("Pset_BeamCommon", {"LoadBearing": True}), {"Seccion": "30x50 cm", "Costo_CLP": 900_000})
    crear("IfcBeam", "Viga", nv, caja(0.3, ANCHO - 0.6, 0.5), 5.85, 0.3, z0 + ALTURA - 0.5, "Hormigón H30",
          "Estructura", ("Pset_BeamCommon", {"LoadBearing": True}), {"Seccion": "30x50 cm", "Costo_CLP": 700_000})

    # Puertas
    puertas = [(2.5, -0.02, 0)] if i == 0 else []
    puertas += [(6.0 + 0.195, 3.0, 90)]
    for (x, y, rot) in puertas:
        crear("IfcDoor", "Puerta", nv, caja(0.9, 0.24, 2.1), x, y, z0 + ESP_LOSA, "Madera pino", "Arquitectura",
              ("Pset_DoorCommon", {"IsExternal": i == 0 and rot == 0, "FireRating": "F30"}),
              {"Ancho_m": 0.9, "Alto_m": 2.1, "Costo_CLP": 220_000}, rot=rot)

    # Ventanas en fachada sur y norte
    for x in [1.0, 4.0, 8.0, 10.0]:
        for y in [-0.02, ANCHO - ESP_MURO - 0.02]:
            crear("IfcWindow", "Ventana", nv, caja(1.2, 0.24, 1.2), x, y, z0 + ESP_LOSA + 1.0, "Vidrio templado",
                  "Arquitectura", ("Pset_WindowCommon", {"IsExternal": True}),
                  {"Ancho_m": 1.2, "Alto_m": 1.2, "Costo_CLP": 180_000})

    # Ducto de climatización (bajo las vigas)
    crear("IfcDuctSegment", "Ducto HVAC", nv, caja(9.0, 0.6, 0.35), 0.5, 3.7, z0 + ALTURA - 0.85,
          "Acero galvanizado", "Climatización", None, {"Seccion": "600x350 mm", "Sistema": "Inyección", "Costo_CLP": 950_000})

    # Tuberías de agua fría y caliente
    crear("IfcPipeSegment", "Tubería agua fría", nv, cilindro(0.05, 9.0, "X"), 0.5, 2.0, z0 + ALTURA - 1.1,
          "Cobre", "Sanitaria", None, {"Diametro_mm": 100, "Sistema": "Agua fría", "Costo_CLP": 310_000})
    crear("IfcPipeSegment", "Tubería agua caliente", nv, cilindro(0.04, 9.0, "X"), 0.5, 2.4, z0 + ALTURA - 1.1,
          "Cobre", "Sanitaria", None, {"Diametro_mm": 80, "Sistema": "Agua caliente", "Costo_CLP": 290_000})

# Choque intencional: bajada de aguas lluvia que atraviesa la viga del eje norte del Nivel 1
crear("IfcPipeSegment", "Tubería aguas lluvia", niveles[0], cilindro(0.075, ANCHO - 0.4, "Y"), 3.0, 0.2,
      ALTURA - 0.3, "PVC", "Sanitaria", None,
      {"Diametro_mm": 150, "Sistema": "Aguas lluvia", "Nota": "Choca con Viga (prueba Clash Detective)", "Costo_CLP": 120_000})

# Escalera simple (bloque inclinado aproximado con peldaños)
for k in range(15):
    crear("IfcStairFlight", "Peldaño", niveles[0], caja(1.0, 0.28, 0.2), 9.8, 1.0 + k * 0.28, ESP_LOSA + k * 0.2,
          "Hormigón H30", "Arquitectura", None, {"Huella_m": 0.28, "Contrahuella_m": 0.2, "Costo_CLP": 45_000})

# Cubierta
nv_techo = api.root.create_entity(model, ifc_class="IfcBuildingStorey", name="Nivel 3 Cubierta")
nv_techo.Elevation = 2 * ALTURA
api.aggregate.assign_object(model, relating_object=edificio, products=[nv_techo])
crear("IfcSlab", "Losa cubierta", nv_techo, caja(LARGO, ANCHO, ESP_LOSA), 0, 0, 2 * ALTURA, "Hormigón H30",
      "Estructura", ("Pset_SlabCommon", {"IsExternal": True, "LoadBearing": True}),
      {"Espesor_m": ESP_LOSA, "Area_m2": LARGO * ANCHO, "Costo_CLP": 5_100_000}, tipo_predef="ROOF")

model.write(SALIDA)
total = sum(contador.values())
print(f"Modelo generado: {SALIDA}")
print(f"Elementos: {total}")
for k, v in sorted(contador.items()):
    print(f"  {k:24s} {v}")
