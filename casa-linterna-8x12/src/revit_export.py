"""Exporta los datos semanticos del modelo para el script de Revit (crear_modelo_revit.py)."""
import json
from model import (build_walls, build_rooms, all_prisms, LV, LEVEL_NAMES, AX_X, AX_Y, SLAB, MATERIALS, Y0, YB, LOT_X, LOT_Y,
                   ST_Y_A, ST_Y_B, ST_X_FL, STAIR_ZONE, WELL, BALCONIES, BAL_D, STRIP_COL_Y, RISER, TREAD, strip_top, terrace_top)

NATIVE_CATS = {"muro", "losa", "escalera", "ventana", "puerta"}
DS_CAT = {
    "columna": "OST_StructuralColumns", "viga": "OST_StructuralFraming", "viga_met": "OST_StructuralFraming",
    "correa": "OST_StructuralFraming", "columna_met": "OST_StructuralColumns", "cimentacion": "OST_StructuralFoundation",
    "mobiliario": "OST_Furniture", "jardin": "OST_Planting", "fachada": "OST_GenericModel", "celosia": "OST_GenericModel",
    "muro_cortina": "OST_GenericModel", "canaleta": "OST_GenericModel", "bajante": "OST_GenericModel",
    "baranda": "OST_GenericModel", "lucernario": "OST_GenericModel", "instalaciones": "OST_GenericModel",
    "cobertura": "OST_GenericModel", "pedestal": "OST_StructuralColumns", "vehiculo": "OST_Entourage",
}


