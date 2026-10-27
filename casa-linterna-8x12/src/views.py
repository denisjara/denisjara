"""Generacion de vistas 2D (plantas, cortes, elevaciones) desde el modelo."""
import math
from shapely.geometry import Polygon, box as sbox, LineString, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from model import (build_walls, build_rooms, all_prisms, LV, AX_X, AX_Y, AX_COCHERA, ST_X_A, ST_X_B, ST_Y_FL,
                   ST_Y_LAND, TREAD, CORE, WELL, YB, carport_top, terrace_top, LEVEL_NAMES, LOT_W)
from drawing import Drawing

_CACHE = {}


def prisms_of(cat):
    if "all" not in _CACHE:
        _CACHE["all"] = all_prisms()
    return [p for p in _CACHE["all"] if p.cat == cat]


def columns():
    """Rectangulos de columnas de concreto en planta (sin duplicar por nivel)."""
    out = {}
    for p in prisms_of("columna"):
        y1, y2, z1, z2 = p.yz_bounds()
        out[p.name] = (p.x1, y1, p.x2, y2)
    return list(out.values())


def geoms(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, (MultiPolygon, GeometryCollection)):
        out = []
        for gg in g.geoms:
            out += geoms(gg)
        return out
    return []


def draw_shapely(d, g, layer, fill=None, hatch=None, lw=None, edge=True, alpha=1.0):
    for pg in geoms(g):
        if pg.area < 1e-6:
            continue
        d.poly(list(pg.exterior.coords)[:-1], layer, fill=fill, hatch=hatch, lw=lw, edge=edge, alpha=alpha)
        for hole in pg.interiors:
            d.poly(list(hole.coords)[:-1], layer, fill="#ffffff", lw=lw, edge=edge)


def rect(d, x1, y1, x2, y2, layer, **kw):
    d.pline([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], layer, closed=True, **kw)


def mins(d, name, pos, rot=0.0, sx=1.0, sy=1.0):
    """Inserta un bloque y su simetrico respecto a x = 4.00 (planta espejada)."""
    d.insert(name, pos, rot, sx, sy)
    d.insert(name, (LOT_W - pos[0], pos[1]), -rot, -sx, sy)


# ---------------------------------------------------------------------------
# PLANTAS
# ---------------------------------------------------------------------------
def opening_symbol(d, w, o):
    t = w.t
    width = o.s2 - o.s1
    if w.horizontal:
        yc = w.a[1]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hx = o.s1 if o.hinge == "a" else o.s2
            sx = 1 if o.hinge == "a" else -1
            d.insert(name, (hx, yc), 0, sx, 1 if o.side > 0 else -1, {"TAG": o.name})
        elif o.kind == "slide":
            d.insert(f"CORREDIZA_{width:.2f}_{t:.2f}", (o.s1, yc), 0, 1, 1, {"TAG": o.name})
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (o.s1, yc), 0, 1, 1, {"TAG": o.name})
        off = 0.38 if o.kind == "window" else -0.38
        tag_pos = ((o.s1 + o.s2) / 2, yc - off if yc < 6 else yc + off)
    else:
        xc = w.a[0]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hy = o.s1 if o.hinge == "a" else o.s2
            if o.side > 0:
                d.insert(name, (xc, hy), -90, -1 if o.hinge == "a" else 1, 1, {"TAG": o.name})
            else:
                d.insert(name, (xc, hy), 90, 1 if o.hinge == "a" else -1, 1, {"TAG": o.name})
        elif o.kind == "slide":
            d.insert(f"CORREDIZA_{width:.2f}_{t:.2f}", (xc, o.s1), 90, 1, 1, {"TAG": o.name})
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (xc, o.s1), 90, 1, 1, {"TAG": o.name})
        side = o.side if o.side else 1
        tag_pos = (xc + 0.30 * side, (o.s1 + o.s2) / 2)
    d.text(tag_pos, o.name, 1.5, "A-TEXTO-AREA", bold=True)


def stair_plan(d, level):
    xa1, xa2 = ST_X_A
    xb1, xb2 = ST_X_B
    y0, y1 = ST_Y_FL
    yl0, yl1 = ST_Y_LAND
    brk = 7.05
    up = level <= 2
    down = level >= 2
    for i in range(8):
        y = y0 + i * TREAD
        d.line((xb1, y), (xb2, y), "A-ESCALERA" if down else "A-PROYECCION")
    rect(d, xb1, y0, xb2, y1, "A-ESCALERA" if down else "A-PROYECCION")
    if up:
        for i in range(8):
            y = y1 - i * TREAD
            d.line((xa1, y), (xa2, y), "A-ESCALERA" if y >= brk else "A-PROYECCION")
        d.line((xa1, brk), (xa1, y1), "A-ESCALERA")
        d.line((xa2, brk), (xa2, y1), "A-ESCALERA")
        d.line((xa1, y0), (xa1, brk), "A-PROYECCION")
        d.line((xa2, y0), (xa2, brk), "A-PROYECCION")
        d.pline([(xa1, brk - 0.10), (xa2, brk + 0.10)], "A-ESCALERA", lw=0.25)
        xm = (xa1 + xa2) / 2
        d.pline([(xm, y1 - 0.05), (xm, yl0 + 0.30)], "A-ESCALERA")
        d.pline([(xm - 0.08, yl0 + 0.45), (xm, yl0 + 0.30), (xm + 0.08, yl0 + 0.45)], "A-ESCALERA")
        d.circle((xm, y1 - 0.05), 0.04, "A-ESCALERA", fill="#333333")
        d.text((xm + 0.28, 7.20), "SUBE", 1.4, "A-TEXTO", rot=90)
    rect(d, CORE[0], yl0, CORE[1], yl1, "A-ESCALERA" if (down and not up) else "A-PROYECCION")
    if down:
        xm = (xb1 + xb2) / 2
        d.pline([(xm, y1 - 0.05), (xm, y0 + 0.10)], "A-ESCALERA")
        d.pline([(xm - 0.08, y1 - 0.20), (xm, y1 - 0.05), (xm + 0.08, y1 - 0.20)], "A-ESCALERA")
        d.text((xm + 0.28, 7.00), "BAJA", 1.4, "A-TEXTO", rot=90)
    xr = (xa2 + xb1) / 2
    d.line((xr, y0), (xr, y1), "A-ESCALERA", lw=0.25)


