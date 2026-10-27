"""
CASA LINTERNA 8x12 - Modelo parametrico (fuente unica de verdad). Version 2.

Sistema de coordenadas (metros):
  x : ancho del lote (0 = medianera izquierda vista desde la calle, 8 = medianera derecha)
  y : fondo del lote (0 = linea de propiedad en la calle, 12 = lindero posterior)
  z : altura (0.00 = NPT primer piso)

Zonificacion:
  Area libre - cochera / reuniones : x 0-8, y 0-5  (8.00 x 5.00 = 40.00 m2), sin muros,
                                     cobertura metalica a una sola agua sobre 4 columnas
  Vivienda (material noble)        : x 0-8, y 5-12 (8.00 x 7.00 = 56.00 m2), 2 pisos
  Terraza (3er nivel)              : sobre la losa del 2do piso, con cobertura metalica liviana

Todos los elementos 3D son PRISMAS: un poligono en el plano YZ extruido en X
entre x1 y x2. Con esa unica primitiva se generan visor 3D, IFC, cortes y elevaciones.
"""
from dataclasses import dataclass, field
import math

# --------------------------------------------------------------------------
# PARAMETROS GENERALES
# --------------------------------------------------------------------------
LOT_W, LOT_D = 8.00, 12.00
YB = 5.00                      # cara de fachada de la vivienda
TE, TI, TP = 0.15, 0.15, 0.10  # muro perimetral / interior / tabique de baño
SLAB = 0.20                    # losa aligerada
BEAM_H = 0.40
LV = {1: 0.00, 2: 2.80, 3: 5.60, 4: 8.40}
LEVEL_NAMES = {1: "1er PISO", 2: "2do PISO", 3: "TERRAZA (3er NIVEL)", 4: "TECHO TERRAZA"}
PHASE = {1: "F1", 2: "F1", 3: "F1", 4: "F1"}

# Ejes estructurales
AX_X = {"1": 0.125, "2": 2.775, "3": 5.225, "4": 7.875}
AX_Y = {"A": 5.125, "B": 8.875, "C": 11.875}
AX_COCHERA = {"A'": 0.375, "B'": 4.525}          # columnas metalicas de la cochera

# Nucleo central: escalera + galeria + pozo de luz
CORE = (2.85, 5.15)
WELL = (2.85, 10.05, 5.15, 11.85)                 # pozo de luz 2.30 x 1.80 (abierto al cielo)

# Escalera en U: 16 contrapasos de 0.175 y pasos de 0.25
RISER, TREAD, N_TREADS = 0.175, 0.25, 7
ST_X_A = (2.90, 3.95)          # tramo que sube hacia la fachada
ST_X_B = (4.05, 5.10)          # tramo que sube hacia el fondo
ST_Y_LAND = (5.15, 6.15)       # descanso contra la linterna de fachada
ST_Y_FL = (6.15, 7.90)

# Coberturas metalicas (una sola agua)
CAR_Y = (0.05, 4.85)           # cochera: cae hacia la calle


def carport_top(y):
    return 3.10 + 0.10 * y     # 3.105 en la calle -> 3.585 junto a la fachada (10 %)


TER_Y = (4.95, 11.95)          # terraza: cae hacia la fachada


def terrace_top(y):
    return LV[3] + 2.60 + (y - YB) * 0.40 / 7.0   # 8.20 adelante -> 8.60 atras (5.7 %)


roof_top = carport_top


# --------------------------------------------------------------------------
# PRIMITIVA 3D
# --------------------------------------------------------------------------
@dataclass
class Prism:
    x1: float
    x2: float
    poly: list
    mat: str
    cat: str
    level: int = 1
    phase: str = "F1"
    name: str = ""
    group: str = ""

    def yz_bounds(self):
        ys = [p[0] for p in self.poly]
        zs = [p[1] for p in self.poly]
        return min(ys), max(ys), min(zs), max(zs)


def box(x1, x2, y1, y2, z1, z2, mat, cat, **kw):
    return Prism(min(x1, x2), max(x1, x2), [(y1, z1), (y2, z1), (y2, z2), (y1, z2)], mat, cat, **kw)


def sloped(x1, x2, y1, y2, top, dz_top, dz_bot, mat, cat, name, level=1):
    poly = [(y1, top(y1) - dz_bot), (y2, top(y2) - dz_bot), (y2, top(y2) - dz_top), (y1, top(y1) - dz_top)]
    return Prism(x1, x2, poly, mat, cat, level, "F1", name, "COBERTURA")


# --------------------------------------------------------------------------
# MUROS Y VANOS
# --------------------------------------------------------------------------
@dataclass
class Opening:
    name: str
    kind: str          # door | door2 | slide | window
    s1: float
    s2: float
    sill: float
    head: float
    hinge: str = "a"
    side: int = 1
    desc: str = ""


