"""Generacion de vistas 2D (plantas, cortes, elevaciones) desde el modelo."""
import math
from shapely.geometry import Polygon, box as sbox, LineString, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from model import (build_walls, build_rooms, all_prisms, LV, AX_X, AX_Y, ST_X_A, ST_X_B, ST_Y_FL,
                   ST_Y_LAND, TREAD, roof_top, TE, TI, LEVEL_NAMES)
from drawing import Drawing

COLS = None


def columns():
    """Rectangulos de columnas de concreto en planta."""
    global COLS
    if COLS is None:
        COLS = {}
        for p in all_prisms():
            if p.cat == "columna":
                y1, y2, z1, z2 = p.yz_bounds()
                COLS[p.name] = (p.x1, y1, p.x2, y2)
    return list(COLS.values())


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
        pts = list(pg.exterior.coords)[:-1]
        d.poly(pts, layer, fill=fill, hatch=hatch, lw=lw, edge=edge, alpha=alpha)
        for hole in pg.interiors:
            d.poly(list(hole.coords)[:-1], layer, fill="#ffffff", lw=lw, edge=edge)


def rect(d, x1, y1, x2, y2, layer, **kw):
    d.pline([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], layer, closed=True, **kw)


# ---------------------------------------------------------------------------
# PLANTAS
# ---------------------------------------------------------------------------
def opening_symbol(d, w, o):
    x1, y1, x2, y2 = w.rect()
    t = w.t
    width = o.s2 - o.s1
    if w.horizontal:
        yc = w.a[1]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hx = o.s1 if o.hinge == "a" else o.s2
            # local: bisagra (0,t/2), hoja hacia +y local; mapear a la pared
            if o.side > 0:
                rot = 0 if o.hinge == "a" else 0
                sx = 1 if o.hinge == "a" else -1
                d.insert(name, (hx, yc), rot, sx, 1)
            else:
                sx = 1 if o.hinge == "a" else -1
                d.insert(name, (hx, yc), 0, sx, -1)
        elif o.kind == "slide":
            d.insert(f"CORREDIZA_{width:.2f}_{t:.2f}", (o.s1, yc), 0)
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (o.s1, yc), 0)
        tag_pos = ((o.s1 + o.s2) / 2, yc + (0.42 if yc < 3.5 else -0.42) * (1 if o.kind == "window" else -1))
    else:
        xc = w.a[0]
        if o.kind in ("door", "door2"):
            name = ("PIVOT" if o.kind == "door2" else "PUERTA") + f"_{width:.2f}_{t:.2f}"
            hy = o.s1 if o.hinge == "a" else o.s2
            # rot -90: local +y -> global +x ; local +x -> global -y
            if o.side > 0:
                d.insert(name, (xc, hy), -90, -1 if o.hinge == "a" else 1, 1)
            else:
                d.insert(name, (xc, hy), 90, 1 if o.hinge == "a" else -1, 1)
        else:
            d.insert(f"VENTANA_{width:.2f}_{t:.2f}", (xc, o.s1), 90)
        tag_pos = (xc - 0.32 * o.side, (o.s1 + o.s2) / 2)
    d.text(tag_pos, o.name, 1.6, "A-TEXTO-AREA", bold=True)


def stair_plan(d, level):
    xa1, xa2 = ST_X_A
    xb1, xb2 = ST_X_B
    y0, y1 = ST_Y_FL
    yl0, yl1 = ST_Y_LAND
    brk = 1.80   # linea de corte del tramo que sube
    up = level <= 3
    down = level >= 2
    # tramo B: si viene del nivel inferior es visible; si sube desde el descanso esta sobre el corte
    for i in range(8):
        y = y0 + i * TREAD
        d.line((xb1, y), (xb2, y), "A-ESCALERA" if down else "A-PROYECCION")
    rect(d, xb1, y0, xb2, y1, "A-ESCALERA" if down else "A-PROYECCION")
    if up:
        for i in range(8):
            y = y1 - i * TREAD
            lay = "A-ESCALERA" if y >= brk else "A-PROYECCION"
            d.line((xa1, y), (xa2, y), lay)
        d.line((xa1, y0), (xa1, y1), "A-ESCALERA")
        d.line((xa2, brk), (xa2, y1), "A-ESCALERA")
        d.line((xa2, y0), (xa2, brk), "A-PROYECCION")
        d.pline([(xa1, brk - 0.10), (xa2, brk + 0.10)], "A-ESCALERA", lw=0.25)
        # flecha SUBE
        xm = (xa1 + xa2) / 2
        d.pline([(xm, 2.90), (xm, 0.80)], "A-ESCALERA")
        d.pline([(xm - 0.08, 0.95), (xm, 0.80), (xm + 0.08, 0.95)], "A-ESCALERA")
        d.circle((xm, 2.90), 0.04, "A-ESCALERA", fill="#333333")
        d.text((xm, 2.55), "SUBE", 1.5, "A-TEXTO", rot=90)
    rect(d, 0.25, yl0, 2.15, yl1, "A-ESCALERA" if (down and not up) else "A-PROYECCION")
    if down:
        xm = (xb1 + xb2) / 2
        d.pline([(xm, 2.90), (xm, 1.10)], "A-ESCALERA")
        d.pline([(xm - 0.08, 2.75), (xm, 2.90), (xm + 0.08, 2.75)], "A-ESCALERA")
        d.text((xm, 2.25), "BAJA", 1.5, "A-TEXTO", rot=90)
    # baranda central
    d.line((1.20, y0), (1.20, y1), "A-ESCALERA", lw=0.25)
    for i in range(1, 8):
        d.text(((xa1 + xa2) / 2 + 0.33, y1 - (i - 0.5) * TREAD), str(i), 1.0, "A-TEXTO-AREA") if up and y1 - i * TREAD >= brk else None