def room_label(d, r, npt):
    x, y = r.label_at
    d.text((x, y + 0.16), r.name, 2.1, "A-TEXTO", bold=True)
    if r.name not in ("PATIO DE LUZ",):
        d.text((x, y - 0.10), f"A = {r.area:.2f} m²", 1.5, "A-TEXTO-AREA")
        tag = f"NPT {npt:+.2f}"
        d.text((x, y - 0.33), tag, 1.4, "A-TEXTO-AREA")
        rect(d, x - 0.34, y - 0.43, x + 0.34, y - 0.23, "A-TEXTO-AREA", lw=0.09)


def tiles(d, x1, y1, x2, y2, step=0.30, layer="A-PISO"):
    x = x1 + step
    while x < x2 - 1e-6:
        d.line((x, y1), (x, y2), layer, lw=0.05)
        x += step
    y = y1 + step
    while y < y2 - 1e-6:
        d.line((x1, y), (x2, y), layer, lw=0.05)
        y += step


def chain(d, pts, orient, off, right=False):
    for a, b in zip(pts[:-1], pts[1:]):
        d.dim((a[0], a[1]), (b[0], b[1]), off if orient == "h" else -off)


def grid_and_dims(d, level):
    for k, x in AX_X.items():
        d.line((x, -2.55), (x, 12.9), "A-EJES")
        d.circle((x, -2.85), 0.28, "A-EJES")
        d.text((x, -2.85), k, 2.5, "A-TEXTO", bold=True)
    for k, y in list(AX_COCHERA.items()) + list(AX_Y.items()):
        d.line((-2.55, y), (8.6, y), "A-EJES")
        d.circle((-2.85, y), 0.28, "A-EJES")
        d.text((-2.85, y), k, 2.2 if "'" in k else 2.5, "A-TEXTO", bold=True)
    chain(d, [(x, 0) for x in (0, 0.375, 1.0, 2.80, 5.10, 6.90, 7.625, 8.0)], "h", -0.95)
    chain(d, [(x, 0) for x in AX_X.values()], "h", -1.55)
    chain(d, [(0, 0), (8, 0)], "h", -2.10)
    chain(d, [(0, y) for y in (0, 5.0, 5.15, 7.90, 9.90, 10.05, 11.85, 12.0)], "v", -0.95)
    chain(d, [(0, y) for y in [0] + list(AX_COCHERA.values()) + list(AX_Y.values()) + [12.0]], "v", -1.55)
    chain(d, [(0, 0), (0, YB), (0, 12.0)], "v", -2.10)
    if level == 1:
        yr = [5.0, 5.15, 7.20, 7.30, 8.825, 8.925, 11.85, 12.0]
    elif level == 2:
        yr = [5.0, 5.15, 6.85, 6.95, 8.825, 8.925, 10.60, 10.70, 11.85, 12.0]
    else:
        yr = [5.0, 5.15, 7.90, 10.05, 11.85, 12.0]
    chain(d, [(8, y) for y in yr], "v", 0.75)


SECTIONS = {"A": ("x", 3.45, -1), "B": ("x", 1.10, -1), "C": ("y", 7.00, 1), "D": ("y", 2.50, 1)}


def section_marks(d):
    for lbl in ("A", "B"):
        x = SECTIONS[lbl][1]
        for y, sgn in ((-3.35, 1), (12.95, -1)):
            d.line((x, y), (x, y + 0.45 * sgn), "A-SIMBOLO", lw=0.5)
            d.circle((x - 0.32, y), 0.24, "A-SIMBOLO")
            d.text((x - 0.32, y), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x - 0.05, y + 0.10), (x - 0.05, y - 0.10), (x - 0.30, y)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
        d.line((x, -3.35), (x, 12.95), "A-SIMBOLO", lw=0.09, ls="DASHDOT")
    for lbl in ("C", "D"):
        y = SECTIONS[lbl][1]
        for x in (-3.35, 8.95):
            d.line((x, y), (x + (0.45 if x < 0 else -0.45), y), "A-SIMBOLO", lw=0.5)
            d.circle((x, y + 0.32), 0.24, "A-SIMBOLO")
            d.text((x, y + 0.32), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x - 0.10, y + 0.05), (x + 0.10, y + 0.05), (x, y + 0.30)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
        d.line((-3.35, y), (8.95, y), "A-SIMBOLO", lw=0.09, ls="DASHDOT")