@dataclass
class Wall:
    name: str
    a: tuple
    b: tuple
    t: float
    level: int
    h: float = None
    kind: str = "albanileria"
    openings: list = field(default_factory=list)
    z0: float = None
    top_poly: list = None

    @property
    def horizontal(self):
        return abs(self.a[1] - self.b[1]) < 1e-9

    def base(self):
        return LV[self.level] if self.z0 is None else self.z0

    def height(self):
        if self.h is not None:
            return self.h
        return LV[self.level + 1] - SLAB - LV[self.level]

    def rect(self):
        if self.horizontal:
            x1, x2 = sorted([self.a[0], self.b[0]])
            return (x1, self.a[1] - self.t / 2, x2, self.a[1] + self.t / 2)
        y1, y2 = sorted([self.a[1], self.b[1]])
        return (self.a[0] - self.t / 2, y1, self.a[0] + self.t / 2, y2)


def W(name, a, b, t, level, **kw):
    return Wall(name, a, b, t, level, **kw)


def mirror_wall(w, name):
    """Refleja un muro respecto al eje x = 4.00 (planta simetrica)."""
    ops = []
    for o in w.openings:
        if w.horizontal:
            ops.append(Opening(o.name, o.kind, LOT_W - o.s2, LOT_W - o.s1, o.sill, o.head,
                               "b" if o.hinge == "a" else "a", o.side, o.desc))
        else:
            ops.append(Opening(o.name, o.kind, o.s1, o.s2, o.sill, o.head, o.hinge, -o.side, o.desc))
    return Wall(name, (LOT_W - w.a[0], w.a[1]), (LOT_W - w.b[0], w.b[1]), w.t, w.level, w.h, w.kind, ops, w.z0, w.top_poly)


def perimeter(L, **kw):
    return [
        W("M-IZQ", (0.075, YB), (0.075, 12.0), TE, L, kind="medianera", **kw),
        W("M-DER", (7.925, YB), (7.925, 12.0), TE, L, kind="medianera", **kw),
        W("M-POS", (0.15, 11.925), (7.85, 11.925), TE, L, kind="medianera", **kw),
    ]


def build_walls():
    walls = []
    # ---------------- 1er PISO: sala, comedor, cocina ----------------
    L = 1
    walls += perimeter(L)
    walls += [
        W("M-FRO-I", (0.15, 5.075), (2.85, 5.075), TE, L, kind="fachada", openings=[
            Opening("V-01", "window", 0.40, 2.45, 0.30, 2.40, desc="Ventanal sala hacia la cochera")]),
        W("M-FRO-D", (5.15, 5.075), (7.85, 5.075), TE, L, kind="fachada", openings=[
            Opening("PP", "door2", 5.50, 6.50, 0.0, 2.40, "b", +1, "Puerta principal pivotante de madera"),
            Opening("V-02", "window", 6.80, 7.60, 0.90, 2.40, desc="Ventana recibo")]),
        W("T-ESC-I", (2.775, 5.15), (2.775, 7.90), TI, L),
        W("T-ESC-D", (5.225, 5.15), (5.225, 7.90), TI, L),
        W("T-PAT-I", (2.775, 10.05), (2.775, 11.85), TI, L, openings=[
            Opening("V-03", "window", 10.10, 11.80, 0.0, 2.40, desc="Paño fijo de vidrio comedor-patio")]),
        W("T-PAT-D", (5.225, 10.05), (5.225, 11.85), TI, L, openings=[
            Opening("V-03", "window", 10.10, 11.80, 0.0, 2.40, desc="Paño fijo de vidrio cocina-patio")]),
        W("T-PAT-F", (2.85, 9.975), (5.15, 9.975), TI, L, openings=[
            Opening("MP-01", "slide", 2.95, 5.05, 0.0, 2.40, desc="Mampara corrediza estar-patio de luz")]),
        W("T-BV1", (6.25, 7.30), (6.25, 8.825), TP, L),
        W("T-BV2", (6.20, 7.25), (7.85, 7.25), TP, L, openings=[
            Opening("P-03", "door", 6.55, 7.20, 0.0, 2.10, "a", +1, "Baño de visitas")]),
        W("T-BV3", (6.20, 8.875), (7.85, 8.875), TP, L),
    ]
    # ---------------- 2do PISO: 4 suites ----------------
    L = 2
    walls += perimeter(L)
    left = [
        W("M-FRO-I", (0.15, 5.075), (2.85, 5.075), TE, L, kind="fachada", openings=[
            Opening("V-05", "window", 0.35, 1.25, 1.60, 2.20, desc="Ventana alta baño"),
            Opening("V-04", "window", 1.65, 2.55, 0.90, 2.40, desc="Ventana dormitorio")]),
        W("T-NUC-I", (2.775, 5.15), (2.775, 11.85), TI, L, openings=[
            Opening("P-01", "door", 7.93, 8.73, 0.0, 2.10, "b", -1, "Dormitorio frontal"),
            Opening("P-01", "door", 9.03, 9.83, 0.0, 2.10, "a", -1, "Dormitorio posterior"),
            Opening("V-06", "window", 10.20, 11.70, 1.00, 2.20, desc="Ventana dormitorio al pozo de luz")]),
        W("T-BAN-1", (1.45, 5.15), (1.45, 6.95), TP, L, openings=[
            Opening("P-02", "slide", 6.05, 6.70, 0.0, 2.10, desc="Puerta corrediza baño")]),
        W("T-BAN-1b", (0.15, 6.90), (1.50, 6.90), TP, L),
        W("T-SUITE", (0.15, 8.875), (2.70, 8.875), TP, L),
        W("T-BAN-3", (1.45, 8.925), (1.45, 10.70), TP, L, openings=[
            Opening("P-02", "slide", 9.05, 9.70, 0.0, 2.10, desc="Puerta corrediza baño")]),
        W("T-BAN-3b", (0.15, 10.65), (1.50, 10.65), TP, L),
    ]
    walls += left + [mirror_wall(w, w.name.replace("-I", "-D") if w.name.endswith("-I") else w.name + "'") for w in left]
    walls += [W("T-GAL", (2.85, 9.975), (5.15, 9.975), TI, L, openings=[
        Opening("V-07", "window", 2.95, 5.05, 0.90, 2.40, desc="Paño fijo galería-pozo de luz")])]
    # ---------------- TERRAZA: parapetos ----------------
    L = 3
    walls += [
        W("PAR-IZQ", (0.075, YB), (0.075, 12.0), TE, L, h=1.10, kind="parapeto"),
        W("PAR-DER", (7.925, YB), (7.925, 12.0), TE, L, h=1.10, kind="parapeto"),
        W("PAR-POS", (0.15, 11.925), (7.85, 11.925), TE, L, h=1.10, kind="parapeto"),
        W("PAR-FRO-I", (0.15, 5.075), (2.85, 5.075), TE, L, h=1.00, kind="parapeto"),
        W("PAR-FRO-D", (5.15, 5.075), (7.85, 5.075), TE, L, h=1.00, kind="parapeto"),
        W("PAR-ESC-I", (2.775, 5.15), (2.775, 7.90), TI, L, h=1.00, kind="parapeto"),
        W("PAR-ESC-D", (5.225, 5.15), (5.225, 7.90), TI, L, h=1.00, kind="parapeto"),
    ]
    return walls