def export(path):
    data = {"units": "m", "project": "CASA LINTERNA 8x17"}
    data["levels"] = [{"id": L, "name": "NPT {:+.2f} - {}".format(z, LEVEL_NAMES[L]), "elev": z} for L, z in LV.items() if L <= 3]
    data["grids"] = ([{"name": k, "p1": [x, -2.5], "p2": [x, LOT_Y + 1.5]} for k, x in AX_X.items()] +
                     [{"name": k, "p1": [-2.5, y], "p2": [LOT_X + 1.5, y]} for k, y in [("0", STRIP_COL_Y)] + list(AX_Y.items())])
    walls = []
    for i, w in enumerate(build_walls()):
        rec = {"id": i, "name": w.name, "level": w.level, "a": list(w.a), "b": list(w.b), "t": w.t,
               "base_offset": round(w.base() - LV[w.level], 4), "height": round(w.height(), 4), "kind": w.kind,
               "phase": "F1",
               "openings": [{"tag": o.name, "kind": o.kind, "s1": o.s1, "s2": o.s2, "sill": o.sill, "head": o.head,
                             "hinge": o.hinge, "side": o.side, "desc": o.desc} for o in w.openings]}
        if w.top_poly:
            rec["profile_yz"] = [[y, z] for (y, z) in w.top_poly]
        walls.append(rec)
    data["walls"] = walls
    x1, y1, x2, y2 = STAIR_ZONE
    hole = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    wx1, wy1, wx2, wy2 = WELL
    well = [[wx1, wy1], [wx2, wy1], [wx2, wy2], [wx1, wy2]]
    outer = [[0, Y0], [LOT_X, Y0], [LOT_X, YB], [0, YB]]
    data["floors"] = [
        {"name": "CONTRAPISO 1er PISO", "level": 1, "offset": 0.0, "t": 0.10, "loops": [outer]},
        {"name": "LOSA COCHERA", "level": 1, "offset": -0.05, "t": 0.10, "loops": [[[0, 0], [LOT_X, 0], [LOT_X, Y0], [0, Y0]]]},
        {"name": "PISO PATIO DE SERVICIO", "level": 1, "offset": -0.02, "t": 0.10,
         "loops": [[[0.15, YB], [7.85, YB], [7.85, 16.85], [0.15, 16.85]]]},
        {"name": "LOSA ALIGERADA 2do PISO", "level": 2, "offset": 0.0, "t": SLAB, "loops": [outer, hole, well]},
        {"name": "LOSA TERRAZA", "level": 3, "offset": 0.0, "t": SLAB, "loops": [outer, hole, well]},
    ] + [{"name": "BALCON 2do PISO", "level": 2, "offset": 0.0, "t": SLAB,
          "loops": [[[bx1, Y0 - BAL_D], [bx2, Y0 - BAL_D], [bx2, Y0], [bx1, Y0]]]} for bx1, bx2 in BALCONIES]
    data["roofs"] = [
        {"name": "COBERTURA COCHERA TR4", "level": 1, "x1": 0.0, "x2": LOT_X, "t": 0.05,
         "profile_yz": [[0.05, strip_top(0.05)], [4.95, strip_top(4.95)]], "slope_pct": 10},
        {"name": "COBERTURA TERRAZA TR4", "level": 3, "x1": 0.0, "x2": LOT_X, "t": 0.05,
         "profile_yz": [[Y0 + 0.05, terrace_top(Y0 + 0.05)], [YB - 0.05, terrace_top(YB - 0.05)]], "slope_pct": 5},
    ]
    stairs = []
    ya, yb = sum(ST_Y_A) / 2, sum(ST_Y_B) / 2
    for s in (1, 2):
        stairs.append({"base_level": s, "top_level": s + 1, "phase": "F1",
                       "run1": [[ST_X_FL[1], ya], [ST_X_FL[0], ya]], "run2": [[ST_X_FL[0], yb], [ST_X_FL[1], yb]],
                       "width": 1.00, "risers": 16, "riser": RISER, "tread": TREAD})
    data["stairs"] = stairs
    rooms = []
    for n, r in enumerate(build_rooms()):
        x1, y1, x2, y2 = r.rect
        rooms.append({"level": r.level, "name": r.name, "number": "{}{:02d}".format(r.level, n + 1),
                      "pt": [(x1 + x2) / 2, (y1 + y2) / 2], "area": round(r.area, 2), "finish": r.finish})
    data["rooms"] = rooms
    data["room_separations"] = [
        {"level": 1, "a": [0.0, Y0], "b": [LOT_X, Y0]},                   # cochera / vivienda
        {"level": 1, "a": [4.40, 5.15], "b": [4.40, 8.60]},               # sala / comedor
        {"level": 1, "a": [2.90, 8.65], "b": [6.00, 8.65]},               # sala-comedor / hall
        {"level": 2, "a": [2.90, 8.70], "b": [2.90, 10.95]},              # hall / escalera
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
        if p.cat == "cobertura":
            rec["fallback_only"] = True          # el techo nativo reemplaza al panel
        ds.append(rec)
    data["directshapes"] = ds
    data["materials"] = {k: {"rgb": [int(v[0][i:i + 2], 16) for i in (1, 3, 5)], "transparency": int(round((1 - v[1]) * 100))}
                         for k, v in MATERIALS.items()}
    # plano x: look -1 mira hacia -x (u = y, calle a la izquierda); plano y: look +1 mira al fondo (u = x)
    data["sections"] = [
        {"name": "CORTE A-A", "plane": "x", "c": 5.20, "look": -1, "umin": -1.6, "umax": 17.4, "far": 5.2},
        {"name": "CORTE B-B", "plane": "x", "c": 1.70, "look": -1, "umin": -1.6, "umax": 17.4, "far": 1.7},
        {"name": "CORTE C-C", "plane": "y", "c": 6.40, "look": -1, "umin": -0.4, "umax": 8.4, "far": 7.6},
        {"name": "CORTE D-D", "plane": "y", "c": 9.90, "look": 1, "umin": -0.4, "umax": 8.4, "far": 7.1},
        {"name": "ELEVACION PRINCIPAL (CALLE)", "plane": "y", "c": -3.0, "look": 1, "umin": -0.4, "umax": 8.4, "far": 20.0},
        {"name": "ELEVACION POSTERIOR (PATIO)", "plane": "y", "c": 16.8, "look": -1, "umin": -0.4, "umax": 8.4, "far": 3.0},
    ]
    data["sheets"] = [
        {"number": "A-01", "name": "PLANTA 1er PISO", "views": ["PLANTA NPT +0.00"]},
        {"number": "A-02", "name": "PLANTA 2do PISO", "views": ["PLANTA NPT +2.80"]},
        {"number": "A-03", "name": "PLANTA DE TERRAZA", "views": ["PLANTA NPT +5.60"]},
        {"number": "A-05", "name": "CORTES LONGITUDINALES", "views": ["CORTE A-A", "CORTE B-B"]},
        {"number": "A-06", "name": "CORTES TRANSVERSALES Y ELEVACIONES",
         "views": ["CORTE C-C", "CORTE D-D", "ELEVACION PRINCIPAL (CALLE)", "ELEVACION POSTERIOR (PATIO)"]},
        {"number": "A-08", "name": "VISTA 3D", "views": ["3D CASA LINTERNA"]},
    ]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print("Revit JSON:", path, len(walls), "muros", len(ds), "directshapes")


if __name__ == "__main__":
    import sys
    export(sys.argv[1])
