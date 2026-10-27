"""Exporta los datos semanticos del modelo para el script de Revit (crear_modelo_revit.py)."""
import json
from model import (build_walls, build_rooms, all_prisms, LV, LEVEL_NAMES, AX_X, AX_Y, SLAB, MATERIALS,
                   ST_X_A, ST_X_B, ST_Y_FL, RISER, TREAD, roof_top)

NATIVE_CATS = {"muro", "losa", "escalera", "ventana", "puerta"}
DS_CAT = {
    "columna": "OST_StructuralColumns", "viga": "OST_StructuralFraming", "viga_met": "OST_StructuralFraming",
    "correa": "OST_StructuralFraming", "columna_met": "OST_StructuralColumns", "cimentacion": "OST_StructuralFoundation",
    "mobiliario": "OST_Furniture", "jardin": "OST_Planting", "fachada": "OST_GenericModel", "celosia": "OST_GenericModel",
    "muro_cortina": "OST_GenericModel", "canaleta": "OST_GenericModel", "bajante": "OST_GenericModel",
    "baranda": "OST_GenericModel", "lucernario": "OST_GenericModel", "instalaciones": "OST_GenericModel",
    "cobertura": "OST_GenericModel",
}


def export(path):
    data = {"units": "m", "project": "CASA LINTERNA 8x12"}
    data["levels"] = [{"id": L, "name": "NPT {:+.2f} - {}".format(z, LEVEL_NAMES[L]), "elev": z} for L, z in LV.items()]
    data["grids"] = ([{"name": k, "p1": [x, -2.5], "p2": [x, 12.8]} for k, x in AX_X.items()] +
                     [{"name": k, "p1": [-2.5, y], "p2": [8.6, y]} for k, y in AX_Y.items()] +
                     [{"name": "D", "p1": [-2.5, 11.525], "p2": [8.6, 11.525]}])
    walls = []
    for i, w in enumerate(build_walls()):
        rec = {"id": i, "name": w.name, "level": w.level, "a": list(w.a), "b": list(w.b), "t": w.t,
               "base_offset": round(w.base() - LV[w.level], 4), "height": round(w.height(), 4), "kind": w.kind,
               "phase": "F2" if (w.level >= 3 and not w.name.startswith("C-")) else "F1",
               "openings": [{"tag": o.name, "kind": o.kind, "s1": o.s1, "s2": o.s2, "sill": o.sill, "head": o.head,
                             "hinge": o.hinge, "side": o.side, "desc": o.desc} for o in w.openings]}
        if w.top_poly:
            rec["profile_yz"] = [[y, z] for (y, z) in w.top_poly]
        walls.append(rec)
    data["walls"] = walls
    well = [[0.25, 0.25], [2.15, 0.25], [2.15, 3.00], [0.25, 3.00]]
    data["floors"] = [
        {"name": "CONTRAPISO 1er PISO", "level": 1, "offset": 0.0, "t": 0.10, "loops": [[[0, 0], [8, 0], [8, 7], [0, 7]]]},
        {"name": "PISO TERRAZA", "level": 1, "offset": -0.02, "t": 0.10, "loops": [[[0.25, 7], [7.75, 7], [7.75, 11.75], [0.25, 11.75]]]},
        {"name": "LOSA ALIGERADA 2do PISO", "level": 2, "offset": 0.0, "t": SLAB, "loops": [[[0, 0], [8, 0], [8, 7], [0, 7]], well]},
        {"name": "LOSA ALIGERADA 3er PISO", "level": 3, "offset": 0.0, "t": SLAB, "loops": [[[0, 0], [8, 0], [8, 7], [0, 7]], well]},
        {"name": "LOSA AZOTEA", "level": 4, "offset": 0.0, "t": SLAB, "phase": "F2", "loops": [[[0, 0], [8, 0], [8, 7], [0, 7]], well]},
        {"name": "TECHO CASETA", "level": 4, "offset": 2.60, "t": SLAB, "phase": "F2", "loops": [[[0, 3.0], [2.35, 3.0], [2.35, 5.25], [0, 5.25]]]},
        {"name": "VOLADO MARCO", "level": 2, "offset": 0.0, "t": SLAB, "loops": [[[2.15, -0.5], [8.0, -0.5], [8.0, 0.0], [2.15, 0.0]]]},
    ]
    data["roofs"] = [{"name": "COBERTURA TR4 + POLICARBONATO", "x1": 0.0, "x2": 8.0, "t": 0.05,
                      "profile_yz": [[7.12, roof_top(7.12)], [12.0, roof_top(12.0)]], "slope_pct": 10}]
    stairs = []
    for s in (1, 2, 3):
        xa, xb = sum(ST_X_A) / 2, sum(ST_X_B) / 2
        stairs.append({"base_level": s, "top_level": s + 1, "phase": "F2" if s >= 3 else "F1",
                       "run1": [[xa, ST_Y_FL[1]], [xa, ST_Y_FL[0]]], "run2": [[xb, ST_Y_FL[0]], [xb, ST_Y_FL[1]]],
                       "width": 0.90, "risers": 16, "riser": RISER, "tread": TREAD})
    data["stairs"] = stairs
    rooms = []
    for n, r in enumerate(build_rooms()):
        x1, y1, x2, y2 = r.rect
        rooms.append({"level": r.level, "name": r.name, "number": "{}{:02d}".format(r.level, n + 1),
                      "pt": [(x1 + x2) / 2, (y1 + y2) / 2], "area": round(r.area, 2), "finish": r.finish})
    data["rooms"] = rooms
    data["room_separations"] = [
        {"level": 1, "a": [2.30, 3.975], "b": [7.75, 3.975]}, {"level": 1, "a": [5.00, 4.05], "b": [5.00, 6.75]},
        {"level": 1, "a": [2.225, 3.10], "b": [2.225, 5.10]}, {"level": 1, "a": [0.25, 3.10], "b": [1.25, 3.10]},
        {"level": 1, "a": [0.25, 1.25], "b": [1.20, 1.25]}, {"level": 1, "a": [0.25, 7.0], "b": [7.75, 7.0]},
        {"level": 2, "a": [0.25, 3.00], "b": [2.15, 3.00]}, {"level": 3, "a": [0.25, 3.00], "b": [2.15, 3.00]},
        {"level": 4, "a": [0.25, 3.00], "b": [2.15, 3.00]},
    ]
    ds = []
    for p in all_prisms():
        if p.cat in NATIVE_CATS and not p.cat == "escalera":
            continue
        rec = {"name": p.name, "cat": DS_CAT.get(p.cat, "OST_GenericModel"), "bim_cat": p.cat, "mat": p.mat,
               "x1": round(p.x1, 4), "x2": round(p.x2, 4), "poly": [[round(y, 4), round(z, 4)] for y, z in p.poly],
               "level": p.level, "phase": p.phase}
        if p.cat == "escalera":
            rec["fallback_only"] = True          # solo si falla la escalera nativa
        if p.cat == "cobertura" and p.mat == "panel_tr4":
            rec["fallback_only"] = True          # el techo nativo reemplaza al panel
        ds.append(rec)
    data["directshapes"] = ds
    data["materials"] = {k: {"rgb": [int(v[0][i:i + 2], 16) for i in (1, 3, 5)], "transparency": int(round((1 - v[1]) * 100))}
                         for k, v in MATERIALS.items()}
    data["sections"] = [
        {"name": "CORTE A-A", "plane": "x", "c": 1.70, "look": -1, "umin": -1.3, "umax": 12.2, "far": 1.7},
        {"name": "CORTE B-B", "plane": "x", "c": 4.00, "look": -1, "umin": -1.3, "umax": 12.2, "far": 4.0},
        {"name": "CORTE C-C", "plane": "y", "c": 2.00, "look": 1, "umin": -0.3, "umax": 8.3, "far": 10.0},
        {"name": "CORTE D-D", "plane": "y", "c": 9.40, "look": -1, "umin": -0.3, "umax": 8.3, "far": 9.4},
        {"name": "ELEVACION PRINCIPAL", "plane": "y", "c": -2.0, "look": 1, "umin": -0.3, "umax": 8.3, "far": 15.0},
        {"name": "ELEVACION POSTERIOR", "plane": "y", "c": 12.5, "look": -1, "umin": -0.3, "umax": 8.3, "far": 15.0},
    ]
    data["sheets"] = [
        {"number": "A-01", "name": "PLANTAS 1er Y 2do PISO", "views": ["PLANTA NPT +0.00", "PLANTA NPT +2.80"]},
        {"number": "A-02", "name": "PLANTA 3er PISO Y TECHOS", "views": ["PLANTA NPT +5.60", "PLANTA NPT +8.40"]},
        {"number": "A-03", "name": "CORTES LONGITUDINALES", "views": ["CORTE A-A", "CORTE B-B"]},
        {"number": "A-04", "name": "CORTES TRANSVERSALES", "views": ["CORTE C-C", "CORTE D-D"]},
        {"number": "A-05", "name": "ELEVACIONES", "views": ["ELEVACION PRINCIPAL", "ELEVACION POSTERIOR"]},
        {"number": "A-06", "name": "VISTA 3D", "views": ["3D CASA LINTERNA"]},
    ]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print("Revit JSON:", path, len(walls), "muros", len(ds), "directshapes")


if __name__ == "__main__":
    import sys
    export(sys.argv[1])