def north(d, x, y):
    d.circle((x, y), 0.45, "A-SIMBOLO")
    d.poly([(x, y + 0.42), (x - 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#1a1a1a")
    d.poly([(x, y + 0.42), (x + 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#ffffff")
    d.text((x, y + 0.70), "N", 2.5, "A-TEXTO", bold=True)


def _slope_arrow(d, p1, p2, label, rot=None):
    d.pline([p1, p2], "A-SIMBOLO", lw=0.25)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    a1 = (p2[0] - 0.22 * math.cos(ang - 0.35), p2[1] - 0.22 * math.sin(ang - 0.35))
    a2 = (p2[0] - 0.22 * math.cos(ang + 0.35), p2[1] - 0.22 * math.sin(ang + 0.35))
    d.poly([p2, a1, a2], "A-SIMBOLO", fill="#1a1a1a", edge=False)
    mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    d.text((mx + 0.18, my), label, 1.6, "A-TEXTO", bold=True, rot=90 if rot is None else rot, va="bottom")


def carport_steel(d, layer_col="S-METALICA"):
    """Pedestales (concreto) + columnas metalicas de la cochera en planta."""
    for p in prisms_of("pedestal"):
        y1, y2, _, _ = p.yz_bounds()
        d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], "S-COLUMNA", fill="#9a958d", hatch="concreto", lw=0.25)
    for p in prisms_of("columna_met"):
        if p.name.startswith("COL CM"):
            y1, y2, _, _ = p.yz_bounds()
            d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], layer_col, fill="#24435c", lw=0.25)


def cover_ribs(d, y1, y2, layer="A-PISO", step=0.25):
    x = step
    while x < 8.0:
        d.line((x, y1), (x, y2), layer, lw=0.05)
        x += step


def lantern(d):
    d.line((2.90, 5.05), (5.10, 5.05), "A-VENTANA", lw=0.25)
    d.line((2.90, 5.08), (5.10, 5.08), "A-VENTANA", lw=0.25)
    x = 2.88
    while x < 5.10:
        d.poly([(x, 4.87), (x + 0.04, 4.87), (x + 0.04, 4.97), (x, 4.97)], "A-MOBILIARIO", fill="#b07a45", lw=0.05)
        x += 0.11


def plan_view(level):
    d = Drawing(f"PLANTA {LEVEL_NAMES[level]}")
    npt = LV[level]
    walls = [w for w in build_walls() if w.level == level]
    cols = [sbox(*c) for c in columns()]
    if level == 3:
        cols = [sbox(*c) for c in columns() if not (2.6 < c[0] < 5.4 and 8.7 < c[1] < 9.1)]
    col_geo = unary_union(cols)
    wall_geo = unary_union([sbox(*w.rect()) for w in walls])
    cut = []
    for w in walls:
        x1, y1, x2, y2 = w.rect()
        for o in w.openings:
            cut.append(sbox(o.s1, y1 - 0.01, o.s2, y2 + 0.01) if w.horizontal else sbox(x1 - 0.01, o.s1, x2 + 0.01, o.s2))
    wall_geo = wall_geo.difference(unary_union(cut) if cut else Polygon()).difference(col_geo)
    # pisos
    if level == 1:
        tiles(d, 6.30, 7.30, 7.85, 8.825)
        for (px, py) in [(3.1, 10.3), (3.4, 11.6), (4.8, 10.25), (4.9, 11.5), (3.2, 11.0), (4.7, 10.9), (3.6, 10.15)]:
            d.circle((px, py), 0.035, "A-JARDIN")
        d.circle((4.0, 10.95), 0.65, "A-JARDIN")
        d.circle((4.0, 10.95), 0.10, "A-JARDIN", fill="#6b4528")
        d.text((4.0, 10.35), "ÁRBOL (olivo / ficus)", 1.2, "A-TEXTO-AREA")
        x = 0.25
        while x < 8.0:
            d.line((x, 0.05), (x, 4.95), "A-PISO", lw=0.05)
            x += 0.50
    elif level == 2:
        for (x1, y1, x2, y2) in ((0.15, 5.15, 1.40, 6.85), (6.60, 5.15, 7.85, 6.85), (0.15, 8.925, 1.40, 10.60), (6.60, 8.925, 7.85, 10.60)):
            tiles(d, x1, y1, x2, y2)
    else:
        tiles(d, 0.15, 5.15, 7.85, 11.85, 0.60)
    if level in (2, 3):
        x1, y1, x2, y2 = WELL
        rect(d, x1, y1, x2, y2, "A-PROYECCION")
        d.line((x1, y1), (x2, y2), "A-PROYECCION")
        d.line((x1, y2), (x2, y1), "A-PROYECCION")
        d.text((4.0, 11.35), "VACÍO", 1.8, "A-TEXTO", bold=True)
        d.text((4.0, 11.05), "POZO DE LUZ 2.30 x 1.80", 1.3, "A-TEXTO-AREA")
    draw_shapely(d, wall_geo, "A-MURO", fill="#d8d3ca" if level < 3 else "#ebe7e0", hatch="muro", lw=0.35)
    draw_shapely(d, col_geo, "S-COLUMNA", fill="#1c1c1c", lw=0.35)
    for w in walls:
        for o in w.openings:
            opening_symbol(d, w, o)
    lantern(d)
    stair_plan(d, level)
    for r in build_rooms():
        if r.level == level or (level == 1 and r.name.startswith("COCHERA")):
            room_label(d, r, -0.05 if r.name.startswith("COCHERA") else npt)
    if level == 1:
        _furn_level1(d)
        carport_steel(d)
        rect(d, 0.0, 0.05, 8.0, 4.85, "A-PROYECCION")
        for i in range(6):
            xc = 0.375 + i * 1.45
            d.line((xc, 0.05), (xc, 4.85), "S-METALICA-PROY")
        for yb in (0.30, 4.45):
            d.line((0.05, yb + 0.075), (7.95, yb + 0.075), "S-METALICA-PROY")
        d.text((4.0, 1.45), "COBERTURA A UNA AGUA (h libre ≥ 2.45)", 1.4, "A-TEXTO-AREA")
        for x in (2.95, 5.05):
            d.pline([(x, -1.0), (x, -0.15)], "A-SIMBOLO")
            d.pline([(x - 0.08, -0.30), (x, -0.15), (x + 0.08, -0.30)], "A-SIMBOLO")
        d.text((4.0, -0.62), "INGRESO VEHICULAR Y PEATONAL — ÁREA LIBRE SIN CERRAMIENTO", 1.4, "A-TEXTO", bold=True)
        d.pline([(6.0, 4.10), (6.0, 4.88)], "A-SIMBOLO")
        d.text((6.0, 3.90), "INGRESO", 1.4, "A-TEXTO", bold=True)
    elif level == 2:
        _furn_level2(d)
        cover_ribs(d, 0.05, 4.85)
        rect(d, 0.0, 0.05, 8.0, 4.85, "A-VISTA")
        d.text((4.0, 2.90), "TECHO DE COCHERA (NIVEL INFERIOR)", 1.7, "A-TEXTO", bold=True)
        d.text((4.0, 2.55), "Panel TR4 — pendiente 10 % hacia la calle", 1.4, "A-TEXTO-AREA")
    else:
        _furn_level3(d)
        cover_ribs(d, 0.05, 4.85)
        rect(d, 0.0, 0.05, 8.0, 4.85, "A-VISTA")
        d.text((4.0, 2.90), "TECHO DE COCHERA (NIVEL INFERIOR)", 1.7, "A-TEXTO", bold=True)
        rect(d, 0.0, 4.95, 8.0, 11.95, "A-PROYECCION")
        for p in prisms_of("columna_met"):
            if p.name.startswith("COL CT"):
                y1, y2, _, _ = p.yz_bounds()
                d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], "S-METALICA", fill="#24435c", lw=0.25)
        for xc in (0.20, 2.775, 5.225, 7.80):
            d.line((xc, 5.05), (xc, 11.95), "S-METALICA-PROY")
        d.text((4.0, 7.40), "PROYECCIÓN COBERTURA METÁLICA (h = 2.60 a 3.00 m)", 1.3, "A-TEXTO-AREA")
        for x in (WELL[0], WELL[2]):
            d.line((x, WELL[1]), (x, WELL[3]), "A-VENTANA", lw=0.35)
        d.line((WELL[0], WELL[1]), (WELL[2], WELL[1]), "A-VENTANA", lw=0.35)
    d.pline([(0, 0), (8, 0), (8, 12), (0, 12)], "A-LOTE", closed=True)
    d.line((-1.2, -1.20), (9.2, -1.20), "A-PROYECCION")
    d.text((6.6, -1.00), "VEREDA", 1.5, "A-TEXTO-AREA")
    grid_and_dims(d, level)
    section_marks(d)
    north(d, 9.4, 11.3)
    return d