# --------------------------------------------------------------------------
# AMBIENTES
# --------------------------------------------------------------------------
@dataclass
class Room:
    name: str
    level: int
    rect: tuple
    finish: str = ""
    label_at: tuple = None
    area_m2: float = None

    @property
    def area(self):
        if self.area_m2 is not None:
            return self.area_m2
        x1, y1, x2, y2 = self.rect
        return (x2 - x1) * (y2 - y1)


A_DORM_F = 1.20 * 1.80 + 2.55 * 1.85      # dormitorio frontal en L
A_DORM_P = 1.20 * 1.725 + 2.55 * 1.15     # dormitorio posterior en L
A_BANO_F = 1.25 * 1.70
A_BANO_P = 1.25 * 1.675


def build_rooms():
    r = [
        Room("COCHERA / REUNIONES", 1, (0.0, 0.0, 8.0, 5.0), "Concreto estampado", (4.0, 2.55)),
        Room("SALA", 1, (0.15, 5.15, 2.70, 8.825), "Porcelanato 60x120", (1.42, 7.55)),
        Room("RECIBO", 1, (5.30, 5.15, 7.85, 7.20), "Porcelanato 60x120", (6.58, 6.55)),
        Room("BAÑO VISITAS", 1, (6.30, 7.30, 7.85, 8.825), "Cerámico antideslizante", (7.10, 8.30)),
        Room("ESTAR", 1, (2.85, 7.90, 5.15, 9.90), "Porcelanato 60x120", (4.0, 8.60)),
        Room("COMEDOR", 1, (0.15, 8.925, 2.70, 11.85), "Porcelanato 60x120", (1.42, 9.35)),
        Room("COCINA", 1, (5.30, 8.925, 7.85, 11.85), "Porcelanato 60x120", (6.40, 9.35)),
        Room("PATIO DE LUZ", 1, (2.85, 10.05, 5.15, 11.85), "Canto rodado + jardín", (4.0, 11.25)),
        Room("DORMITORIO 1", 2, (0.15, 5.15, 2.70, 8.825), "Piso laminado", (1.20, 8.05), A_DORM_F),
        Room("BAÑO 1", 2, (0.15, 5.15, 1.40, 6.85), "Porcelanato", (0.78, 6.30), A_BANO_F),
        Room("DORMITORIO 2", 2, (5.30, 5.15, 7.85, 8.825), "Piso laminado", (6.80, 8.05), A_DORM_F),
        Room("BAÑO 2", 2, (6.60, 5.15, 7.85, 6.85), "Porcelanato", (7.22, 6.30), A_BANO_F),
        Room("DORMITORIO 3", 2, (0.15, 8.925, 2.70, 11.85), "Piso laminado", (1.30, 11.40), A_DORM_P),
        Room("BAÑO 3", 2, (0.15, 8.925, 1.40, 10.60), "Porcelanato", (0.78, 9.55), A_BANO_P),
        Room("DORMITORIO 4", 2, (5.30, 8.925, 7.85, 11.85), "Piso laminado", (6.70, 11.40), A_DORM_P),
        Room("BAÑO 4", 2, (6.60, 8.925, 7.85, 10.60), "Porcelanato", (7.22, 9.55), A_BANO_P),
        Room("GALERÍA", 2, (2.85, 7.90, 5.15, 9.90), "Piso laminado", (4.0, 9.05)),
        Room("TERRAZA", 3, (0.15, 5.15, 7.85, 11.85), "Porcelanato antideslizante", (1.45, 8.05),
             7.70 * 6.70 - 2.30 * 2.75 - 2.30 * 1.80),
        Room("LAVANDERÍA", 3, (5.30, 10.50, 7.85, 11.85), "Cerámico antideslizante", (6.30, 10.85)),
    ]
    return r


