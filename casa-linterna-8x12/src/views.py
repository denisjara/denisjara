"""Generacion de vistas 2D (plantas, cortes, elevaciones) desde el modelo. Version 4.

Las plantas se dibujan en coordenadas del modelo, sin giro:
  u = x (ancho del lote, medianera izquierda a la izquierda)
  v = y (calle abajo, fondo arriba)
"""
import math
from collections import OrderedDict
from shapely.geometry import Polygon, box as sbox, LineString, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from model import (build_walls, build_rooms, all_prisms, plan2d, LV, LOT_X, LOT_Y, Y0, YB, COL_X, COL_Y, ST_Y_A, ST_Y_B,
                   ST_X_FL, ST_X_LAND, STAIR_ZONE, DUCTS, YF, YM1, YM2, TREAD, STRIP_COLS_X, STRIP_COL_Y, BALCONIES, BAL_D,
                   strip_top, terrace_top, LEVEL_NAMES, AX_X, AX_Y)
from drawing import Drawing

GRID_V = OrderedDict((k, (a + b) / 2) for k, (a, b) in COL_X.items())            # lineas verticales (x)
GRID_H = OrderedDict([("0", STRIP_COL_Y)] + [(k, (a + b) / 2) for k, (a, b) in COL_Y.items()])   # horizontales (y)
RAFTERS = [0.30 + i * 7.40 / 6 for i in range(7)]


def prisms_of(cat):
    return [p for p in all_prisms() if p.cat == cat]


def columns():
    out = {}
    for p in prisms_of("columna"):
        y1, y2, _, _ = p.yz_bounds()
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


def void(d, x1, y1, x2, y2, label=None):
    rect(d, x1, y1, x2, y2, "A-PROYECCION")
    d.line((x1, y1), (x2, y2), "A-PROYECCION", lw=0.09)
    d.line((x1, y2), (x2, y1), "A-PROYECCION", lw=0.09)
    if label:
        d.text(((x1 + x2) / 2, (y1 + y2) / 2 + 0.25), label, 1.5, "A-TEXTO", bold=True)


# ---------------------------------------------------------------------------
# SIMBOLOS DE VANOS Y ESCALERA
# ---------------------------------------------------------------------------
def opening_symbol(d, w, o):
    t = w.t
    width = o.s2 - o.s1
    if o.kind == "vano":
        if w.horizontal:
            for yy in (w.a[1] - t / 2, w.a[1] + t / 2):
                d.line((o.s1, yy), (o.s2, yy), "A-PROYECCION", lw=0.09)
            d.text(((o.s1 + o.s2) / 2, w.a[1] + 0.22), o.name, 1.5, "A-TEXTO-AREA", bold=True)
        return
    if w.horizontal:                      # muro a lo largo de x
        yc = w.a[1]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hx = o.s1 if o.hinge == "a" else o.s2
            d.insert(name, (hx, yc), 0, 1 if o.hinge == "a" else -1, 1 if o.side > 0 else -1, {"TAG": o.name})
            out = -0.30 * o.side
        elif o.kind == "slide":
            d.insert(f"CORREDIZA_{width:.2f}_{t:.2f}", (o.s1, yc), 0, 1, 1, {"TAG": o.name})
            out = 0.30
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (o.s1, yc), 0, 1, 1, {"TAG": o.name})
            out = 0.30
        if yc < Y0 + 0.2:
            out = -0.42 if o.kind != "door2" else -0.55
        elif yc > YB - 0.2:
            out = 0.40
        tag = ((o.s1 + o.s2) / 2, yc + out)
    else:                                 # muro a lo largo de y
        xc = w.a[0]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hy = o.s1 if o.hinge == "a" else o.s2
            if o.side > 0:
                d.insert(name, (xc, hy), -90, -1 if o.hinge == "a" else 1, 1, {"TAG": o.name})
            else:
                d.insert(name, (xc, hy), 90, 1 if o.hinge == "a" else -1, 1, {"TAG": o.name})
            tag = (xc + 0.24 * o.side, (o.s1 + o.s2) / 2 + 0.22)
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (xc, o.s1), 90, 1, 1, {"TAG": o.name})
            tag = (xc - 0.32, (o.s1 + o.s2) / 2)
    d.text(tag, o.name, 1.5, "A-TEXTO-AREA", bold=True)