def _furn_level1(d):
    # cochera: 2 autos
    for x0 in (1.00, 5.10):
        rect(d, x0, 0.40, x0 + 1.80, 4.75, "A-MOBILIARIO")
        rect(d, x0 + 0.10, 1.60, x0 + 1.70, 3.80, "A-MOBILIARIO")
        d.text((x0 + 0.90, 1.05), "AUTO", 1.4, "A-TEXTO-AREA")
    d.text((4.0, 1.75), "2 ESTACIONAMIENTOS 2.50 x 5.00", 1.4, "A-TEXTO-AREA")
    # sala
    d.insert("SOFA_2.00_0.85", (1.00, 5.60), 90)
    d.insert("MESACENTRO_0.60_1.00", (1.30, 6.10))
    d.insert("SILLON", (2.65, 6.20), 90)
    d.insert("PLANTA_0.25", (0.45, 8.45))
    # comedor
    d.insert("MESA_1.60_0.90_2", (1.80, 9.60), 90)
    # cocina
    d.insert("REFRI", (5.30, 9.00))
    d.insert("MUEBLE_2.85", (7.85, 9.00), 90)
    d.insert("COCINA", (7.85, 9.80), 90)
    d.insert("TARJA", (7.85, 10.60), 90)
    d.insert("MUEBLE_1.95", (5.30, 11.85), 0, 1, -1)
    # recibo y baño de visitas
    d.insert("PLANTA_0.30", (7.40, 5.65))
    d.insert("INODORO", (7.40, 8.825), 180)
    d.insert("LAVATORIO_0.55", (6.30, 8.55), -90)
    # estar
    d.insert("SILLON", (3.20, 8.30))
    d.insert("SILLON", (4.80, 9.10), 180)