# --------------------------------------------------------------------------
# GENERACION DE PRISMAS 3D
# --------------------------------------------------------------------------
def wall_prisms(w: Wall):
    out = []
    ph = "F1"
    mat = {"medianera": "muro_gris", "fachada": "muro_blanco", "parapeto": "muro_blanco"}.get(w.kind, "muro_int")
    cat = "muro"
    z0 = w.base()
    H = w.height()
    x1, y1, x2, y2 = w.rect()
    s_lo, s_hi = (x1, x2) if w.horizontal else (y1, y2)
    ops = sorted(w.openings, key=lambda o: o.s1)
    cuts = []
    cur = s_lo
    for o in ops:
        if o.s1 > cur:
            cuts.append((cur, o.s1, 0.0, H))
        if o.sill > 0:
            cuts.append((o.s1, o.s2, 0.0, o.sill))
        if o.head < H:
            cuts.append((o.s1, o.s2, o.head, H))
        cur = o.s2
    if cur < s_hi:
        cuts.append((cur, s_hi, 0.0, H))
    for (a, b, zl, zh) in cuts:
        if w.horizontal:
            out.append(box(a, b, y1, y2, z0 + zl, z0 + zh, mat, cat, level=w.level, phase=ph, name=w.name, group=w.name))
        else:
            out.append(box(x1, x2, a, b, z0 + zl, z0 + zh, mat, cat, level=w.level, phase=ph, name=w.name, group=w.name))
    for o in ops:
        zl, zh = z0 + o.sill, z0 + o.head
        tk = 0.03
        gid = f"{o.name}@{w.name}@{o.s1:.2f}@{w.level}"
        if o.kind == "window":
            m, c = "vidrio", "ventana"
        elif o.kind == "slide":
            m, c = ("vidrio" if w.t > 0.12 else "madera"), "puerta"
        elif o.kind == "door2":
            m, c = "madera_osc", "puerta"
        else:
            m, c = "madera", "puerta"
        if w.horizontal:
            yc = (y1 + y2) / 2
            out.append(box(o.s1, o.s2, yc - tk, yc + tk, zl, zh, m, c, level=w.level, phase=ph, name=o.name, group=gid))
            if m == "vidrio":
                for xx in (o.s1, o.s2 - 0.05):
                    out.append(box(xx, xx + 0.05, yc - 0.04, yc + 0.04, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zh - 0.05, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zl, zl + 0.05, "aluminio", c, level=w.level, name=o.name, group=gid))
        else:
            xc = (x1 + x2) / 2
            out.append(box(xc - tk, xc + tk, o.s1, o.s2, zl, zh, m, c, level=w.level, phase=ph, name=o.name, group=gid))
            if m == "vidrio":
                for yy in (o.s1, o.s2 - 0.05):
                    out.append(box(xc - 0.04, xc + 0.04, yy, yy + 0.05, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
    return out


def _ccw(poly):
    s = 0
    for i in range(len(poly)):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % len(poly)]
        s += (y2 - y1) * (z2 + z1)
    return poly if s < 0 else list(reversed(poly))


def stair_prisms(storey):
    """Escalera en U entre LV[storey] y LV[storey+1]."""
    z0 = LV[storey]
    out = []
    yA, yB = ST_Y_FL
    waist = 0.15 / math.cos(math.atan(RISER / TREAD))
    top = [(yB, z0)]
    for i in range(1, N_TREADS + 1):
        yr = yB - TREAD * (i - 1)
        top += [(yr, z0 + RISER * i), (yr - TREAD, z0 + RISER * i)]
    top += [(yA, z0 + 8 * RISER)]
    polyA = [(yB, z0 - waist)] + top + [(yA, z0 + RISER * N_TREADS - waist)]
    out.append(Prism(ST_X_A[0], ST_X_A[1], _ccw(polyA), "concreto", "escalera", storey, "F1", f"ESC-T1-{storey}", f"ESC-{storey}"))
    zl = z0 + 8 * RISER
    top = [(yA, zl)]
    for j in range(1, N_TREADS + 1):
        yr = yA + TREAD * (j - 1)
        top += [(yr, zl + RISER * j), (yr + TREAD, zl + RISER * j)]
    top += [(yB, z0 + 16 * RISER)]
    polyB = [(yA, zl - 0.20)] + top + [(yB, z0 + 16 * RISER - SLAB), (yB, zl + RISER * N_TREADS - waist)]
    out.append(Prism(ST_X_B[0], ST_X_B[1], _ccw(polyB), "concreto", "escalera", storey, "F1", f"ESC-T2-{storey}", f"ESC-{storey}"))
    out.append(box(CORE[0], CORE[1], ST_Y_LAND[0], ST_Y_LAND[1], zl - SLAB, zl, "concreto", "escalera",
                   level=storey, name=f"ESC-DESC-{storey}", group=f"ESC-{storey}"))
    xr = (ST_X_A[1] + ST_X_B[0]) / 2
    for (za, zb, nm) in ((zl, z0, "A"), (zl, z0 + 2.80, "B")):
        rail = [(yA, za), (yB, zb), (yB, zb + 0.95), (yA, za + 0.95)]
        out.append(Prism(xr - 0.03, xr + 0.03, _ccw(rail), "vidrio", "baranda", storey, "F1", f"BAR-{storey}{nm}", f"ESC-{storey}"))
    out.append(Prism(xr - 0.05, xr + 0.05, _ccw([(yA, zl + 0.95), (yB, z0 + 0.95), (yB, z0 + 1.0), (yA, zl + 1.0)]),
                     "acero", "baranda", storey, "F1", f"PAS-{storey}", f"ESC-{storey}"))
    return out


def _slab_with_holes(L, z, name):
    out = []
    t = (z - SLAB, z)
    for (x1, x2, y1, y2) in [(0, CORE[0], YB, 12.0), (CORE[1], 8.0, YB, 12.0),
                             (CORE[0], CORE[1], ST_Y_FL[1], WELL[1]), (CORE[0], CORE[1], WELL[3], 12.0)]:
        out.append(box(x1, x2, y1, y2, *t, "concreto", "losa", level=L, name=name, group=name))
    return out


def slab_prisms():
    out = []
    out.append(box(0, 8, YB, 12.0, -0.10, 0.0, "piso_int", "losa", level=1, name="CONTRAPISO-1"))
    out.append(box(0, 8, 0.0, YB, -0.15, -0.05, "piso_cochera", "losa", level=1, name="LOSA-COCHERA"))
    out.append(box(0, 8, -1.20, 0.0, -0.30, -0.15, "vereda", "losa", level=1, name="VEREDA"))
    out += _slab_with_holes(2, LV[2], "LOSA-2")
    out += _slab_with_holes(3, LV[3], "LOSA-3")
    return out


COL_X = {"1": (0.0, 0.25), "2": (2.65, 2.90), "3": (5.10, 5.35), "4": (7.75, 8.0)}
COL_Y = {"A": (5.0, 5.25), "B": (8.75, 9.0), "C": (11.75, 12.0)}


def structure_prisms():
    out = []
    for ax, (x1, x2) in COL_X.items():
        for ay, (y1, y2) in COL_Y.items():
            nm = f"C-{ax}{ay}"
            top = LV[3]
            if ax in "14" or ay in "AC":
                top = LV[3] + (1.10 if (ax in "14" or ay == "C") else 1.00)
            out.append(box(x1, x2, y1, y2, -1.0, top, "concreto", "columna", level=1, name=nm, group=nm))
            out.append(box(max(x1 - 0.375, 0), min(x2 + 0.375, 8), max(y1 - 0.375, YB), min(y2 + 0.375, 12),
                           -1.60, -1.00, "cimiento", "cimentacion", level=1, name=f"Z-{ax}{ay}"))
    for L in (2, 3):
        z = LV[L]
        b = (z - BEAM_H, z - SLAB)
        for ax, (x1, x2) in COL_X.items():
            out.append(box(x1, x2, YB, 12.0, *b, "concreto", "viga", level=L, name=f"VP-{ax}"))
        out.append(box(0.0, 2.90, 5.0, 5.25, *b, "concreto", "viga", level=L, name="VS-A"))
        out.append(box(5.10, 8.0, 5.0, 5.25, *b, "concreto", "viga", level=L, name="VS-A"))
        out.append(box(0.0, 8.0, 8.75, 9.0, *b, "concreto", "viga", level=L, name="VS-B"))
        out.append(box(0.0, 8.0, 11.75, 12.0, *b, "concreto", "viga", level=L, name="VS-C"))
        out.append(box(CORE[0], CORE[1], 7.90, 8.10, *b, "concreto", "viga", level=L, name="VB-ESC"))
        out.append(box(CORE[0], CORE[1], 9.85, 10.05, *b, "concreto", "viga", level=L, name="VB-POZO"))
    for (x1, x2, y1, y2) in [(0, 0.60, YB, 12.0), (7.40, 8.0, YB, 12.0), (0, 8, 11.40, 12.0), (0, 8, YB, 5.55),
                             (2.50, 3.05, YB, 12.0), (4.95, 5.50, YB, 12.0)]:
        out.append(box(x1, x2, y1, y2, -1.00, -0.30, "cimiento", "cimentacion", level=1, name="CIMIENTO"))
    return out


def facade_prisms():
    """Linterna de la escalera (muro cortina + celosia) y bandas de concreto visto."""
    out = []
    zt = LV[3] + 1.00
    out.append(box(2.90, 5.10, 5.05, 5.08, 0.0, zt, "vidrio", "muro_cortina", level=1, name="LINTERNA"))
    for xm in (2.85, 3.975, 5.10):
        out.append(box(xm - 0.025, xm + 0.025, 5.02, 5.12, 0.0, zt, "aluminio", "muro_cortina", level=1, name="LINTERNA-MONT"))
    for z in (LV[2], LV[3], zt):
        out.append(box(2.85, 5.15, 5.02, 5.12, z - 0.05, z, "aluminio", "muro_cortina", level=1, name="LINTERNA-TRAV"))
    x = 2.88
    while x < 5.10:
        out.append(box(x, x + 0.04, 4.87, 4.97, -0.05, zt + 0.10, "madera", "celosia", level=1, name="CELOSIA-LINTERNA", group="CELOSIA-LINTERNA"))
        x += 0.11
    for (x1, x2) in ((0.0, 2.85), (5.15, 8.0)):
        out.append(box(x1, x2, 4.90, 5.0, LV[2] - SLAB, LV[2], "concreto_visto", "fachada", level=2, name="BANDA-LOSA-2"))
        out.append(box(x1, x2, 4.90, 5.0, LV[3] - SLAB, LV[3] + 1.0, "concreto_visto", "fachada", level=3, name="BANDA-TERRAZA"))
    return out


def carport_prisms():
    """Cobertura de la cochera: una sola agua hacia la calle, 4 columnas sobre pedestales."""
    out = []
    t = carport_top
    out.append(sloped(0.0, 8.0, 0.15, CAR_Y[1], t, 0.0, 0.05, "panel_tr4", "cobertura", "PANEL-TR4 COCHERA"))
    for yc in (0.30, 1.25, 2.20, 3.15, 4.10, 4.75):
        out.append(sloped(0.05, 7.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA 50x100x2"))
    for i in range(6):
        xc = 0.375 + i * 1.45
        out.append(sloped(xc - 0.05, xc + 0.05, CAR_Y[0], CAR_Y[1], t, 0.15, 0.35, "acero", "viga_met", "VIGA VM-1 100x200x3"))
    cols = [(0.30, 0.30), (7.55, 0.30), (0.30, 4.45), (7.55, 4.45)]
    for yb in (0.30, 4.45):
        ztop = t(yb + 0.075) - 0.35
        out.append(box(0.05, 7.95, yb, yb + 0.15, ztop - 0.30, ztop, "acero", "viga_met", name="VIGA VM-2 150x300x4", group="COBERTURA"))
    for (x1, y1) in cols:
        ztop = t(y1 + 0.075) - 0.65
        cx, cy = x1 + 0.075, y1 + 0.075
        nm = f"CM-{'F' if y1 < 1 else 'P'}{'I' if x1 < 1 else 'D'}"
        out.append(box(x1, x1 + 0.15, y1, y1 + 0.15, 0.512, ztop, "acero", "columna_met", name="COL CM-1 150x150x4", group=nm))
        out.append(box(cx - 0.15, cx + 0.15, cy - 0.15, cy + 0.15, 0.50, 0.512, "acero", "columna_met", name="PLANCHA BASE 300x300x12", group=nm))
        for dx in (-0.10, 0.10):
            for dy in (-0.10, 0.10):
                out.append(box(cx + dx - 0.008, cx + dx + 0.008, cy + dy - 0.008, cy + dy + 0.008, 0.05, 0.56, "acero_galv", "columna_met", name="PERNO DE ANCLAJE 5/8", group=nm))
        out.append(box(cx - 0.20, cx + 0.20, cy - 0.20, cy + 0.20, -0.60, 0.50, "concreto_visto", "pedestal", name="PEDESTAL 0.40x0.40", group=nm))
        zx1, zx2 = min(max(cx - 0.45, 0.0), 7.10), min(max(cx - 0.45, 0.0), 7.10) + 0.90
        zy1 = min(max(cy - 0.45, 0.0), 4.10)
        out.append(box(zx1, zx2, zy1, zy1 + 0.90, -1.20, -0.60, "cimiento", "cimentacion", name=f"ZAPATA {nm}"))
    out.append(box(0.05, 7.95, 0.05, 0.25, t(0.05) - 0.12, t(0.05) + 0.07, "acero_galv", "canaleta", name="CANALETA COCHERA", group="COBERTURA"))
    for xb in (0.47, 7.43):
        out.append(box(xb, xb + 0.08, 0.12, 0.20, -0.05, t(0.05) - 0.12, "acero_galv", "bajante", name="BAJANTE 3in", group="COBERTURA"))
    return out


def terrace_cover_prisms():
    """Cobertura de la terraza (3er nivel): una sola agua hacia la fachada, sobre columnas metalicas."""
    out = []
    t = terrace_top
    out.append(Prism(0.0, 8.0, sloped(0, 1, 5.05, 9.85, t, 0.0, 0.05, "", "", "").poly, "panel_tr4", "cobertura", 3, "F1", "PANEL-TR4 TERRAZA", "COB-TERRAZA"))
    out.append(Prism(0.0, 8.0, sloped(0, 1, 9.85, TER_Y[1], t, 0.0, 0.012, "", "", "").poly, "policarbonato", "cobertura", 3, "F1", "POLICARBONATO SOBRE POZO", "COB-TERRAZA"))
    for yc in (5.30, 6.30, 7.30, 8.30, 9.30, 10.30, 11.30, 11.85):
        p = sloped(0.05, 7.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA 50x100x2")
        p.level = 3
        out.append(p)
    xs = (0.20, 2.775, 5.225, 7.80)
    for xc in xs:
        p = sloped(xc - 0.05, xc + 0.05, 5.05, TER_Y[1], t, 0.15, 0.40, "acero", "viga_met", "VIGA VT-1 100x250x3")
        p.level = 3
        out.append(p)
        for yc in (5.15, 8.875, 11.85):
            ztop = t(yc) - 0.40
            out.append(box(xc - 0.05, xc + 0.05, yc - 0.05, yc + 0.05, LV[3], ztop, "acero", "columna_met", level=3,
                           name="COL CT-1 100x100x3", group="COB-TERRAZA"))
            out.append(box(xc - 0.10, xc + 0.10, yc - 0.10, yc + 0.10, LV[3], LV[3] + 0.012, "acero", "columna_met", level=3,
                           name="PLANCHA BASE 200x200x9", group="COB-TERRAZA"))
    out.append(box(0.05, 7.95, 4.90, 5.08, t(4.95) - 0.12, t(4.95) + 0.05, "acero_galv", "canaleta", level=3, name="CANALETA TERRAZA", group="COB-TERRAZA"))
    for xb in (0.30, 7.62):
        out.append(box(xb, xb + 0.08, 4.90, 4.98, -0.05, t(4.95) - 0.12, "acero_galv", "bajante", level=1, name="BAJANTE 3in", group="COB-TERRAZA"))
    # barandas de vidrio del pozo de luz en la terraza
    z = LV[3]
    out.append(box(WELL[0], WELL[2], WELL[1] - 0.02, WELL[1] + 0.02, z, z + 1.0, "vidrio", "baranda", level=3, name="BARANDA POZO"))
    for xg in (WELL[0], WELL[2]):
        out.append(box(xg - 0.02, xg + 0.02, WELL[1], WELL[3], z, z + 1.0, "vidrio", "baranda", level=3, name="BARANDA POZO"))
    return out


def program_prisms():
    out = []
    z3 = LV[3]
    # cochera: 2 autos (referencia de escala)
    for x0 in (1.00, 5.10):
        out.append(box(x0, x0 + 1.80, 0.40, 4.75, 0.15, 0.80, "auto", "mobiliario", name="AUTO"))
        out.append(box(x0 + 0.10, x0 + 1.70, 1.60, 3.80, 0.80, 1.40, "vidrio_auto", "mobiliario", name="AUTO"))
    # 1er piso
    out.append(box(0.15, 1.00, 5.60, 7.60, 0.0, 0.75, "tela", "mobiliario", name="SOFA"))
    out.append(box(0.90, 1.80, 9.60, 11.20, 0.72, 0.76, "madera", "mobiliario", name="MESA-COMEDOR"))
    out.append(box(7.25, 7.85, 9.00, 11.85, 0.0, 0.90, "cuarzo", "mobiliario", name="MUEBLE-COCINA"))
    out.append(box(5.30, 7.25, 11.25, 11.85, 0.0, 0.90, "cuarzo", "mobiliario", name="MUEBLE-COCINA"))
    out.append(box(5.30, 6.00, 9.00, 9.70, 0.0, 1.90, "acero", "mobiliario", name="REFRIGERADORA"))
    # patio de luz
    out.append(box(WELL[0], WELL[2], WELL[1], WELL[3], 0.0, 0.08, "canto_rodado", "jardin", name="PATIO-CANTO-RODADO"))
    out.append(box(3.90, 4.10, 10.85, 11.05, 0.08, 1.60, "madera_osc", "jardin", name="ARBOL-TRONCO"))
    out.append(box(3.35, 4.65, 10.30, 11.60, 1.60, 3.20, "verde", "jardin", name="ARBOL-COPA"))
    # 2do piso: camas
    z2 = LV[2]
    for (x1, x2, y1, y2) in ((0.15, 2.05, 6.98, 8.33), (5.95, 7.85, 6.98, 8.33),
                             (0.15, 2.05, 10.75, 11.80), (5.95, 7.85, 10.75, 11.80)):
        out.append(box(x1, x2, y1, y2, z2, z2 + 0.55, "tela", "mobiliario", level=2, name="CAMA"))
    # terraza
    out.append(box(0.15, 0.80, 9.40, 11.20, z3, z3 + 0.90, "concreto_visto", "mobiliario", level=3, name="PARRILLA"))
    out.append(box(0.15, 0.80, 9.90, 10.60, z3 + 1.70, z3 + 2.05, "acero", "mobiliario", level=3, name="CAMPANA"))
    out.append(box(1.40, 2.40, 8.95, 10.75, z3 + 0.72, z3 + 0.76, "madera", "mobiliario", level=3, name="MESA-TERRAZA"))
    out.append(box(7.05, 7.85, 11.05, 11.85, z3, z3 + 0.90, "concreto_visto", "mobiliario", level=3, name="LAVADERO"))
    out.append(box(6.35, 6.95, 11.20, 11.85, z3, z3 + 0.85, "blanco", "mobiliario", level=3, name="LAVADORA"))
    out.append(box(5.50, 7.70, 6.10, 8.20, z3, z3 + 0.40, "tela", "mobiliario", level=3, name="SALA-EXTERIOR"))
    for (x1, x2) in ((0.15, 2.70), (5.30, 7.85)):
        out.append(box(x1, x2, 5.15, 5.55, z3, z3 + 0.45, "concreto_visto", "jardin", level=3, name="JARDINERA"))
        out.append(box(x1 + 0.05, x2 - 0.05, 5.20, 5.50, z3 + 0.45, z3 + 0.75, "verde", "jardin", level=3, name="JARDINERA"))
    return out


SPLIT_PREFIX = ("C-", "LINTERNA", "CELOSIA-LINTERNA")


def split_by_levels(p):
    if len(p.poly) != 4 or not p.name.startswith(SPLIT_PREFIX):
        return [p]
    y1, y2, z1, z2 = p.yz_bounds()
    cuts = [LV[2], LV[3]]
    zs = [z1] + [c for c in cuts if z1 + 1e-6 < c < z2 - 1e-6] + [z2]
    out = []
    for a, b in zip(zs[:-1], zs[1:]):
        mid = (a + b) / 2
        lvl = 1 if mid < LV[2] else 2 if mid < LV[3] else 3
        out.append(box(p.x1, p.x2, y1, y2, a, b, p.mat, p.cat, level=lvl, phase="F1", name=p.name, group=p.group))
    return out


def all_prisms():
    P = []
    for w in build_walls():
        P += wall_prisms(w)
    for s in (1, 2):
        P += stair_prisms(s)
    P += slab_prisms()
    P += structure_prisms()
    P += facade_prisms()
    P += carport_prisms()
    P += terrace_cover_prisms()
    P += program_prisms()
    out = []
    for p in P:
        out += split_by_levels(p)
    return out


MATERIALS = {
    "muro_blanco": ("#f4f1ea", 1.0), "muro_gris": ("#d9d5cc", 1.0), "muro_int": ("#efebe3", 1.0),
    "concreto": ("#b9b6b0", 1.0), "concreto_visto": ("#8f8c87", 1.0), "cimiento": ("#9c958a", 1.0),
    "vidrio": ("#9ec9dc", 0.35), "aluminio": ("#3a3d40", 1.0), "madera": ("#b07a45", 1.0),
    "madera_osc": ("#6b4528", 1.0), "acero": ("#2f3236", 1.0), "acero_galv": ("#a7adb2", 1.0),
    "panel_tr4": ("#4a4f55", 1.0), "policarbonato": ("#e8f2f5", 0.55), "celosia_met": ("#3b3f44", 0.55),
    "piso_int": ("#d8cdbb", 1.0), "piso_ext": ("#c9bba3", 1.0), "piso_cochera": ("#b3aea4", 1.0), "vereda": ("#bdbab3", 1.0),
    "verde": ("#5f8f4e", 1.0), "canto_rodado": ("#d6d2c8", 1.0), "tanque": ("#2b2b2b", 1.0),
    "tela": ("#c8c2b8", 1.0), "cuarzo": ("#ebe8e2", 1.0), "blanco": ("#fafafa", 1.0),
    "auto": ("#9aa3a8", 1.0), "vidrio_auto": ("#46525a", 1.0),
}

if __name__ == "__main__":
    P = all_prisms()
    print(len(P), "prismas")
    for r in build_rooms():
        print(f"{r.level} {r.name:22s} {r.area:6.2f}")