def stair_plan(d, level):
    xl, xf = ST_X_FL
    up, down = level <= 2, level >= 2
    brk = 2.10
    for i in range(8):
        x = xl + i * TREAD
        d.line((x, ST_Y_B[0]), (x, ST_Y_B[1]), "A-ESCALERA" if down else "A-PROYECCION")
    rect(d, xl, ST_Y_B[0], xf, ST_Y_B[1], "A-ESCALERA" if down else "A-PROYECCION")
    if up:
        for i in range(8):
            x = xf - i * TREAD
            d.line((x, ST_Y_A[0]), (x, ST_Y_A[1]), "A-ESCALERA" if x >= brk else "A-PROYECCION")
        d.line((brk, ST_Y_A[0]), (xf, ST_Y_A[0]), "A-ESCALERA")
        d.line((brk, ST_Y_A[1]), (xf, ST_Y_A[1]), "A-ESCALERA")
        d.line((xl, ST_Y_A[0]), (brk, ST_Y_A[0]), "A-PROYECCION")
        d.line((xl, ST_Y_A[1]), (brk, ST_Y_A[1]), "A-PROYECCION")
        d.pline([(brk - 0.12, ST_Y_A[0]), (brk + 0.12, ST_Y_A[1])], "A-ESCALERA", lw=0.25)
        ym = sum(ST_Y_A) / 2
        d.pline([(xf - 0.05, ym), (ST_X_LAND[0] + 0.35, ym)], "A-ESCALERA")
        d.pline([(ST_X_LAND[0] + 0.50, ym - 0.08), (ST_X_LAND[0] + 0.35, ym), (ST_X_LAND[0] + 0.50, ym + 0.08)], "A-ESCALERA")
        d.circle((xf - 0.05, ym), 0.04, "A-ESCALERA", fill="#333333")
        d.text((2.45, ym - 0.22), "SUBE", 1.4, "A-TEXTO")
    rect(d, ST_X_LAND[0], STAIR_ZONE[1], ST_X_LAND[1], STAIR_ZONE[3], "A-ESCALERA" if (down and not up) else "A-PROYECCION")
    if down:
        ym = sum(ST_Y_B) / 2
        d.pline([(xf - 0.05, ym), (xl + 0.10, ym)], "A-ESCALERA")
        d.pline([(xf - 0.20, ym - 0.08), (xf - 0.05, ym), (xf - 0.20, ym + 0.08)], "A-ESCALERA")
        d.text((2.20, ym + 0.22), "BAJA", 1.4, "A-TEXTO")
    yr = (ST_Y_A[1] + ST_Y_B[0]) / 2
    d.line((xl, yr), (xf, yr), "A-ESCALERA", lw=0.25)


def room_label(d, r, npt):
    x, y = r.label_at
    d.text((x, y + 0.16), r.name, 2.1, "A-TEXTO", bold=True)
    d.text((x, y - 0.10), f"A = {r.area:.2f} m²", 1.5, "A-TEXTO-AREA")
    d.text((x, y - 0.33), f"NPT {npt:+.2f}", 1.4, "A-TEXTO-AREA")
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


def dims_along_y(d, x, ys, off):
    """Cotas a lo largo de y (verticales en la lamina). off>0 -> hacia -x (izquierda)."""
    for a, b in zip(ys[:-1], ys[1:]):
        d.dim((x, a), (x, b), off)


def dims_along_x(d, y, xs, off):
    """Cotas a lo largo de x (horizontales en la lamina). off>0 -> hacia +y (arriba)."""
    for a, b in zip(xs[:-1], xs[1:]):
        d.dim((a, y), (b, y), off)


def grid_and_dims(d, level):
    for k, y in GRID_H.items():
        d.line((-2.55, y), (8.75, y), "A-EJES")
        d.circle((-2.85, y), 0.28, "A-EJES")
        d.text((-2.85, y), k, 2.5, "A-TEXTO", bold=True)
    for k, x in GRID_V.items():
        d.line((x, -0.80), (x, LOT_Y + 2.55), "A-EJES")
        d.circle((x, LOT_Y + 2.85), 0.28, "A-EJES")
        d.text((x, LOT_Y + 2.85), k, 2.5, "A-TEXTO", bold=True)
    if level == 1:
        ys = [0, Y0, 5.15, 9.85, 9.95, 12.20, 12.30, 16.35, 16.85, LOT_Y]
        xs = [0, 0.15, 2.90, 3.875, 4.025, 6.35, 7.85, 8.0]
    elif level == 2:
        ys = [0, Y0 - BAL_D, Y0, 5.15, 8.05, 9.85, 9.95, 12.20, 12.30, 14.10, 16.35, 16.85, LOT_Y]
        xs = [0, 0.15, 2.05, 2.15, 3.875, 4.025, 5.85, 5.95, 7.85, 8.0]
    else:
        ys = [0, Y0, 5.15, STAIR_ZONE[1], STAIR_ZONE[3], 16.35, 16.85, LOT_Y]
        xs = [0, 0.15, 0.65, 2.90, 7.35, 7.85, 8.0]
    dims_along_y(d, 0.0, ys, 0.95)
    dims_along_y(d, 0.0, [0] + list(GRID_H.values()) + [LOT_Y], 1.55)
    dims_along_y(d, 0.0, [0, Y0, LOT_Y], 2.10)
    dims_along_x(d, LOT_Y, xs, 0.95)
    dims_along_x(d, LOT_Y, [0] + list(GRID_V.values()) + [LOT_X], 1.55)
    dims_along_x(d, LOT_Y, [0, LOT_X], 2.10)


