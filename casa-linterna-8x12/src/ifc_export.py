"""Exporta el modelo BIM a IFC4 (abre en Revit, ArchiCAD, Tekla, BIMcollab, BlenderBIM...)."""
import uuid
from collections import OrderedDict
import ifcopenshell
import ifcopenshell.api.root as root
import ifcopenshell.api.unit as unit
import ifcopenshell.api.context as context
import ifcopenshell.api.project as project
import ifcopenshell.api.aggregate as aggregate
import ifcopenshell.api.spatial as spatial
import ifcopenshell.api.geometry as geometry
import ifcopenshell.api.material as material
import ifcopenshell.api.style as style
import ifcopenshell.api.pset as pset
from model import all_prisms, build_rooms, MATERIALS, LV, LEVEL_NAMES, SLAB

CLASS = {
    "muro": ("IfcWall", None), "losa": ("IfcSlab", "FLOOR"), "columna": ("IfcColumn", "COLUMN"),
    "viga": ("IfcBeam", "BEAM"), "escalera": ("IfcStairFlight", "STRAIGHT"), "ventana": ("IfcWindow", "WINDOW"),
    "puerta": ("IfcDoor", "DOOR"), "baranda": ("IfcRailing", "GUARDRAIL"), "cobertura": ("IfcPlate", "SHEET"),
    "correa": ("IfcMember", "PURLIN"), "viga_met": ("IfcBeam", "BEAM"), "columna_met": ("IfcColumn", "COLUMN"),
    "canaleta": ("IfcBuildingElementProxy", None), "bajante": ("IfcPipeSegment", "RIGIDSEGMENT"),
    "celosia": ("IfcShadingDevice", "LOUVER"), "fachada": ("IfcBuildingElementProxy", None),
    "muro_cortina": ("IfcPlate", "CURTAIN_PANEL"), "mobiliario": ("IfcFurniture", None),
    "jardin": ("IfcGeographicElement", "TERRAIN"), "cimentacion": ("IfcFooting", "STRIP_FOOTING"),
    "lucernario": ("IfcWindow", "SKYLIGHT"), "pedestal": ("IfcColumn", "COLUMN"), "instalaciones": ("IfcTank", "STORAGE"),
    "vehiculo": ("IfcBuildingElementProxy", None),
}
MAT_NAME = {
    "muro_blanco": "Albañilería KK tarrajeada - pintura blanca", "muro_gris": "Albañilería KK - medianera",
    "muro_int": "Albañilería KK tarrajeada - interior", "concreto": "Concreto armado f'c=210 kg/cm2",
    "concreto_visto": "Concreto caravista", "cimiento": "Concreto ciclópeo 1:10 + 30% PG",
    "vidrio": "Vidrio templado 8 mm", "aluminio": "Aluminio anodizado negro", "madera": "Aluminio acabado madera / madera tornillo",
    "madera_osc": "Madera cedro", "acero": "Acero ASTM A500 Gr.B (LAC)", "acero_galv": "Acero galvanizado",
    "panel_tr4": "Panel termoacústico TR4 50 mm", "policarbonato": "Policarbonato alveolar 10 mm",
    "celosia_met": "Plancha perforada acero", "piso_int": "Porcelanato", "piso_ext": "Porcelanato antideslizante",
    "vereda": "Concreto f'c=175 vereda", "verde": "Vegetación", "canto_rodado": "Canto rodado", "tanque": "Polietileno",
    "tela": "Tapiz", "cuarzo": "Cuarzo", "blanco": "Esmalte blanco",
}