def _furn_level2(d):
    # suites frontales (1 y 2)
    mins(d, "CAMA_1.35_1.90", (2.05, 6.98), 90)
    mins(d, "VELADOR", (0.15, 8.38))
    mins(d, "CLOSET_1.00_0.55", (2.15, 6.90), -90)
    mins(d, "DUCHA_1.25_0.80", (0.15, 5.15))
    mins(d, "INODORO", (0.15, 6.25), -90)
    mins(d, "LAVATORIO_0.55", (0.80, 6.85), 0, 1, -1)
    # suites posteriores (3 y 4)
    mins(d, "CAMA_1.05_1.90", (2.05, 10.75), 90)
    mins(d, "CLOSET_0.70_0.55", (2.05, 9.90), 90)
    mins(d, "DUCHA_1.25_0.80", (0.15, 9.80))
    mins(d, "INODORO", (0.15, 9.25), -90)
    mins(d, "LAVATORIO_0.55", (0.75, 8.925))
    d.text((4.0, 8.25), "luz cenital del pozo", 1.2, "A-TEXTO-AREA")


def _furn_level3(d):
    d.insert("PARRILLA_1.80", (0.15, 9.40))
    d.insert("MESA_1.80_1.00_3", (2.40, 8.95), 90)
    d.insert("LAVADERO", (7.85, 11.85), 180)
    d.insert("LAVADORA", (6.35, 11.25))
    rect(d, 5.50, 6.10, 7.70, 8.20, "A-MOBILIARIO")
    d.text((6.60, 7.15), "SALA EXTERIOR", 1.3, "A-TEXTO-AREA")
    for x in (5.45, 7.85):
        pass
    for y in (10.70, 10.85, 11.0):
        d.line((5.40, y), (6.20, y), "A-MOBILIARIO", ls="DASHED")
    d.text((5.80, 10.55), "TENDAL", 1.1, "A-TEXTO-AREA")
    for (x1, x2) in ((0.15, 2.70), (5.30, 7.85)):
        d.pline([(x1, 5.15), (x2, 5.15), (x2, 5.55), (x1, 5.55)], "A-JARDIN", closed=True)
        for k in range(int((x2 - x1) / 0.5)):
            d.insert("PLANTA_0.16", (x1 + 0.30 + k * 0.5, 5.35))


def roof_plan():
    d = Drawing("PLANTA DE TECHOS")
    rect(d, 0.0, YB, 8.0, 12.0, "A-PROYECCION")
    # cochera
    cover_ribs(d, 0.15, 4.85, "A-VISTA-LEJOS")
    rect(d, 0.0, 0.05, 8.0, 4.85, "A-VISTA", lw=0.35)
    rect(d, 0.05, 0.05, 7.95, 0.25, "A-SANITARIO")
    for x in (0.51, 7.47):
        d.circle((x, 0.16), 0.05, "A-SANITARIO")
    _slope_arrow(d, (1.6, 4.4), (1.6, 0.5), "PEND. 10 %")
    d.text((4.6, 3.35), "COBERTURA COCHERA", 2.0, "A-TEXTO", bold=True)
    d.text((4.6, 3.00), "Panel termoacústico TR4 e = 50 mm", 1.4, "A-TEXTO-AREA")
    d.text((4.6, 2.72), "+3.59 (fachada) → +3.11 (calle)", 1.4, "A-TEXTO-AREA")
    d.text((4.0, 0.42), "CANALETA 200x150 + 2 BAJANTES Ø3\" (en columnas delanteras)", 1.2, "A-TEXTO-AREA")
    # terraza
    cover_ribs(d, 5.08, 9.85, "A-VISTA-LEJOS")
    rect(d, 0.0, 4.95, 8.0, 11.95, "A-VISTA", lw=0.35)
    d.poly([(0, 9.85), (8, 9.85), (8, 11.95), (0, 11.95)], "A-VENTANA", fill="#e7f1f4", hatch="vidrio", lw=0.13)
    rect(d, 0.05, 4.90, 7.95, 5.08, "A-SANITARIO")
    for x in (0.34, 7.66):
        d.circle((x, 4.94), 0.05, "A-SANITARIO")
    _slope_arrow(d, (1.6, 11.6), (1.6, 5.35), "PEND. 5.7 %")
    d.text((4.6, 8.10), "COBERTURA TERRAZA", 2.0, "A-TEXTO", bold=True)
    d.text((4.6, 7.75), "Panel termoacústico TR4 e = 50 mm", 1.4, "A-TEXTO-AREA")
    d.text((4.6, 7.47), "+8.60 (fondo) → +8.20 (fachada)", 1.4, "A-TEXTO-AREA")
    d.text((4.6, 10.95), "POLICARBONATO ALVEOLAR 10 mm SOBRE POZO DE LUZ", 1.4, "A-TEXTO", bold=True)
    d.text((4.0, 5.30), "CANALETA 200x150 → 2 BAJANTES Ø3\" POR FACHADA", 1.2, "A-TEXTO-AREA")
    d.pline([(0, 0), (8, 0), (8, 12), (0, 12)], "A-LOTE", closed=True)
    for k, x in AX_X.items():
        d.line((x, -1.2), (x, 12.9), "A-EJES")
        d.circle((x, -1.5), 0.28, "A-EJES"); d.text((x, -1.5), k, 2.5, "A-TEXTO", bold=True)
    for k, y in list(AX_COCHERA.items()) + list(AX_Y.items()):
        d.line((-1.2, y), (8.6, y), "A-EJES")
        d.circle((-1.5, y), 0.28, "A-EJES"); d.text((-1.5, y), k, 2.2, "A-TEXTO", bold=True)
    chain(d, [(0, 0), (0, YB), (0, 12.0)], "v", -0.7)
    chain(d, [(0, 0), (8, 0)], "h", -0.75)
    north(d, 9.4, 11.3)
    return d