# planos de corte: (modo, posicion, sentido de vista)
SECTIONS = {"A": ("x", 5.20, -1), "B": ("x", 1.70, -1), "C": ("y", 6.80, -1), "D": ("y", 11.60, 1)}


def section_marks(d):
    for lbl in ("A", "B"):
        _, x, s = SECTIONS[lbl]
        for y in (-2.55, LOT_Y + 3.55):
            d.circle((x + 0.32 * s, y), 0.24, "A-SIMBOLO")
            d.text((x + 0.32 * s, y), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x + 0.05 * s, y + 0.10), (x + 0.05 * s, y - 0.10), (x + 0.30 * s, y)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
            d.line((x, y - 0.35), (x, y + 0.35), "A-SIMBOLO", lw=0.5)
        d.line((x, -2.55), (x, LOT_Y + 3.55), "A-SIMBOLO", lw=0.09, ls="DASHDOT")
    for lbl in ("C", "D"):
        _, y, s = SECTIONS[lbl]
        for x in (-3.55, LOT_X + 1.15):
            d.circle((x, y + 0.32 * s), 0.24, "A-SIMBOLO")
            d.text((x, y + 0.32 * s), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x - 0.10, y + 0.05 * s), (x + 0.10, y + 0.05 * s), (x, y + 0.30 * s)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
            d.line((x - 0.35, y), (x + 0.35, y), "A-SIMBOLO", lw=0.5)
        d.line((-3.55, y), (LOT_X + 1.15, y), "A-SIMBOLO", lw=0.09, ls="DASHDOT")