def _rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def export(path):
    f = project.create_file(version="IFC4")
    proj = root.create_entity(f, ifc_class="IfcProject", name="CASA LINTERNA 13x12")
    unit.assign_unit(f)                                   # metros
    model_ctx = context.add_context(f, context_type="Model")
    body = context.add_context(f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model_ctx)
    site = root.create_entity(f, ifc_class="IfcSite", name="Lote 13.00 x 12.00")
    bldg = root.create_entity(f, ifc_class="IfcBuilding", name="Vivienda unifamiliar - Casa Linterna")
    aggregate.assign_object(f, products=[site], relating_object=proj)
    aggregate.assign_object(f, products=[bldg], relating_object=site)
    world = f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0)))
    origin_pl = f.createIfcLocalPlacement(None, world)
    for e in (site, bldg):
        e.ObjectPlacement = origin_pl
    storeys = {}
    for L, z in LV.items():
        st = root.create_entity(f, ifc_class="IfcBuildingStorey", name=f"NPT {z:+.2f} - {LEVEL_NAMES[L]}")
        st.Elevation = z
        st.ObjectPlacement = f.createIfcLocalPlacement(origin_pl, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(z)))))
        storeys[L] = st
    aggregate.assign_object(f, products=list(storeys.values()), relating_object=bldg)

    # estilos y materiales
    styles, mats = {}, {}
    for k, (hexc, op) in MATERIALS.items():
        s = style.add_style(f, name=k)
        style.add_surface_style(f, style=s, ifc_class="IfcSurfaceStyleShading",
                                attributes={"SurfaceColour": {"Name": None, "Red": _rgb(hexc)[0], "Green": _rgb(hexc)[1], "Blue": _rgb(hexc)[2]},
                                            "Transparency": round(1.0 - op, 2)})
        styles[k] = s
        mats[k] = material.add_material(f, name=MAT_NAME.get(k, k), category=k)

    # agrupar prismas en elementos
    groups = OrderedDict()
    for p in all_prisms():
        key = (p.level, p.cat, p.group or f"{p.name}#{id(p)}")
        groups.setdefault(key, []).append(p)

    def solid(p):
        prof = f.createIfcArbitraryClosedProfileDef("AREA", None,
                                                   f.createIfcPolyline([f.createIfcCartesianPoint((float(y), float(z))) for y, z in p.poly + [p.poly[0]]]))
        pos = f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((float(p.x1), 0.0, 0.0)),
                                          f.createIfcDirection((1.0, 0.0, 0.0)), f.createIfcDirection((0.0, 1.0, 0.0)))
        return f.createIfcExtrudedAreaSolid(prof, pos, f.createIfcDirection((0.0, 0.0, 1.0)), float(p.x2 - p.x1))

    count = {}
    by_storey = {L: [] for L in storeys}
    for (L, cat, gid), ps in groups.items():
        cls, ptype = CLASS.get(cat, ("IfcBuildingElementProxy", None))
        if cat == "losa" and ps[0].name.startswith(("CONTRAPISO", "PISO", "VEREDA")):
            ptype = "BASESLAB"
        if cat == "losa" and ps[0].name.startswith("TECHO"):
            ptype = "ROOF"
        if cat == "escalera" and "DESC" in ps[0].name:
            cls, ptype = "IfcSlab", "LANDING"
        name = ps[0].name or cat
        el = root.create_entity(f, ifc_class=cls, name=name, predefined_type=ptype)
        el.ObjectPlacement = origin_pl
        rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid(p) for p in ps])
        geometry.assign_representation(f, product=el, representation=rep)
        main = max(ps, key=lambda q: (q.x2 - q.x1) * (max(a for a, _ in q.poly) - min(a for a, _ in q.poly)))
        style.assign_representation_styles(f, shape_representation=rep, styles=[styles[main.mat]])
        material.assign_material(f, products=[el], type="IfcMaterial", material=mats[main.mat])
        ps_ = pset.add_pset(f, product=el, name="Pset_CasaLinterna")
        pset.edit_pset(f, pset=ps_, properties={"Fase": "Fase 1 (2 pisos)" if ps[0].phase == "F1" else "Fase 2 - proyeccion 3er piso",
                                                "Categoria": cat, "Material": MAT_NAME.get(main.mat, main.mat), "Nivel": LEVEL_NAMES[L]})
        if cls == "IfcWall":
            pc = pset.add_pset(f, product=el, name="Pset_WallCommon")
            pset.edit_pset(f, pset=pc, properties={"IsExternal": main.mat in ("muro_blanco", "muro_gris"),
                                                   "LoadBearing": True})
        by_storey[L].append(el)
        count[cls] = count.get(cls, 0) + 1
    for L, els in by_storey.items():
        if els:
            spatial.assign_container(f, products=els, relating_structure=storeys[L])

    # espacios (ambientes)
    spaces = {L: [] for L in storeys}
    for r in build_rooms():
        x1, y1, x2, y2 = r.rect
        z0 = LV[r.level]
        h = (LV[r.level + 1] - SLAB - z0) if r.level < 4 else 2.40
        sp = root.create_entity(f, ifc_class="IfcSpace", name=r.name, predefined_type="INTERNAL")
        sp.LongName = r.name
        sp.ObjectPlacement = origin_pl
        prof = f.createIfcArbitraryClosedProfileDef("AREA", None, f.createIfcPolyline(
            [f.createIfcCartesianPoint(p) for p in ((x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1))]))
        sol = f.createIfcExtrudedAreaSolid(prof, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(z0)))),
                                           f.createIfcDirection((0.0, 0.0, 1.0)), float(h))
        geometry.assign_representation(f, product=sp, representation=f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [sol]))
        q = pset.add_pset(f, product=sp, name="Pset_SpaceCommon")
        pset.edit_pset(f, pset=q, properties={"Reference": r.name, "IsExternal": r.name.startswith("TERRAZA") or r.name == "AZOTEA"})
        q2 = pset.add_pset(f, product=sp, name="Pset_CasaLinterna")
        pset.edit_pset(f, pset=q2, properties={"Area_m2": round(r.area, 2), "AcabadoPiso": r.finish})
        spaces[r.level].append(sp)
    for L, sps in spaces.items():
        if sps:
            aggregate.assign_object(f, products=sps, relating_object=storeys[L])
    f.write(path)
    print("IFC:", path, count)
    return path


if __name__ == "__main__":
    import sys
    export(sys.argv[1])