def cover_structure_plan():
    d = Drawing("ESTRUCTURA DE COBERTURAS METÁLICAS")
    rect(d, 0.0, YB, 8.0, 12.0, "A-PROYECCION")
    # cochera
    for yb in (0.30, 4.45):
        d.poly([(0.05, yb), (7.95, yb), (7.95, yb + 0.15), (0.05, yb + 0.15)], "S-METALICA", fill="#5d7a92", lw=0.18)
    for i in range(6):
        xc = 0.375 + i * 1.45
        d.poly([(xc - 0.05, 0.05), (xc + 0.05, 0.05), (xc + 0.05, 4.85), (xc - 0.05, 4.85)], "S-METALICA", fill="#9fb3c3", lw=0.18)
    for yc in (0.30, 1.25, 2.20, 3.15, 4.10, 4.75):
        d.line((0.05, yc), (7.95, yc), "S-METALICA", lw=0.13)
    carport_steel(d)
    for (xa, xb) in ((0.375, 1.825), (6.175, 7.625)):
        d.line((xa, 1.25), (xb, 3.15), "S-METALICA-PROY")
        d.line((xb, 1.25), (xa, 3.15), "S-METALICA-PROY")
    # terraza
    for xc in (0.20, 2.775, 5.225, 7.80):
        d.poly([(xc - 0.05, 5.05), (xc + 0.05, 5.05), (xc + 0.05, 11.95), (xc - 0.05, 11.95)], "S-METALICA", fill="#9fb3c3", lw=0.18)
        for yc in (5.15, 8.875, 11.85):
            d.poly([(xc - 0.05, yc - 0.05), (xc + 0.05, yc - 0.05), (xc + 0.05, yc + 0.05), (xc - 0.05, yc + 0.05)],
                   "S-METALICA", fill="#1c2a36", lw=0.25)
    for yc in (5.30, 6.30, 7.30, 8.30, 9.30, 10.30, 11.30, 11.85):
        d.line((0.05, yc), (7.95, yc), "S-METALICA", lw=0.13)
    for (xa, xb) in ((0.20, 2.775), (5.225, 7.80)):
        d.line((xa, 5.30), (xb, 8.30), "S-METALICA-PROY")
        d.line((xb, 5.30), (xa, 8.30), "S-METALICA-PROY")
    T = [((4.0, 0.62), "VM-2  TUBO LAC 150x300x4 (frontal)"), ((4.0, 4.20), "VM-2  TUBO LAC 150x300x4 (posterior)"),
         ((1.10, 2.40), "VM-1"), ((4.0, 2.40), "VM-1 TUBO 100x200x3 @1.45 · CO-1 TUBO 50x100x2 @0.95"),
         ((0.37, -0.35), "CM-1 + PEDESTAL"), ((7.63, -0.35), "CM-1 + PEDESTAL"),
         ((4.0, 6.80), "VT-1 TUBO 100x250x3 (4 ejes) · CO-1 @1.00"), ((4.0, 10.80), "CT-1 TUBO 100x100x3 (12 und.) sobre columnas C°A°"),
         ((1.50, 6.20), "ARRIOSTRE Ø1/2\"")]
    for p, s in T:
        d.text(p, s, 1.4, "A-TEXTO", bold=True)
    xs = [0.0, 0.375, 1.825, 3.275, 4.725, 6.175, 7.625, 8.0]
    chain(d, [(x, 12.0) for x in xs], "h", 0.75)
    chain(d, [(8.0, y) for y in (0.0, 0.375, 4.525, 5.0, 5.15, 8.875, 11.85, 12.0)], "v", 0.75)
    return d


# ---------------------------------------------------------------------------
# CORTES Y ELEVACIONES (proyeccion + eliminacion de lineas ocultas)
# ---------------------------------------------------------------------------
TRANSPARENT = {"baranda", "lucernario"}
POCHE = {
    "muro": ("#cfc9bf", "muro"), "losa": ("#5a5a5a", None), "viga": ("#5a5a5a", None), "columna": ("#5a5a5a", None),
    "escalera": ("#5a5a5a", None), "fachada": ("#7a7772", None), "cimentacion": ("#8a8478", "concreto"),
    "cobertura": ("#2b3036", None), "correa": ("#24435c", None), "viga_met": ("#24435c", None),
    "columna_met": ("#24435c", None), "canaleta": ("#8f979e", None), "bajante": ("#8f979e", None),
    "ventana": ("#bcd9e6", None), "puerta": ("#a8743f", None), "muro_cortina": ("#bcd9e6", None),
    "celosia": ("#b07a45", None), "mobiliario": ("#ffffff", None), "jardin": ("#9cc08a", None),
    "baranda": ("#d7ebf3", None), "lucernario": ("#bcd9e6", None), "instalaciones": ("#444444", None),
    "pedestal": ("#7a7772", "concreto"),
}
ELEV_FILL = {
    "muro_blanco": "#fbfaf6", "muro_gris": "#efede7", "muro_int": "#f7f5f0", "concreto": "#e6e3dd",
    "concreto_visto": "#cbc7c0", "vidrio": "#d4e7ef", "aluminio": "#4b5157", "madera": "#d6a36c",
    "madera_osc": "#8b5a33", "acero": "#5b636b", "acero_galv": "#c3c8cc", "panel_tr4": "#6b7178",
    "policarbonato": "#eef5f7", "celosia_met": "#9aa1a7", "verde": "#9cc08a", "tanque": "#3a3a3a",
    "auto": "#d9dcde", "vidrio_auto": "#9aa5ad", "piso_cochera": "#e2ded6",
}