def north(d, x, y):
    d.circle((x, y), 0.45, "A-SIMBOLO")
    d.poly([(x, y + 0.42), (x - 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#1a1a1a")
    d.poly([(x, y + 0.42), (x + 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#ffffff")
    d.text((x, y + 0.75), "N", 2.5, "A-TEXTO", bold=True)


def _slope_arrow(d, p1, p2, label):
    d.pline([p1, p2], "A-SIMBOLO", lw=0.25)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    a1 = (p2[0] - 0.22 * math.cos(ang - 0.35), p2[1] - 0.22 * math.sin(ang - 0.35))
    a2 = (p2[0] - 0.22 * math.cos(ang + 0.35), p2[1] - 0.22 * math.sin(ang + 0.35))
    d.poly([p2, a1, a2], "A-SIMBOLO", fill="#1a1a1a", edge=False)
    mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    d.text((mx + 0.22, my), label, 1.6, "A-TEXTO", bold=True, ha="left")


def strip_steel(d):
    for p in prisms_of("pedestal"):
        y1, y2, _, _ = p.yz_bounds()
        d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], "S-COLUMNA", fill="#9a958d", hatch="concreto", lw=0.25)
    for p in prisms_of("columna_met"):
        if p.name.startswith("COL CM"):
            y1, y2, _, _ = p.yz_bounds()
            d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], "S-METALICA", fill="#24435c", lw=0.25)


def cover_ribs(d, x1, x2, y1, y2, layer="A-PISO", step=0.25):
    x = x1 + step
    while x < x2:
        d.line((x, y1), (x, y2), layer, lw=0.05)
        x += step


def balconies(d, layer="A-MURO-BAJO"):
    for (x1, x2) in BALCONIES:
        rect(d, x1, Y0 - BAL_D, x2, Y0, layer)
        if layer != "A-PROYECCION":
            d.line((x1, Y0 - BAL_D + 0.035), (x2, Y0 - BAL_D + 0.035), "A-VENTANA", lw=0.35)


def furniture(d, level):
    for (_, name, pos, rot, sx, sy) in plan2d(level):
        d.insert(name, pos, rot, sx, sy)


# ---------------------------------------------------------------------------
# PLANTAS
# ---------------------------------------------------------------------------
def plan_view(level):
    d = Drawing(f"PLANTA {LEVEL_NAMES[level]}")
    npt = LV[level]
    walls = [w for w in build_walls() if w.level == level]
    col_geo = unary_union([sbox(*c) for c in columns()])
    wall_geo = unary_union([sbox(*w.rect()) for w in walls])
    cut = []
    for w in walls:
        x1, y1, x2, y2 = w.rect()
        for o in w.openings:
            cut.append(sbox(o.s1, y1 - 0.01, o.s2, y2 + 0.01) if w.horizontal else sbox(x1 - 0.01, o.s1, x2 + 0.01, o.s2))
    if cut:
        wall_geo = wall_geo.difference(unary_union(cut))
    wall_geo = wall_geo.difference(col_geo)
    if level == 1:
        tiles(d, 6.45, 9.95, 7.85, 11.45)
        tiles(d, 0.15, 12.30, 2.05, 14.00)
        tiles(d, 4.025, 12.30, 7.85, YM2, 0.60)
        x = 0.5
        while x < 8.0:
            d.line((x, 0.02), (x, Y0 - 0.02), "A-PISO", lw=0.05)
            x += 0.5
    elif level == 2:
        for r in ((0.15, 8.15, 2.05, 9.85), (5.95, 8.15, 7.85, 9.85), (0.15, 12.30, 2.05, 14.00), (5.95, 12.30, 7.85, 14.00)):
            tiles(d, *r)
    else:
        tiles(d, 0.15, 5.15, 7.85, STAIR_ZONE[1] - 0.05, 0.60)
        tiles(d, 0.15, STAIR_ZONE[3] + 0.05, 7.85, 16.25, 0.60)
        tiles(d, 2.95, STAIR_ZONE[1], 7.85, STAIR_ZONE[3], 0.60)
    draw_shapely(d, wall_geo, "A-MURO", fill="#d8d3ca" if level < 3 else "#ebe7e0", hatch="muro", lw=0.35)
    draw_shapely(d, col_geo, "S-COLUMNA", fill="#1c1c1c", lw=0.35)
    for w in walls:
        for o in w.openings:
            opening_symbol(d, w, o)
    stair_plan(d, level)
    furniture(d, level)
    for r in build_rooms():
        if r.level == level:
            room_label(d, r, -0.05 if r.name.startswith("COCHERA") else npt)
    for (x1, y1, x2, y2) in DUCTS:
        void(d, x1, y1, x2, y2)
    d.text((0.40, 16.10), "DUCTO 0.50x0.50", 1.1, "A-TEXTO-AREA")
    d.text((7.60, 16.10), "DUCTO 0.50x0.50", 1.1, "A-TEXTO-AREA")
    if level == 1:
        strip_steel(d)
        rect(d, 0.0, 0.05, 8.0, Y0 - 0.05, "A-PROYECCION")
        for xc in RAFTERS:
            d.line((xc, 0.05), (xc, Y0 - 0.05), "S-METALICA-PROY")
        d.line((0.05, STRIP_COL_Y), (7.95, STRIP_COL_Y), "S-METALICA-PROY")
        balconies(d, "A-PROYECCION")
        for x in (1.50, 5.10):
            d.pline([(x, -1.05), (x, -0.20)], "A-SIMBOLO")
            d.pline([(x - 0.08, -0.35), (x, -0.20), (x + 0.08, -0.35)], "A-SIMBOLO")
        d.text((1.50, -1.45), "INGRESO VEHICULAR", 1.4, "A-TEXTO", bold=True)
        d.pline([(3.12, 3.95), (3.12, Y0 - 0.02)], "A-SIMBOLO")
        d.pline([(3.04, Y0 - 0.17), (3.12, Y0 - 0.02), (3.20, Y0 - 0.17)], "A-SIMBOLO")
        d.text((3.12, 3.72), "INGRESO", 1.4, "A-TEXTO", bold=True)
        d.text((5.25, 11.55), "BARRA", 1.3, "A-TEXTO-AREA")
        d.text((5.70, 14.05), "ISLA", 1.3, "A-TEXTO-AREA")
    elif level == 2:
        balconies(d)
        cover_ribs(d, 0.0, 8.0, 0.05, Y0 - BAL_D, "A-VISTA-LEJOS", 0.50)
        rect(d, 0.0, 0.05, 8.0, Y0 - 0.05, "A-PROYECCION")
        d.text((4.0, 2.30), "COBERTURA DE LA COCHERA", 1.7, "A-TEXTO", bold=True)
        d.text((4.0, 1.95), "proyección superior +5.10 a +5.60 · panel TR4 + policarbonato", 1.3, "A-TEXTO-AREA")
    else:
        rect(d, 0.0, Y0 + 0.05, 8.0, YB - 0.05, "A-PROYECCION")
        for p in prisms_of("columna_met"):
            if p.name.startswith("COL CT"):
                y1, y2, _, _ = p.yz_bounds()
                d.poly([(p.x1, y1), (p.x2, y1), (p.x2, y2), (p.x1, y2)], "S-METALICA", fill="#24435c", lw=0.25)
        cover_ribs(d, 0.0, 8.0, 0.05, 3.70, "A-VISTA-LEJOS")
        d.poly([(0, 3.70), (8, 3.70), (8, 4.95), (0, 4.95)], "A-VENTANA", fill="#eef5f7", lw=0.09)
        rect(d, 0.0, 0.05, 8.0, 4.95, "A-VISTA")
        d.text((4.0, 2.30), "TECHO DE LA COCHERA (NIVEL INFERIOR)", 1.7, "A-TEXTO", bold=True)
        d.text((4.0, 9.10), "PROYECCIÓN COBERTURA TERRAZA (h libre 2.00 a 2.55 m)", 1.2, "A-TEXTO-AREA")
        d.text((6.0, 15.40), "TENDAL", 1.3, "A-TEXTO-AREA")
        d.text((5.7, 16.10), "LAVANDERÍA", 1.3, "A-TEXTO-AREA")
    d.pline([(0, 0), (LOT_X, 0), (LOT_X, LOT_Y), (0, LOT_Y)], "A-LOTE", closed=True)
    d.line((-1.0, -1.2), (9.0, -1.2), "A-PROYECCION")
    d.text((6.5, -0.60), "VEREDA", 1.5, "A-TEXTO-AREA")
    d.text((4.0, -1.85), "CALLE", 2.2, "A-TEXTO", bold=True)
    grid_and_dims(d, level)
    section_marks(d)
    north(d, LOT_X + 1.15, -1.6)
    return d


def roof_plan():
    d = Drawing("PLANTA DE TECHOS")
    rect(d, 0.0, Y0, 8.0, YB, "A-PROYECCION")
    # cochera
    cover_ribs(d, 0.0, 8.0, 0.05, 3.70, "A-VISTA-LEJOS")
    d.poly([(0, 3.70), (8, 3.70), (8, 4.95), (0, 4.95)], "A-VENTANA", fill="#e7f1f4", hatch="vidrio", lw=0.13)
    rect(d, 0.0, 0.05, 8.0, 4.95, "A-VISTA", lw=0.35)
    rect(d, 0.05, 0.0, 7.95, 0.20, "A-SANITARIO")
    for xc in STRIP_COLS_X:
        d.circle((xc + (0.14 if xc < 4 else -0.14), 0.10), 0.05, "A-SANITARIO")
    _slope_arrow(d, (0.80, 4.55), (0.80, 0.55), "PEND. 10 %")
    d.text((4.0, 2.55), "COBERTURA DE LA COCHERA", 2.0, "A-TEXTO", bold=True)
    d.text((4.0, 2.15), "Panel TR4 e = 50 mm · +5.60 → +5.10", 1.4, "A-TEXTO-AREA")
    d.text((4.0, 4.40), "Franja de POLICARBONATO 10 mm (luz a la fachada)", 1.4, "A-TEXTO", bold=True)
    d.text((4.0, 0.50), "Canaleta 200x150 + 2 bajantes Ø3\"", 1.2, "A-TEXTO-AREA")
    # terraza
    cover_ribs(d, 0.0, 8.0, Y0 + 0.05, 16.10, "A-VISTA-LEJOS")
    d.poly([(0.0, 16.10), (8.0, 16.10), (8.0, YB - 0.05), (0.0, YB - 0.05)], "A-VENTANA", fill="#e7f1f4", hatch="vidrio", lw=0.13)
    rect(d, 0.0, Y0 + 0.05, 8.0, YB - 0.05, "A-VISTA", lw=0.35)
    rect(d, 0.05, YB - 0.20, 7.95, YB - 0.02, "A-SANITARIO")
    for (x1, y1, x2, y2) in DUCTS:
        rect(d, x1, y1, x2, y2, "A-PROYECCION")
    _slope_arrow(d, (0.80, 5.60), (0.80, 15.6), "PEND. 5 %")
    d.text((3.9, 12.40), "COBERTURA DE LA TERRAZA", 2.0, "A-TEXTO", bold=True)
    d.text((3.9, 12.00), "Panel termoacústico TR4 e = 50 mm · +8.60 → +8.00", 1.4, "A-TEXTO-AREA")
    d.text((3.9, 16.55), "Banda de policarbonato sobre los ductos de luz", 1.2, "A-TEXTO", bold=True)
    d.text((3.9, 15.75), "Canaleta 200x150 → 2 bajantes Ø3\" por los ductos", 1.2, "A-TEXTO-AREA")
    d.pline([(0, 0), (LOT_X, 0), (LOT_X, LOT_Y), (0, LOT_Y)], "A-LOTE", closed=True)
    for k, y in GRID_H.items():
        d.line((-1.2, y), (8.6, y), "A-EJES")
        d.circle((-1.5, y), 0.28, "A-EJES"); d.text((-1.5, y), k, 2.5, "A-TEXTO", bold=True)
    for k, x in GRID_V.items():
        d.line((x, -0.5), (x, LOT_Y + 1.2), "A-EJES")
        d.circle((x, LOT_Y + 1.5), 0.28, "A-EJES"); d.text((x, LOT_Y + 1.5), k, 2.5, "A-TEXTO", bold=True)
    dims_along_y(d, 0.0, [0, Y0, LOT_Y], 0.75)
    dims_along_x(d, LOT_Y, [0, LOT_X], 0.75)
    d.text((4.0, -0.9), "CALLE", 2.2, "A-TEXTO", bold=True)
    north(d, LOT_X + 1.0, -0.8)
    return d


def cover_structure_plan():
    d = Drawing("ESTRUCTURA DE COBERTURAS METÁLICAS")
    rect(d, 0.0, Y0, 8.0, YB, "A-PROYECCION")
    d.poly([(0.05, 4.90), (7.95, 4.90), (7.95, 5.00), (0.05, 5.00)], "S-METALICA", fill="#5d7a92", lw=0.18)
    d.poly([(0.05, STRIP_COL_Y - 0.075), (7.95, STRIP_COL_Y - 0.075), (7.95, STRIP_COL_Y + 0.075), (0.05, STRIP_COL_Y + 0.075)],
           "S-METALICA", fill="#5d7a92", lw=0.18)
    for xc in RAFTERS:
        d.poly([(xc - 0.05, 0.05), (xc + 0.05, 0.05), (xc + 0.05, 4.95), (xc - 0.05, 4.95)], "S-METALICA", fill="#9fb3c3", lw=0.18)
    for yc in (0.20, 0.95, 1.70, 2.45, 3.20, 3.95, 4.70):
        d.line((0.05, yc), (7.95, yc), "S-METALICA", lw=0.13)
    strip_steel(d)
    for (xa, xb) in ((RAFTERS[0], RAFTERS[1]), (RAFTERS[-2], RAFTERS[-1])):
        d.line((xa, 0.95), (xb, 3.95), "S-METALICA-PROY")
        d.line((xb, 0.95), (xa, 3.95), "S-METALICA-PROY")
    for xc in (0.20, AX_X["B"], 7.80):
        d.poly([(xc - 0.05, Y0 + 0.05), (xc + 0.05, Y0 + 0.05), (xc + 0.05, YB - 0.05), (xc - 0.05, YB - 0.05)], "S-METALICA", fill="#9fb3c3", lw=0.18)
        for yc in (5.20, AX_Y["2"], AX_Y["3"], 16.80):
            d.poly([(xc - 0.05, yc - 0.05), (xc + 0.05, yc - 0.05), (xc + 0.05, yc + 0.05), (xc - 0.05, yc + 0.05)],
                   "S-METALICA", fill="#1c2a36", lw=0.25)
    for yc in [5.25 + i * 1.0 for i in range(12)] + [16.85]:
        d.line((0.05, yc), (7.95, yc), "S-METALICA", lw=0.13)
    T = ["(1) VM-2 TUBO 150x300x4 sobre 2 columnas CM-1 150x150x4 con pedestales de C°A°",
         "(2) AN-1 ÁNGULO L100x100x6 anclado a la viga de borde (lado vivienda)",
         "(3) VM-1 TUBO 100x200x3 @1.233 · correas CO-1 50x100x2 @0.75 · arriostres Ø1/2\"",
         "(4) VT-1 TUBO 100x250x3 (3 ejes) · CT-1 TUBO 100x100x3 (12 und.) sobre columnas C°A° · CO-1 @1.00"]
    for i, s_ in enumerate(T):
        d.text((-0.6, -1.0 - i * 0.55), s_, 1.5, "A-TEXTO", bold=(i == 0), ha="left")
    for p, s_ in (((2.15, 0.62), "(1)"), ((2.15, 4.42), "(2)"), ((2.15, 2.10), "(3)"), ((2.10, 9.80), "(4)")):
        d.circle(p, 0.30, "A-TEXTO", fill="#ffffff"); d.text(p, s_, 1.6, "A-TEXTO", bold=True)
    dims_along_x(d, YB, [0.0] + RAFTERS + [8.0], 0.75)
    dims_along_y(d, 0.0, [0, STRIP_COL_Y, 4.95, 5.20, AX_Y["2"], AX_Y["3"], 16.80, YB], 0.75)
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
    "celosia": ("#b07a45", None), "mobiliario": ("#ffffff", None), "jardin": ("#c3d9b3", None),
    "baranda": ("#d7ebf3", None), "lucernario": ("#bcd9e6", None), "pedestal": ("#7a7772", "concreto"),
    "vehiculo": ("#ffffff", None),
}
ELEV_FILL = {
    "muro_blanco": "#fbfaf6", "muro_gris": "#efede7", "muro_int": "#f7f5f0", "concreto": "#e6e3dd",
    "concreto_visto": "#cbc7c0", "vidrio": "#d4e7ef", "aluminio": "#4b5157", "madera": "#d6a36c",
    "madera_osc": "#8b5a33", "acero": "#5b636b", "acero_galv": "#c3c8cc", "panel_tr4": "#6b7178",
    "policarbonato": "#eef5f7", "verde": "#a9c999", "verde_claro": "#bcd8a8", "maceta": "#b08a70",
    "pintura_1": "#f2f3f4", "pintura_2": "#7d97b3", "vidrio_auto": "#5f6d76", "llanta": "#2b2c2e", "aro": "#c9cdd0",
    "plastico": "#4a4b4d", "faro": "#ffffff", "faro_post": "#c85c56", "piso_cochera": "#e2ded6",
}
MERGE_CATS = {"vehiculo", "jardin", "mobiliario", "escalera"}


def _project(prisms, mode, c, look):
    """Devuelve [(Polygon_uz, depth, prism, is_cut)].
    mode 'x': plano x=c; look +1 mira hacia +x (u = LOT_Y - y), look -1 hacia -x (u = y, calle a la izquierda).
    mode 'y': plano y=c; look +1 mira hacia +y (u = x),        look -1 hacia -y (u = LOT_X - x)."""
    out = []
    for p in prisms:
        P = Polygon(p.poly)
        if not P.is_valid:
            P = P.buffer(0)
        if mode == "x":
            if look > 0:
                if p.x2 <= c:
                    continue
                cutting = p.x1 < c
                depth = 0.0 if cutting else p.x1 - c
                Q = Polygon([(LOT_Y - y, z) for (y, z) in P.exterior.coords])
            else:
                if p.x1 >= c:
                    continue
                cutting = p.x2 > c
                depth = 0.0 if cutting else c - p.x2
                Q = P
            out.append((Q, depth, p, cutting))
        else:
            ux = (lambda x: x) if look > 0 else (lambda x: LOT_X - x)
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
    merged, rest = OrderedDict(), []
    for g, depth, p, cutting in out:
        if p.cat in MERGE_CATS and p.group:
            key = (p.group, cutting)
            if key in merged:
                G, D, P0, C0 = merged[key]
                merged[key] = (G.union(g), min(D, depth), P0, C0)
            else:
                merged[key] = (g, depth, p, cutting)
        else:
            rest.append((g, depth, p, cutting))
    return rest + list(merged.values())


def section_view(mode, c, look, title, elevation=False, hide_fur=False, umin=None, umax=None):
    d = Drawing(title)
    P = [p for p in all_prisms() if not (hide_fur and p.cat in ("mobiliario", "vehiculo"))]
    if elevation:
        P = [p for p in P if p.cat != "cimentacion"]
    items = _project(P, mode, c, look)
    if umin is None:
        umin, umax = (-1.5, LOT_Y + 0.3) if mode == "x" else (-0.4, LOT_X + 0.4)
    occl = []
    if not elevation:
        earth = sbox(umin, -1.9, umax, -0.15)
        d.poly(list(earth.exterior.coords)[:-1], "A-TERRENO", fill="#ece6da", hatch="tierra", lw=0.0, edge=False)
        occl.append(earth)
    else:
        occl.append(sbox(umin - 5, -6, umax + 5, -0.16))
    for g, _, p, _ in [it for it in items if it[3]]:
        fill, hatch = POCHE.get(p.cat, ("#777777", None))
        lay = "A-CORTE" if p.cat not in ("mobiliario", "jardin", "baranda", "ventana", "vehiculo") else "A-VISTA"
        draw_shapely(d, g, lay, fill=fill, hatch=hatch, lw=0.40 if lay == "A-CORTE" else 0.18)
        if p.cat not in TRANSPARENT:
            occl.append(g)
    occ = unary_union(occl)
    beyond = sorted([it for it in items if not it[3]], key=lambda t: t[1])
    for g, depth, p, _ in beyond:
        vis = g.difference(occ)
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
    xs = xr + 3.2
    for a, b in zip([m[0] for m in marks][:-1], [m[0] for m in marks][1:]):
        d.dim((xs, a), (xs, b), -0.001)
    if not elevation:
        lab = {1: 1.35, 2: LV[2] + 1.35, 3: LV[3] + 1.35}
        for r in build_rooms():
            if r.name.startswith(("BAÑO", "BALCÓN")) or r.name == "HALL":
                continue
            x1, y1, x2, y2 = r.rect
            if mode == "x" and x1 < c < x2:
                u = (LOT_Y - (y1 + y2) / 2) if look > 0 else (y1 + y2) / 2
                z = 3.60 if r.name.startswith("COCHERA") else lab[r.level]
                d.text((u, z), r.name, 1.5, "A-TEXTO", bold=True)
            if mode == "y" and y1 < c < y2:
                u = (x1 + x2) / 2 if look > 0 else LOT_X - (x1 + x2) / 2
                d.text((u, lab[r.level]), r.name, 1.5, "A-TEXTO", bold=True)
        if mode == "x":
            u = LOT_Y - 2.5 if look > 0 else 2.5
            d.text((u, strip_top(2.5) + 0.40), "COBERTURA COCHERA PEND. 10 %", 1.5, "A-TEXTO", bold=True)
            u = LOT_Y - 10.0 if look > 0 else 10.0
            d.text((u, terrace_top(10.0) + 0.40), "COBERTURA TERRAZA PEND. 5 %", 1.5, "A-TEXTO", bold=True)


def _notes(d, notes, ha="left"):
    for (t, p, s) in notes:
        d.line(t, p, "A-COTA", lw=0.13)
        d.circle(p, 0.006, "A-COTA", fill="#202020")
        d.text((t[0] + (0.02 if ha == "left" else -0.02), t[1]), s, 2.0, "A-TEXTO", ha=ha)


def detail_views():
    """Detalles de la cobertura de la cochera: corte por la columna CM-1 de x = 0.30, mirando a -x (u = y)."""
    base = section_view("x", STRIP_COLS_X[0], -1, "CORTE POR COLUMNA CM-1", hide_fur=True)
    t = strip_top
    yc = STRIP_COL_Y
    d1 = Drawing("DETALLE 1"); d1.extend(base)
    notes1 = [((1.10, 0.80), (yc + 0.03, 0.70), "COLUMNA CM-1 TUBO LAC 150x150x4"),
              ((1.10, 0.66), (yc + 0.10, 0.507), "PLANCHA BASE 300x300x12 + GROUT"),
              ((1.10, 0.52), (yc + 0.10, 0.30), "4 PERNOS ANCLAJE Ø5/8\" L=0.50"),
              ((1.10, 0.20), (yc + 0.15, 0.10), "PEDESTAL C°A° 0.40x0.40 h=1.10"),
              ((1.10, -0.10), (0.90, -0.10), "LOSA COCHERA e=0.10 + CONTRAPISO"),
              ((1.10, -0.90), (0.70, -0.90), "ZAPATA 0.90x0.90x0.60 f'c=210"),
              ((1.10, -1.30), (0.60, -1.25), "SOLADO e=0.10 / TERRENO NATURAL")]
    _notes(d1, notes1)
    n1 = Drawing("NOTAS D1"); n1.items = d1.items[len(base.items):]
    d2 = Drawing("DETALLE 2"); d2.extend(base)
    zl = t(4.95)
    notes2 = [((3.40, 6.10), (4.5, t(4.5) - 0.006), "POLICARBONATO ALVEOLAR 10 mm"),
              ((3.40, 6.00), (4.70, t(4.70) - 0.10), "CORREA CO-1 TUBO 50x100x2"),
              ((3.40, 5.90), (4.10, t(4.10) - 0.25), "VIGA VM-1 TUBO 100x200x3 @1.233"),
              ((3.40, 4.95), (4.95, zl - 0.45), "ÁNGULO AN-1 L100x100x6 + PERNOS Ø5/8\" @0.60"),
              ((3.40, 4.85), (5.10, 5.40), "VIGA DE BORDE C°A° 0.25x0.40"),
              ((3.40, 4.75), (5.05, 4.80), "MURO 2do PISO + SELLO POLIURETANO")]
    _notes(d2, notes2, "right")
    n2 = Drawing("NOTAS D2"); n2.items = d2.items[len(base.items):]
    return d1, d2, base, n1, n2


def all_views():
    V = {}
    V["P1"] = plan_view(1)
    V["P2"] = plan_view(2)
    V["P3"] = plan_view(3)
    V["PT"] = roof_plan()
    V["PE"] = cover_structure_plan()
    for k in "ABCD":
        mode, c, look = SECTIONS[k]
        V["S" + k] = section_view(mode, c, look, f"CORTE {k}-{k}")
    V["EF"] = section_view("y", -30.0, 1, "ELEVACIÓN PRINCIPAL (CALLE)", elevation=True)
    V["D1"], V["D2"], V["_DB"], V["_N1"], V["_N2"] = detail_views()
    return V