def room_label(d, r, npt):
    x, y = r.label_at
    d.text((x, y + 0.16), r.name, 2.2, "A-TEXTO", bold=True)
    if r.name not in ("JARDÍN INTERIOR", "DEPÓSITO"):
        d.text((x, y - 0.10), f"A = {r.area:.2f} m²", 1.6, "A-TEXTO-AREA")
        tag = f"NPT {npt:+.2f}"
        d.text((x, y - 0.34), tag, 1.5, "A-TEXTO-AREA")
        w = 0.0065 * len(tag) * 50 / 1.0 * 0.11
        rect(d, x - 0.36, y - 0.44, x + 0.36, y - 0.24, "A-TEXTO-AREA", lw=0.09)


def tiles(d, x1, y1, x2, y2, step=0.30, layer="A-PISO"):
    x = x1 + step
    while x < x2 - 1e-6:
        d.line((x, y1), (x, y2), layer, lw=0.05)
        x += step
    y = y1 + step
    while y < y2 - 1e-6:
        d.line((x1, y), (x2, y), layer, lw=0.05)
        y += step


def grid_and_dims(d, level, full=True):
    ymax = 12.0 if full else 7.0
    # ejes
    for k, x in AX_X.items():
        d.line((x, -2.55), (x, ymax + 0.9), "A-EJES")
        d.circle((x, -2.85), 0.28, "A-EJES")
        d.text((x, -2.85), k, 2.5, "A-TEXTO", bold=True)
    for k, y in AX_Y.items():
        d.line((-2.55, y), (8.6, y), "A-EJES")
        d.circle((-2.85, y), 0.28, "A-EJES")
        d.text((-2.85, y), k, 2.5, "A-TEXTO", bold=True)
    if full:
        d.line((-2.55, 11.525), (8.6, 11.525), "A-EJES")
        d.circle((-2.85, 11.525), 0.28, "A-EJES")
        d.text((-2.85, 11.525), "D", 2.5, "A-TEXTO", bold=True)
    # cotas frontales
    if level == 1:
        ch = [0, 0.25, 2.15, 2.45, 3.45, 3.75, 7.45, 7.75, 8.0]
    else:
        ch = [0, 0.25, 2.15, 2.30, 5.30, 5.45, 7.75, 8.0]
    chain(d, [(x, 0) for x in ch], "h", -0.95)
    chain(d, [(x, 0) for x in AX_X.values()], "h", -1.55)
    chain(d, [(0, 0), (8, 0)], "h", -2.10)
    # cotas laterales izquierdas
    ys = [0, 0.25, 1.25, 3.00, 5.10, 5.25, 6.75, 7.0]
    ys = sorted(set(ys))
    if full:
        ys += [11.75, 12.0]
    chain(d, [(0, y) for y in ys], "v", -0.95)
    ax = list(AX_Y.values()) + ([11.525] if full else [])
    chain(d, [(0, y) for y in ax], "v", -1.55)
    chain(d, [(0, 0), (0, 7.0)] + ([(0, 12.0)] if full else []), "v", -2.10)
    # cotas laterales derechas
    if level == 1:
        yr = [0, 0.25, 3.90, 4.05, 6.75, 7.0]
    else:
        yr = [0, 0.25, 2.05, 2.20, 3.90, 4.05, 6.75, 7.0]
    chain(d, [(8, y) for y in yr], "v", 0.75, right=True)


def chain(d, pts, orient, off, right=False):
    for a, b in zip(pts[:-1], pts[1:]):
        if orient == "h":
            d.dim((a[0], a[1]), (b[0], b[1]), off)          # off negativo = abajo
        else:
            if right:
                d.dim((a[0], a[1]), (b[0], b[1]), -off)
            else:
                d.dim((a[0], a[1]), (b[0], b[1]), -off)