def _project(prisms, mode, c, look):
    """Devuelve [(Polygon_uz, depth, prism, is_cut)]."""
    out = []
    for p in prisms:
        P = Polygon(p.poly)
        if not P.is_valid:
            P = P.buffer(0)
        if mode == "x":                    # mira hacia -x ; u = y
            if p.x1 >= c:
                continue
            if p.x2 > c:
                out.append((P, 0.0, p, True))
            else:
                out.append((P, c - p.x2, p, False))
        else:                               # plano y=c ; mira look (+1 hacia +y, -1 hacia -y)
            ux = (lambda x: x) if look > 0 else (lambda x: 8.0 - x)
            u1, u2 = sorted([ux(p.x1), ux(p.x2)])
            y1, y2, z1, z2 = p.yz_bounds()
            if y1 < c < y2:
                seg = P.intersection(LineString([(c, z1 - 1), (c, z2 + 1)]))
                segs = [seg] if seg.geom_type == "LineString" else list(getattr(seg, "geoms", []))
                for s in segs:
                    zs = [q[1] for q in s.coords]
                    if max(zs) - min(zs) > 1e-6:
                        out.append((sbox(u1, min(zs), u2, max(zs)), 0.0, p, True))
                H = sbox(c, -10, 50, 50) if look > 0 else sbox(-50, -10, c, 50)
                rest = P.intersection(H)
                if not rest.is_empty:
                    _, rz1, _, rz2 = rest.bounds
                    out.append((sbox(u1, rz1, u2, rz2), 0.001, p, False))
            elif (look > 0 and y1 >= c) or (look < 0 and y2 <= c):
                depth = (y1 - c) if look > 0 else (c - y2)
                out.append((sbox(u1, z1, u2, z2), depth, p, False))
    return out


def section_view(mode, c, look, title, elevation=False, hide_fur=False, umin=None, umax=None):
    d = Drawing(title)
    P = [p for p in (_CACHE.setdefault("all", all_prisms())) if not (hide_fur and p.cat == "mobiliario")]
    if elevation:
        P = [p for p in P if p.cat != "cimentacion"]
    items = _project(P, mode, c, look)
    if umin is None:
        umin, umax = (-1.3, 12.3) if mode == "x" else (-0.3, 8.3)
    # terreno
    occl = []
    if not elevation:
        earth = sbox(umin, -1.9, umax, -0.15)
        d.poly(list(earth.exterior.coords)[:-1], "A-TERRENO", fill="#ece6da", hatch="tierra", lw=0.0, edge=False)
    cuts = [it for it in items if it[3]]
    if not elevation:
        occl.append(earth)
    else:
        occl.append(sbox(umin - 5, -6, umax + 5, -0.16))
    for g, _, p, _ in cuts:
        fill, hatch = POCHE.get(p.cat, ("#777777", None))
        if p.mat == "celosia_met":
            fill = "#5b636b"
        lay = "A-CORTE" if p.cat not in ("mobiliario", "jardin", "baranda", "ventana", "lucernario") else "A-VISTA"
        draw_shapely(d, g, lay, fill=fill, hatch=hatch, lw=0.40 if lay == "A-CORTE" else 0.18)
        if p.cat not in TRANSPARENT:
            occl.append(g)
    occ = unary_union(occl) if occl else Polygon()
    beyond = sorted([it for it in items if not it[3]], key=lambda t: t[1])
    for g, depth, p, _ in beyond:
        vis = g.difference(occ) if not occ.is_empty else g
        if vis.is_empty or vis.area < 1e-5:
            continue
        if elevation:
            fill = ELEV_FILL.get(p.mat, "#f4f2ed")
        else:
            fill = "#ffffff" if p.mat not in ("vidrio", "policarbonato") else "#eef6f9"
        lay = "A-VISTA" if depth < 3.0 or elevation else "A-VISTA-LEJOS"
        draw_shapely(d, vis, lay, fill=fill, lw=0.13 if lay == "A-VISTA" else 0.09)
        if p.cat not in TRANSPARENT:
            occ = occ.union(g)
    if elevation:
        d.line((umin, -0.15), (umax, -0.15), "A-TERRENO", lw=0.6)
    _section_annotations(d, mode, c, look, umin, umax, elevation)
    return d


