"""Exporta los datos semanticos del modelo para el script de Revit (crear_modelo_revit.py)."""
import json
from model import (build_walls, build_rooms, all_prisms, LV, LEVEL_NAMES, AX_X, AX_Y, SLAB, MATERIALS, HOUSE_Y, LOT_Y,
                   ST_Y_A, ST_Y_B, ST_X_FL, STAIR_ZONE, BALCONIES, RISER, TREAD, strip_top, terrace_top)

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
    data = {"units": "m", "project": "CASA LINTERNA 13x12"}
    data["levels"] = [{"id": L, "name": "NPT {:+.2f} - {}".format(z, LEVEL_NAMES[L]), "elev": z} for L, z in LV.items() if L <= 3]
    data["grids"] = ([{"name": k, "p1": [x, -2.5], "p2": [x, LOT_Y + 1.5]} for k, x in AX_X.items()] +
                     [{"name": k, "p1": [-2.5, y], "p2": [14.5, y]} for k, y in AX_Y.items()])
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
    outer = [[0, 0], [12, 0], [12, HOUSE_Y], [0, HOUSE_Y]]
    data["floors"] = [
        {"name": "CONTRAPISO 1er PISO", "level": 1, "offset": 0.0, "t": 0.10, "loops": [outer]},
        {"name": "LOSA FRANJA LIBRE (COCHERA / REUNIONES)", "level": 1, "offset": -0.05, "t": 0.10,
         "loops": [[[0, HOUSE_Y], [12, HOUSE_Y], [12, LOT_Y], [0, LOT_Y]]]},
        {"name": "LOSA ALIGERADA 2do PISO", "level": 2, "offset": 0.0, "t": SLAB, "loops": [outer, hole]},
        {"name": "LOSA TERRAZA", "level": 3, "offset": 0.0, "t": SLAB, "loops": [outer, hole]},
    ] + [{"name": "BALCON 2do PISO", "level": 2, "offset": 0.0, "t": SLAB,
          "loops": [[[bx1, HOUSE_Y], [bx2, HOUSE_Y], [bx2, HOUSE_Y + 1.0], [bx1, HOUSE_Y + 1.0]]]} for bx1, bx2 in BALCONIES]
    data["roofs"] = [
        {"name": "COBERTURA FRANJA LIBRE TR4", "level": 1, "x1": 0.0, "x2": 12.0, "t": 0.05,
         "profile_yz": [[8.10, strip_top(8.10)], [12.95, strip_top(12.95)]], "slope_pct": 10},
        {"name": "COBERTURA TERRAZA TR4", "level": 3, "x1": 0.0, "x2": 12.0, "t": 0.05,
         "profile_yz": [[0.05, terrace_top(0.05)], [7.95, terrace_top(7.95)]], "slope_pct": 5},
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
        {"level": 1, "a": [0.0, HOUSE_Y], "b": [12.0, HOUSE_Y]},          # vivienda / franja libre (sin muro en los vanos)
        {"level": 1, "a": [7.80, 0.15], "b": [7.80, 7.85]},               # sala / comedor
        {"level": 1, "a": [9.90, 0.15], "b": [9.90, 7.85]},               # comedor / cocina
        {"level": 1, "a": [4.10, 2.00], "b": [4.10, 7.85]},               # vestibulo / sala
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
    # look +1 en plano x: mira hacia el fondo (u = -y); en plano y: mira hacia la medianera (u = x)
    data["sections"] = [
        {"name": "CORTE A-A", "plane": "x", "c": 6.00, "look": 1, "umin": -13.6, "umax": 1.6, "far": 6.0},
        {"name": "CORTE B-B", "plane": "x", "c": 1.70, "look": 1, "umin": -13.6, "umax": 1.6, "far": 10.3},
        {"name": "CORTE C-C", "plane": "y", "c": 5.20, "look": 1, "umin": -1.6, "umax": 12.3, "far": 5.2},
        {"name": "CORTE D-D", "plane": "y", "c": 1.70, "look": 1, "umin": -1.6, "umax": 12.3, "far": 1.7},
        {"name": "ELEVACION PRINCIPAL (CALLE)", "plane": "x", "c": -3.0, "look": 1, "umin": -13.6, "umax": 1.6, "far": 15.0},
        {"name": "ELEVACION HACIA LA FRANJA", "plane": "y", "c": 16.0, "look": -1, "umin": -0.3, "umax": 12.3, "far": 16.0},
    ]
    data["sheets"] = [
        {"number": "A-01", "name": "PLANTA 1er PISO", "views": ["PLANTA NPT +0.00"]},
        {"number": "A-02", "name": "PLANTA 2do PISO", "views": ["PLANTA NPT +2.80"]},
        {"number": "A-03", "name": "PLANTA DE TERRAZA", "views": ["PLANTA NPT +5.60"]},
        {"number": "A-05", "name": "CORTES TRANSVERSALES", "views": ["CORTE A-A", "CORTE B-B"]},
        {"number": "A-06", "name": "CORTES LONGITUDINALES", "views": ["CORTE C-C", "CORTE D-D"]},
        {"number": "A-07", "name": "ELEVACIONES", "views": ["ELEVACION PRINCIPAL (CALLE)", "ELEVACION HACIA LA FRANJA"]},
        {"number": "A-08", "name": "VISTA 3D", "views": ["3D CASA LINTERNA"]},
    ]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print("Revit JSON:", path, len(walls), "muros", len(ds), "directshapes")


if __name__ == "__main__":
    import sys
    export(sys.argv[1])