def section_marks(d, full=True):
    yb = 12.95 if full else 7.95
    for (lbl, x) in (("A", 1.70), ("B", 4.00)):
        for y, sgn in ((-3.35, 1), (yb, -1)):
            d.line((x, y), (x, y + 0.45 * sgn), "A-SIMBOLO", lw=0.5)
            d.circle((x - 0.32, y), 0.24, "A-SIMBOLO")
            d.text((x - 0.32, y), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x - 0.05, y + 0.10), (x - 0.05, y - 0.10), (x - 0.30, y)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
        d.line((x, -3.35), (x, yb), "A-SIMBOLO", lw=0.09, ls="DASHDOT")
    for (lbl, y, look) in (("C", 2.00, 1),) + ((("D", 9.40, -1),) if full else ()):
        for x in (-3.35, 8.95):
            d.line((x, y), (x + (0.45 if x < 0 else -0.45), y), "A-SIMBOLO", lw=0.5)
            d.circle((x, y + 0.32 * look), 0.24, "A-SIMBOLO")
            d.text((x, y + 0.32 * look), lbl, 2.2, "A-TEXTO", bold=True)
            d.poly([(x - 0.10, y + 0.05 * look), (x + 0.10, y + 0.05 * look), (x, y + 0.30 * look)], "A-SIMBOLO", fill="#1a1a1a", edge=False)
        d.line((-3.35, y), (8.95, y), "A-SIMBOLO", lw=0.09, ls="DASHDOT")