def _section_annotations(d, mode, c, look, umin, umax, elevation):
    xr = umax + 0.25
    marks = [(0.0, "NPT ±0.00"), (LV[2], "NPT +2.80"), (LV[3], "NPT +5.60 TERRAZA"), (LV[3] + 1.10, "PARAPETO +6.70"),
             (8.60, "COBERTURA +8.60")]
    for z, lbl in marks:
        d.line((umin, z), (xr, z), "A-PROYECCION", lw=0.09)
        d.poly([(xr + 0.15, z), (xr + 0.30, z + 0.18), (xr, z + 0.18)], "A-SIMBOLO", fill="#ffffff", lw=0.18)
        d.text((xr + 0.40, z + 0.12), lbl, 1.7, "A-TEXTO", ha="left")
    xs = xr + 3.0
    chain(d, [(xs, z) for z, _ in marks], "v", 0.001)
    if not elevation:
        lab = {1: 1.35, 2: LV[2] + 1.35, 3: LV[3] + 1.35}
        for r in build_rooms():
            x1, y1, x2, y2 = r.rect
            if r.name.startswith("BAÑO") or r.name == "LAVANDERÍA":
                continue
            if mode == "x" and x1 < c < x2:
                d.text(((y1 + y2) / 2, lab[r.level]), r.name, 1.5, "A-TEXTO", bold=True)
            if mode == "y" and y1 < c < y2:
                u = (x1 + x2) / 2 if look > 0 else 8 - (x1 + x2) / 2
                d.text((u, lab[r.level]), r.name, 1.5, "A-TEXTO", bold=True)
        if mode == "x":
            d.text((2.45, carport_top(2.45) + 0.35), "COBERTURA COCHERA PEND. 10 %", 1.5, "A-TEXTO", bold=True)
            d.text((8.4, terrace_top(8.4) + 0.35), "COBERTURA TERRAZA PEND. 5.7 %", 1.5, "A-TEXTO", bold=True)


def _notes(d, notes, ha="left"):
    for (t, p, s) in notes:
        d.line(t, p, "A-COTA", lw=0.13)
        d.circle(p, 0.006, "A-COTA", fill="#202020")
        d.text((t[0] + (0.02 if ha == "left" else -0.02), t[1]), s, 2.0, "A-TEXTO", ha=ha)


def detail_views():
    """Detalles de la columna frontal de la cochera (corte por x = 0.375)."""
    base = section_view("x", 0.375, -1, "CORTE POR COLUMNA CM-1", hide_fur=True)
    d1 = Drawing("DETALLE 1"); d1.extend(base)
    notes1 = [((0.85, 0.80), (0.40, 0.70), "COLUMNA CM-1 TUBO LAC 150x150x4"),
              ((0.85, 0.66), (0.50, 0.507), "PLANCHA BASE 300x300x12 + GROUT"),
              ((0.85, 0.52), (0.475, 0.30), "4 PERNOS ANCLAJE Ø5/8\" L=0.50"),
              ((0.85, 0.20), (0.56, 0.10), "PEDESTAL C°A° 0.40x0.40 h=1.10"),
              ((0.85, -0.10), (0.75, -0.10), "LOSA COCHERA e=0.10 + CONTRAPISO"),
              ((0.85, -0.90), (0.80, -0.90), "ZAPATA 0.90x0.90x0.60 f'c=210"),
              ((0.85, -1.30), (0.60, -1.25), "SOLADO e=0.10 / TERRENO NATURAL")]
    _notes(d1, notes1)
    n1 = Drawing("NOTAS D1"); n1.items = d1.items[len(base.items):]
    d2 = Drawing("DETALLE 2"); d2.extend(base)
    t = carport_top
    notes2 = [((0.85, 3.42), (0.15, t(0.15) + 0.03), "CANALETA GALV. 200x150 e=0.9 mm"),
              ((0.85, 3.34), (0.62, t(0.62) - 0.02), "PANEL TERMOACÚSTICO TR4 e=50 mm"),
              ((0.85, 3.26), (0.75, t(1.25) - 0.20), "CORREA CO-1 TUBO 50x100x2"),
              ((0.85, 2.72), (0.80, t(0.80) - 0.28), "VIGA VM-1 TUBO 100x200x3"),
              ((0.85, 2.62), (0.42, 2.62), "VIGA VM-2 TUBO 150x300x4"),
              ((0.85, 2.52), (0.41, 2.47), "COLUMNA CM-1 (soldadura E70XX 6 mm)")]
    _notes(d2, notes2)
    n2 = Drawing("NOTAS D2"); n2.items = d2.items[len(base.items):]
    return d1, d2, base, n1, n2


def all_views():
    V = {}
    V["P1"] = plan_view(1)
    V["P2"] = plan_view(2)
    V["P3"] = plan_view(3)
    V["PT"] = roof_plan()
    V["PE"] = cover_structure_plan()
    V["SA"] = section_view("x", SECTIONS["A"][1], -1, "CORTE A-A")
    V["SB"] = section_view("x", SECTIONS["B"][1], -1, "CORTE B-B")
    V["SC"] = section_view("y", SECTIONS["C"][1], 1, "CORTE C-C")
    V["SD"] = section_view("y", SECTIONS["D"][1], 1, "CORTE D-D (COCHERA)")
    V["EF"] = section_view("y", -30.0, +1, "ELEVACIÓN PRINCIPAL", elevation=True)
    V["EL"] = section_view("x", 30.0, -1, "ELEVACIÓN LATERAL", elevation=True)
    V["D1"], V["D2"], V["_DB"], V["_N1"], V["_N2"] = detail_views()
    return V