def north(d, x, y):
    d.circle((x, y), 0.45, "A-SIMBOLO")
    d.poly([(x, y + 0.42), (x - 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#1a1a1a")
    d.poly([(x, y + 0.42), (x + 0.15, y - 0.25), (x, y - 0.10)], "A-SIMBOLO", fill="#ffffff")
    d.text((x, y + 0.70), "N", 2.5, "A-TEXTO", bold=True)


def cover_outline(d, layer="A-PROYECCION", ribs=False):
    rect(d, 0.0, 7.0, 8.0, 12.0, layer)
    d.line((0, 9.0), (8, 9.0), layer)
    d.line((0, 10.2), (8, 10.2), layer)
    if ribs:
        x = 0.25
        while x < 8.0:
            d.line((x, 7.20), (x, 9.0), "A-PISO", lw=0.05)
            d.line((x, 10.2), (x, 12.0), "A-PISO", lw=0.05)
            x += 0.25


def plan_view(level):
    d = Drawing(f"PLANTA {LEVEL_NAMES[level]}")
    npt = LV[level]
    walls = [w for w in build_walls() if w.level == level]
    full = True
    cols = [sbox(*c) for c in columns()]
    # muros
    wall_geo = unary_union([sbox(*w.rect()) for w in walls if w.kind != "parapeto"])
    cut = []
    for w in walls:
        x1, y1, x2, y2 = w.rect()
        for o in w.openings:
            if w.horizontal:
                cut.append(sbox(o.s1, y1 - 0.01, o.s2, y2 + 0.01))
            else:
                cut.append(sbox(x1 - 0.01, o.s1, x2 + 0.01, o.s2))
    col_geo = unary_union(cols)
    if level >= 2:     # aletas del marco volado (concreto)
        col_geo = unary_union([col_geo, sbox(7.75, -0.50, 8.0, 0.0), sbox(2.15, -0.50, 2.40, 0.0)])
    wall_geo = wall_geo.difference(unary_union(cut)).difference(col_geo)
    # pisos (antes que los muros)
    if level == 1:
        x = 0.25
        while x < 7.75:
            d.line((x, 7.0), (x, 11.30), "A-PISO", lw=0.05)
            x += 0.15
        d.pline([(0.25, 0.25), (2.15, 0.25), (2.15, 1.25), (0.25, 1.25)], "A-JARDIN", closed=True)
        for (px, py) in [(0.55, 0.55), (0.9, 0.95), (1.3, 0.5), (1.75, 0.95), (1.6, 0.6), (0.4, 1.05)]:
            d.circle((px, py), 0.03, "A-JARDIN")
        d.insert("PLANTA_0.22", (0.65, 0.65)); d.insert("PLANTA_0.18", (1.65, 0.75))
        tiles(d, 0.25, 5.25, 2.15, 6.75)
    else:
        tiles(d, 5.45, 0.25, 7.75, 2.05); tiles(d, 6.15, 4.05, 7.75, 6.75)
    draw_shapely(d, wall_geo, "A-MURO", fill="#d8d3ca", hatch="muro", lw=0.35)
    draw_shapely(d, col_geo.intersection(sbox(-1, -1, 9, 12.5)), "S-COLUMNA", fill="#1c1c1c", lw=0.35)
    # vanos
    for w in walls:
        for o in w.openings:
            opening_symbol(d, w, o)
    # linterna: muro cortina + celosia
    d.line((0.25, 0.20), (2.10, 0.20), "A-VENTANA", lw=0.25)
    d.line((0.25, 0.23), (2.10, 0.23), "A-VENTANA", lw=0.25)
    x = 0.28
    while x < 2.08:
        d.poly([(x, -0.14), (x + 0.04, -0.14), (x + 0.04, -0.04), (x, -0.04)], "A-MOBILIARIO", fill="#b07a45", lw=0.05)
        x += 0.11
    stair_plan(d, level)
    rooms = [r for r in build_rooms() if r.level == level]
    for r in rooms:
        room_label(d, r, npt if r.name != "TERRAZA - PARRILLA" else -0.02)
    if level == 1:
        _furn_level1(d)
    else:
        _furn_upper(d, level)
    # contexto: lote, vereda, cobertura
    d.pline([(0, 0), (8, 0), (8, 12), (0, 12)], "A-LOTE", closed=True)
    d.line((-1.2, -1.20), (9.2, -1.20), "A-PROYECCION")
    d.text((5.2, -0.60), "VEREDA", 1.6, "A-TEXTO-AREA")
    if level == 1:
        cover_outline(d)
        for x in (0.40, 7.45):
            d.poly([(x, 11.45), (x + 0.15, 11.45), (x + 0.15, 11.60), (x, 11.60)], "S-METALICA", fill="#24435c")
        for i in range(6):
            xc = 0.375 + i * 1.45
            d.line((xc, 7.10), (xc, 11.95), "S-METALICA-PROY")
        d.text((4.0, 7.45), "PROYECCIÓN DE COBERTURA LIVIANA (h = +3.05 a +3.55)", 1.5, "A-TEXTO-AREA")
        d.pline([(2.6, -0.45), (2.95, -0.05)], "A-SIMBOLO")
        d.text((2.95, -0.75), "INGRESO", 1.8, "A-TEXTO", bold=True)
        d.pline([(2.95, -1.0), (2.95, -0.30)], "A-SIMBOLO")
        d.pline([(2.88, -0.42), (2.95, -0.30), (3.02, -0.42)], "A-SIMBOLO")
        d.circle((5.5, 9.95), 0.08, "A-SANITARIO")
        d.text((5.5, 9.72), "SUMIDERO Ø3\"", 1.2, "A-TEXTO-AREA")
    else:
        # volado/alero del marco (nivel 2) y cobertura del nivel inferior
        if level == 2:
            rect(d, 2.40, -0.50, 7.75, 0.0, "A-MOBILIARIO")
        d.line((2.60, -0.05), (5.00, -0.05), "A-VENTANA", lw=0.25)
        d.text((3.8, -0.30), "BARANDA DE VIDRIO TEMPLADO h=0.90", 1.2, "A-TEXTO-AREA")
        cover_outline(d, "A-PISO", ribs=True)
        d.text((4.0, 8.4), "TECHO DE COBERTURA LIVIANA (NIVEL INFERIOR)", 1.6, "A-TEXTO-AREA")
        d.text((4.0, 9.6), "FRANJA DE POLICARBONATO ALVEOLAR 10 mm", 1.4, "A-TEXTO-AREA")
    grid_and_dims(d, level, full)
    section_marks(d, full)
    north(d, 9.4, 11.3)
    return d


def _furn_level1(d):
    # sala
    d.insert("SOFA_2.20_0.90", (6.85, 3.10), -90)
    d.insert("MESACENTRO_0.80_1.00", (5.60, 1.50))
    d.insert("SILLON", (4.40, 1.00), -90 + 180)
    d.insert("SILLON", (4.40, 2.30), -90 + 180)
    d.insert("PLANTA_0.25", (2.75, 0.75))
    # comedor
    d.insert("MESA_1.80_0.90_3", (2.75, 4.95))
    # cocina
    d.insert("REFRI", (7.75, 4.10), 90)
    d.insert("MUEBLE_1.95", (7.75, 4.85), 90)
    d.insert("COCINA", (7.75, 5.20), 90)
    d.insert("MUEBLE_1.95", (5.20, 6.75), 0, 1, -1)
    d.insert("TARJA", (6.15, 6.75), 0, 1, -1)
    d.pline([(5.30, 4.55), (6.10, 4.55), (6.10, 5.95), (5.30, 5.95)], "A-MOBILIARIO", closed=True)
    for yy in (4.75, 5.25, 5.75):
        d.circle((5.05, yy), 0.17, "A-MOBILIARIO")
    # bano visitas
    d.insert("DUCHA_0.85_0.90", (0.25, 5.85))
    d.insert("INODORO", (1.45, 6.75), 180)
    d.insert("LAVATORIO_0.60", (2.15, 5.40), 90)
    # deposito
    d.text((1.70, 2.35), "DEP.", 1.5, "A-TEXTO-AREA")
    # patio
    d.insert("PARRILLA_2.40", (0.25, 8.00))
    d.insert("MESA_2.00_1.00_3", (3.05, 8.55))
    d.insert("LAVADERO", (7.75, 11.75), 180)
    d.insert("LAVADORA", (6.25, 11.15))
    x = 6.10
    while x < 7.72:
        d.poly([(x, 10.00), (x + 0.04, 10.00), (x + 0.04, 10.08), (x, 10.08)], "A-MOBILIARIO", fill="#b07a45", lw=0.05)
        x += 0.10
    d.text((6.95, 10.55), "LAVANDERÍA / TENDAL", 1.6, "A-TEXTO", bold=True)
    d.pline([(0.25, 11.30), (5.95, 11.30), (5.95, 11.75), (0.25, 11.75)], "A-JARDIN", closed=True)
    for k in range(9):
        d.insert("PLANTA_0.18", (0.55 + k * 0.65, 11.52))
    d.text((3.1, 11.05), "JARDINERA + JARDÍN VERTICAL", 1.4, "A-TEXTO-AREA")
    d.insert("PLANTA_0.40", (7.20, 7.65))


def _furn_upper(d, level):
    # dormitorio frontal
    d.insert("CAMA_1.60_2.00", (3.30, 2.85), -90)
    d.insert("VELADOR", (5.30, 0.78), 90)
    d.insert("VELADOR", (5.30, 2.88), 90)
    d.insert("ESCRITORIO_1.20", (2.30, 0.55), -90)
    # walk-in frontal
    d.insert("CLOSET_1.70_0.60", (7.15, 3.90), -90)
    d.insert("CLOSET_1.20_0.60", (5.95, 3.30))
    # bano frontal
    d.insert("DUCHA_1.00_1.00", (6.75, 0.25))
    d.line((6.75, 1.25), (7.75, 1.25), "A-VENTANA", lw=0.25)
    d.insert("INODORO", (5.75, 0.25))
    d.insert("LAVATORIO_0.90", (5.45, 1.98), -90)
    # dormitorio posterior
    d.insert("CAMA_1.60_2.00", (4.00, 6.20), -90)
    d.insert("VELADOR", (6.00, 4.13), 90)
    d.insert("VELADOR", (6.00, 6.23), 90)
    d.insert("ESCRITORIO_1.10", (2.40, 6.75), 0, 1, -1)
    # bano posterior
    d.insert("DUCHA_1.60_0.80", (6.15, 5.95))
    d.line((6.15, 5.95), (7.75, 5.95), "A-VENTANA", lw=0.25)
    d.insert("INODORO", (7.75, 5.40), 90)
    d.insert("LAVATORIO_0.80", (7.75, 4.20), 90)
    # walk-in nucleo
    d.insert("CLOSET_1.50_0.60", (0.25, 6.75), -90)
    d.insert("CLOSET_1.30_0.55", (0.85, 6.75), 0, 1, -1)
    # estar
    d.pline([(0.30, 3.40), (0.75, 3.40), (0.75, 4.80), (0.30, 4.80)], "A-MOBILIARIO", closed=True)
    d.text((0.52, 4.10), "BANCA", 1.0, "A-TEXTO-AREA", rot=90)


def roof_plan():
    d = Drawing("PLANTA DE TECHOS")
    walls = [w for w in build_walls() if w.level == 4]
    geo = unary_union([sbox(*w.rect()) for w in walls])
    cut = []
    for w in walls:
        x1, y1, x2, y2 = w.rect()
        for o in w.openings:
            cut.append(sbox(x1 - 0.01, o.s1, x2 + 0.01, o.s2))
    cols = unary_union([sbox(*c) for c in columns()])
    geo = geo.difference(unary_union(cut)).difference(cols)
    # azotea
    tiles(d, 2.30, 0.10, 7.75, 6.85, 0.60)
    draw_shapely(d, geo, "A-MURO", fill="#d8d3ca", hatch="muro", lw=0.35)
    draw_shapely(d, cols, "S-COLUMNA", fill="#1c1c1c")
    for w in walls:
        for o in w.openings:
            opening_symbol(d, w, o)
    # caseta: techo + lucernario
    rect(d, 0.0, 0.0, 2.35, 5.25, "A-PROYECCION")
    d.poly([(0.25, 0.25), (2.15, 0.25), (2.15, 3.00), (0.25, 3.00)], "A-VENTANA", fill="#d5e8f0", hatch="vidrio", lw=0.18)
    d.text((1.2, 1.65), "LUCERNARIO\nVIDRIO LAMINADO\n6+6 mm", 1.4, "A-TEXTO")
    stair_plan(d, 4)
    d.text((1.2, 4.45), "CASETA ESC.", 2.0, "A-TEXTO", bold=True)
    d.text((1.2, 4.15), "NPT +8.40  /  TECHO +10.80", 1.3, "A-TEXTO-AREA")
    rect(d, 0.55, 5.55, 1.65, 6.55, "A-MOBILIARIO")
    d.circle((1.10, 6.05), 0.50, "A-MOBILIARIO")
    d.text((1.10, 6.05), "TANQUE\n1100 L", 1.2, "A-TEXTO-AREA")
    d.text((5.0, 4.6), "AZOTEA", 2.5, "A-TEXTO", bold=True)
    d.text((5.0, 4.25), "NPT +8.40 (Fase 2) — NPT +5.60 en Fase 1", 1.4, "A-TEXTO-AREA")
    d.text((5.0, 3.95), "Impermeabilizante + deck WPC", 1.4, "A-TEXTO-AREA")
    for (x, y) in ((7.45, 6.55), (2.60, 6.55)):
        d.circle((x, y), 0.08, "A-SANITARIO")
        d.text((x, y - 0.22), "SUMIDERO", 1.0, "A-TEXTO-AREA")
    _slope_arrow(d, (6.9, 2.0), (6.9, 5.9), "PEND. 1.5 %")
    # marco volado (techo)
    rect(d, 2.15, -0.50, 8.0, 0.0, "A-MOBILIARIO")
    d.text((5.1, -0.25), "MARCO VOLADO DE CONCRETO VISTO", 1.3, "A-TEXTO-AREA")
    # cobertura
    cover_outline(d, "A-VISTA", ribs=True)
    d.poly([(0, 9.0), (8, 9.0), (8, 10.2), (0, 10.2)], "A-VENTANA", fill="#e7f1f4", hatch="vidrio", lw=0.13)
    rect(d, 0.25, 7.00, 7.75, 7.20, "A-SANITARIO")
    for x in (0.35, 7.65):
        d.circle((x, 7.10), 0.05, "A-SANITARIO")
    d.text((4.0, 7.10), "CANALETA GALVANIZADA 200x150 mm → 2 BAJANTES Ø3\"", 1.2, "A-TEXTO-AREA")
    rect(d, 0.40, 8.95, 0.75, 9.30, "A-MOBILIARIO")
    d.text((1.2, 9.12), "CHIMENEA", 1.0, "A-TEXTO-AREA", ha="left")
    _slope_arrow(d, (1.6, 11.6), (1.6, 7.45), "PEND. 10 %")
    d.text((5.4, 8.25), "PANEL TERMOACÚSTICO TR4 e = 50 mm", 1.6, "A-TEXTO", bold=True)
    d.text((5.4, 7.95), "(cara superior acero prepintado / núcleo PIR)", 1.3, "A-TEXTO-AREA")
    d.text((4.0, 9.6), "POLICARBONATO ALVEOLAR 10 mm (FRANJA DE LUZ)", 1.4, "A-TEXTO", bold=True)
    d.text((4.0, 11.25), "COTA +3.55 (LIMATESA POSTERIOR)", 1.3, "A-TEXTO-AREA")
    d.pline([(0, 0), (8, 0), (8, 12), (0, 12)], "A-LOTE", closed=True)
    for k, x in AX_X.items():
        d.line((x, -1.2), (x, 12.9), "A-EJES")
        d.circle((x, -1.5), 0.28, "A-EJES"); d.text((x, -1.5), k, 2.5, "A-TEXTO", bold=True)
    for k, y in list(AX_Y.items()) + [("D", 11.525)]:
        d.line((-1.2, y), (8.6, y), "A-EJES")
        d.circle((-1.5, y), 0.28, "A-EJES"); d.text((-1.5, y), k, 2.5, "A-TEXTO", bold=True)
    chain(d, [(0, 0), (0, 7.0), (0, 12.0)], "v", -0.7)
    chain(d, [(0, 0), (8, 0)], "h", -0.75)
    north(d, 9.4, 11.3)
    return d


def _slope_arrow(d, p1, p2, label):
    d.pline([p1, p2], "A-SIMBOLO", lw=0.25)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    a1 = (p2[0] - 0.22 * math.cos(ang - 0.35), p2[1] - 0.22 * math.sin(ang - 0.35))
    a2 = (p2[0] - 0.22 * math.cos(ang + 0.35), p2[1] - 0.22 * math.sin(ang + 0.35))
    d.poly([p2, a1, a2], "A-SIMBOLO", fill="#1a1a1a", edge=False)
    mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    d.text((mx + 0.18, my), label, 1.6, "A-TEXTO", bold=True, rot=90, va="bottom")


def cover_structure_plan():
    d = Drawing("ESTRUCTURA DE COBERTURA METÁLICA")
    # muros perimetrales del area libre y fachada posterior
    geo = unary_union([sbox(0, 7.0, 0.25, 12.0), sbox(7.75, 7.0, 8.0, 12.0), sbox(0.25, 11.75, 7.75, 12.0),
                       sbox(0, 6.75, 8.0, 7.0)])
    draw_shapely(d, geo, "A-MURO", fill="#d8d3ca", hatch="muro", lw=0.25)
    # angulo de apoyo y viga posterior
    d.poly([(0.25, 7.00), (7.75, 7.00), (7.75, 7.10), (0.25, 7.10)], "S-METALICA", fill="#5d7a92", lw=0.18)
    d.poly([(0.25, 11.45), (7.75, 11.45), (7.75, 11.60), (0.25, 11.60)], "S-METALICA", fill="#5d7a92", lw=0.18)
    for i in range(6):
        xc = 0.375 + i * 1.45
        d.poly([(xc - 0.05, 7.10), (xc + 0.05, 7.10), (xc + 0.05, 11.95), (xc - 0.05, 11.95)], "S-METALICA", fill="#9fb3c3", lw=0.18)
    for yc in (7.40, 8.35, 9.30, 9.95, 10.90, 11.85):
        d.line((0.25, yc - 0.025), (7.75, yc - 0.025), "S-METALICA", lw=0.13)
        d.line((0.25, yc + 0.025), (7.75, yc + 0.025), "S-METALICA", lw=0.13)
    for x in (0.40, 7.45):
        d.poly([(x, 11.45), (x + 0.15, 11.45), (x + 0.15, 11.60), (x, 11.60)], "S-METALICA", fill="#1c2a36", lw=0.25)
    # arriostres en X (cruz de San Andres) en paños extremos
    for (xa, xb) in ((0.375, 1.825), (6.175, 7.625)):
        d.line((xa, 7.40), (xb, 9.30), "S-METALICA-PROY")
        d.line((xb, 7.40), (xa, 9.30), "S-METALICA-PROY")
        d.line((xa, 9.95), (xb, 11.85), "S-METALICA-PROY")
        d.line((xb, 9.95), (xa, 11.85), "S-METALICA-PROY")
    # rotulos
    d.text((1.10, 10.45), "VM-1", 1.8, "A-TEXTO", bold=True)
    d.text((4.0, 11.25), "VM-2  TUBO LAC 150x300x4 mm", 1.5, "A-TEXTO", bold=True)
    d.text((4.0, 7.25), "AN-1  ÁNGULO L100x100x6 + PERNOS EXPANSIVOS Ø5/8\" @ 0.60", 1.3, "A-TEXTO", bold=True)
    d.text((4.0, 8.85), "CO-1  TUBO 50x100x2 mm @ 0.95 m (máx.)", 1.4, "A-TEXTO", bold=True)
    d.text((0.48, 12.25), "CM-1", 1.5, "A-TEXTO", bold=True)
    d.text((7.52, 12.25), "CM-1", 1.5, "A-TEXTO", bold=True)
    d.text((4.0, 10.45), "VM-1  TUBO LAC 100x200x3 mm @ 1.45 m", 1.4, "A-TEXTO", bold=True)
    d.text((1.10, 8.05), "ARRIOSTRE\nVARILLA Ø1/2\"", 1.1, "A-TEXTO-AREA")
    # cotas
    xs = [0.0, 0.25] + [0.375 + i * 1.45 for i in range(6)] + [7.75, 8.0]
    chain(d, [(x, 12.0) for x in xs], "h", 0.75)
    chain(d, [(8.0, y) for y in (7.0, 7.40, 8.35, 9.30, 9.95, 10.90, 11.85, 12.0)], "v", 0.75, right=True)
    chain(d, [(0, 7.0), (0, 12.0)], "v", -0.55)
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
}
ELEV_FILL = {
    "muro_blanco": "#fbfaf6", "muro_gris": "#efede7", "muro_int": "#f7f5f0", "concreto": "#e6e3dd",
    "concreto_visto": "#cbc7c0", "vidrio": "#d4e7ef", "aluminio": "#4b5157", "madera": "#d6a36c",
    "madera_osc": "#8b5a33", "acero": "#5b636b", "acero_galv": "#c3c8cc", "panel_tr4": "#6b7178",
    "policarbonato": "#eef5f7", "celosia_met": "#9aa1a7", "verde": "#9cc08a", "tanque": "#3a3a3a",
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
    P = [p for p in all_prisms() if not (hide_fur and p.cat == "mobiliario")]
    if elevation:
        P = [p for p in P if p.cat != "cimentacion"]
    items = _project(P, mode, c, look)
    if umin is None:
        umin, umax = (-1.3, 12.2) if mode == "x" else (-0.3, 8.3)
    # terreno
    occl = []
    if not elevation:
        earth = sbox(umin, -1.9, umax, -0.15 if mode == "y" and c < 0 else -0.10)
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
    marks = [(0.0, "NPT ±0.00"), (LV[2], "NPT +2.80"), (LV[3], "NPT +5.60"), (LV[4], "NPT +8.40"),
             (LV[4] + 1.0, "PARAPETO +9.40"), (LV[4] + 2.60, "CASETA +11.00")]
    for z, lbl in marks:
        d.line((umin, z), (xr, z), "A-PROYECCION", lw=0.09)
        d.poly([(xr + 0.15, z), (xr + 0.30, z + 0.18), (xr, z + 0.18)], "A-SIMBOLO", fill="#ffffff", lw=0.18)
        d.text((xr + 0.40, z + 0.12), lbl, 1.7, "A-TEXTO", ha="left")
    xs = xr + 2.6
    chain(d, [(xs, z) for z in (0.0, LV[2], LV[3], LV[4], LV[4] + 1.0, LV[4] + 2.60)], "v", 0.001, right=True)
    if not elevation:
        lab = {1: 1.35, 2: LV[2] + 1.35, 3: LV[3] + 1.35}
        for r in build_rooms():
            if r.level > 3:
                continue
            x1, y1, x2, y2 = r.rect
            if mode == "x" and x1 < c < x2:
                d.text(((y1 + y2) / 2, lab[r.level]), r.name, 1.6, "A-TEXTO", bold=True)
            if mode == "y" and y1 < c < y2:
                u = (x1 + x2) / 2 if look > 0 else 8 - (x1 + x2) / 2
                d.text((u, lab[r.level]), r.name, 1.6, "A-TEXTO", bold=True)
        if mode == "x":
            d.text((9.5, roof_top(9.5) + 0.35), "COBERTURA LIVIANA PEND. 10 %", 1.5, "A-TEXTO", bold=True)
            d.text((-0.75, 4.2), "LINTERNA", 1.6, "A-TEXTO", bold=True, rot=90)


def detail_views():
    """Detalles 1/10 de apoyos de la cobertura (corte por una viga VM-1)."""
    base = section_view("x", 1.86, -1, "CORTE POR VM-1", hide_fur=True)
    d1 = Drawing("DETALLE 1"); d1.extend(base)
    z7 = roof_top(7.0)
    notes1 = [((7.55, 3.62), (6.88, 3.35), "MURO 2do PISO (ladrillo KK)"),
              ((7.55, 3.52), (7.12, z7 + 0.04), "CANALETA GALV. 200x150 e=0.9 mm"),
              ((7.55, 3.42), (7.35, z7 + 0.01), "PANEL TERMOACÚSTICO TR4 e=50 mm"),
              ((7.55, 3.32), (7.42, z7 - 0.09), "CORREA CO-1 TUBO 50x100x2"),
              ((7.55, 2.62), (7.45, z7 - 0.28), "VIGA VM-1 TUBO 100x200x3"),
              ((7.55, 2.52), (7.05, z7 - 0.43), "ÁNGULO AN-1 L100x100x6"),
              ((7.55, 2.42), (6.99, z7 - 0.52), "PERNO EXPANSIVO Ø5/8\" @0.60"),
              ((7.55, 2.32), (6.85, 2.50), "VIGA VS-C 0.25x0.40 (C.A.)"),
              ((7.55, 2.22), (6.85, 2.25), "MURO 1er PISO")]
    for (t, p, s) in notes1:
        d1.line(t, p, "A-COTA", lw=0.13)
        d1.circle(p, 0.008, "A-COTA", fill="#202020")
        d1.text((t[0] + 0.02, t[1]), s, 2.0, "A-TEXTO", ha="left")
    n1 = Drawing("NOTAS D1"); n1.items = d1.items[len(base.items):]
    d2 = Drawing("DETALLE 2"); d2.extend(base)
    zb = roof_top(11.525) - 0.35
    notes2 = [((10.85, zb + 0.55), (11.30, zb + 0.40), "PANEL TR4 + CUMBRERA/REMATE"),
              ((10.85, zb + 0.15), (11.45, zb + 0.10), "VIGA VM-1 SOLDADA A VM-2 (E70XX)"),
              ((10.85, zb - 0.15), (11.48, zb - 0.15), "VIGA VM-2 TUBO 150x300x4"),
              ((10.85, zb - 0.45), (11.50, zb - 0.45), "COLUMNA CM-1 TUBO 150x150x4"),
              ((10.85, 2.65), (11.85, 2.60), "CELOSÍA METÁLICA PERFORADA"),
              ((10.85, 2.40), (11.85, 2.36), "CERCO POSTERIOR h=2.40")]
    for (t, p, s) in notes2:
        d2.line(t, p, "A-COTA", lw=0.13)
        d2.circle(p, 0.008, "A-COTA", fill="#202020")
        d2.text((t[0] - 0.02, t[1]), s, 2.0, "A-TEXTO", ha="right")
    n2 = Drawing("NOTAS D2"); n2.items = d2.items[len(base.items):]
    return d1, d2, base, n1, n2


def all_views():
    V = {}
    V["P1"] = plan_view(1)
    V["P2"] = plan_view(2)
    V["P3"] = plan_view(3)
    V["PT"] = roof_plan()
    V["PE"] = cover_structure_plan()
    V["SA"] = section_view("x", 1.70, -1, "CORTE A-A")
    V["SB"] = section_view("x", 4.00, -1, "CORTE B-B")
    V["SC"] = section_view("y", 2.00, +1, "CORTE C-C", hide_fur=False)
    V["SD"] = section_view("y", 9.40, -1, "CORTE D-D (ÁREA LIBRE)")
    V["EF"] = section_view("y", -30.0, +1, "ELEVACIÓN PRINCIPAL", elevation=True)
    V["EP"] = section_view("y", 40.0, -1, "ELEVACIÓN POSTERIOR", elevation=True)
    V["D1"], V["D2"], V["_DB"], V["_N1"], V["_N2"] = detail_views()
    return V
