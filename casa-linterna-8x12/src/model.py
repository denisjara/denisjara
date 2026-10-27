"""
CASA LINTERNA - Modelo parametrico (fuente unica de verdad). Version 3.

Terreno 13.00 (frente) x 12.00 (fondo) = 156.00 m2
  Vivienda (material noble) : 8.00 x 12.00, 2 pisos + terraza techada
  Franja libre techada      : 5.00 x 12.00, cochera / reuniones, sin muros,
                              cobertura metalica a una sola agua

Sistema de coordenadas del MODELO (metros):
  x : fondo, 0 = linea de propiedad en la calle -> 12 = lindero posterior
  y : ancho, 0 = medianera de la vivienda -> 8 = fachada hacia la franja -> 13 = lindero de la franja
  z : altura, 0.00 = NPT 1er piso
Las plantas se dibujan giradas 90 grados (calle abajo).

Cada elemento 3D es un PRISMA: poligono en el plano YZ extruido en X entre x1 y x2.
Elementos que varian a lo largo de X (autos, escalones, ruedas) se modelan por rebanadas.
"""
from dataclasses import dataclass, field
import math

# --------------------------------------------------------------------------
# PARAMETROS GENERALES
# --------------------------------------------------------------------------
LOT_X, LOT_Y = 12.00, 13.00
HOUSE_Y = 8.00                 # fachada interior hacia la franja
LOT_W = LOT_Y                  # compatibilidad
TE, TI, TP = 0.15, 0.15, 0.10
SLAB = 0.20
BEAM_H = 0.40
LV = {1: 0.00, 2: 2.80, 3: 5.60, 4: 8.40}
LEVEL_NAMES = {1: "1er PISO", 2: "2do PISO", 3: "TERRAZA (3er NIVEL)", 4: "TECHO"}
PHASE = {1: "F1", 2: "F1", 3: "F1", 4: "F1"}

# Ejes estructurales (columnas de concreto)
COL_X = {"1": (0.0, 0.25), "2": (4.05, 4.30), "3": (7.80, 8.05), "4": (11.75, 12.0)}
COL_Y = {"A": (0.0, 0.25), "B": (2.30, 2.55), "C": (7.75, 8.0)}
AX_X = {k: (a + b) / 2 for k, (a, b) in COL_X.items()}
AX_Y = {k: (a + b) / 2 for k, (a, b) in COL_Y.items()}
STRIP_COLS_X = (0.30, 4.10, 7.90, 11.70)          # columnas metalicas de la franja
STRIP_COL_Y = 12.775
AX_Y["D"] = STRIP_COL_Y

# Escalera en U (tramos a lo largo de X, descanso contra la fachada de calle)
RISER, TREAD, N_TREADS = 0.175, 0.25, 7
ST_Y_A = (0.20, 1.20)          # tramo que sube hacia la calle
ST_Y_B = (1.30, 2.30)          # tramo que regresa
ST_X_LAND = (0.15, 1.15)
ST_X_FL = (1.15, 2.90)
STAIR_ZONE = (0.15, 0.15, 2.90, 2.35)            # x1, y1, x2, y2


def strip_top(y):
    """Cara superior de la cobertura de la franja: 5.60 junto a la casa -> 5.10 en el lindero (10 %)."""
    return 5.60 - 0.10 * (y - HOUSE_Y)


def terrace_top(y):
    """Cobertura de la terraza: 8.60 en la medianera -> 8.20 sobre la fachada interior (5 %)."""
    return 8.60 - 0.05 * y


carport_top = strip_top
roof_top = strip_top


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
    return Prism(min(x1, x2), max(x1, x2), [(min(y1, y2), min(z1, z2)), (max(y1, y2), min(z1, z2)),
                                            (max(y1, y2), max(z1, z2)), (min(y1, y2), max(z1, z2))], mat, cat, **kw)


def sloped(x1, x2, y1, y2, top, dz_top, dz_bot, mat, cat, name, level=1, group="COBERTURA"):
    poly = [(y1, top(y1) - dz_bot), (y2, top(y2) - dz_bot), (y2, top(y2) - dz_top), (y1, top(y1) - dz_top)]
    return Prism(x1, x2, poly, mat, cat, level, "F1", name, group)


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
        """True si el muro corre a lo largo de X."""
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


def build_walls():
    walls = []
    # ================= 1er PISO: dormitorio de visitas, sala, comedor, cocina =================
    L = 1
    walls += [
        W("M-MED", (0.0, 0.075), (12.0, 0.075), TE, L, kind="medianera"),
        W("M-POS", (11.925, 0.15), (11.925, 7.85), TE, L, kind="medianera"),
        W("M-CAL", (0.075, 2.35), (0.075, 7.85), TE, L, kind="fachada", openings=[
            Opening("V-01", "window", 2.70, 3.90, 1.60, 2.20, desc="Ventana alta baño (calle)"),
            Opening("V-02", "window", 4.70, 7.40, 0.90, 2.40, desc="Ventana dormitorio (calle)")]),
        W("M-FRA", (0.15, 7.925), (11.85, 7.925), TE, L, kind="fachada", openings=[
            Opening("V-03", "window", 0.55, 2.55, 0.90, 2.40, desc="Ventana dormitorio a la franja"),
            Opening("PP", "door2", 2.98, 4.02, 0.0, 2.40, "a", -1, "Puerta principal pivotante de madera"),
            Opening("MP-01", "slide", 4.50, 7.40, 0.0, 2.40, desc="Mampara corrediza sala-franja"),
            Opening("MP-02", "slide", 8.25, 9.85, 0.0, 2.40, desc="Mampara corrediza comedor-franja"),
            Opening("V-04", "window", 10.05, 11.55, 1.05, 2.20, desc="Ventana cocina")]),
        W("T-ESC", (0.15, 2.425), (2.90, 2.425), TI, L),
        W("T-DORM", (2.825, 2.50), (2.825, 7.85), TI, L, openings=[
            Opening("P-01", "door", 4.50, 5.30, 0.0, 2.10, "a", -1, "Dormitorio 1er piso")]),
        W("T-BAN-1", (0.15, 4.275), (2.75, 4.275), TP, L, openings=[
            Opening("P-02", "door", 1.90, 2.60, 0.0, 2.10, "b", -1, "Baño dormitorio")]),
        W("T-BV-1", (4.175, 0.15), (4.175, 1.90), TP, L, openings=[
            Opening("P-03", "door", 1.10, 1.75, 0.0, 2.10, "b", 1, "Baño de visitas")]),
        W("T-BV-2", (4.13, 1.925), (5.80, 1.925), TP, L),
        W("T-BV-3", (5.775, 0.15), (5.775, 1.975), TP, L),
    ]
    # ================= 2do PISO: 3 dormitorios con baño y balcón =================
    L = 2
    walls += [
        W("M-MED", (0.0, 0.075), (12.0, 0.075), TE, L, kind="medianera"),
        W("M-POS", (11.925, 0.15), (11.925, 7.85), TE, L, kind="medianera"),
        W("M-CAL", (0.075, 2.35), (0.075, 7.85), TE, L, kind="fachada", openings=[
            Opening("V-01", "window", 2.70, 3.90, 1.60, 2.20, desc="Ventana alta baño (calle)"),
            Opening("V-02", "window", 4.70, 7.40, 0.90, 2.40, desc="Ventana dormitorio (calle)")]),
        W("M-FRA", (0.15, 7.925), (11.85, 7.925), TE, L, kind="fachada", openings=[
            Opening("MP-03", "slide", 1.00, 3.60, 0.0, 2.40, desc="Mampara corrediza a balcón"),
            Opening("MP-03", "slide", 4.70, 7.30, 0.0, 2.40, desc="Mampara corrediza a balcón"),
            Opening("MP-03", "slide", 8.60, 11.20, 0.0, 2.40, desc="Mampara corrediza a balcón")]),
        W("T-ESC", (0.15, 2.425), (4.10, 2.425), TI, L, openings=[
            Opening("P-01", "door", 3.20, 4.00, 0.0, 2.10, "b", 1, "Dormitorio 2")]),
        W("T-BAN-2", (1.825, 2.50), (1.825, 4.375), TP, L, openings=[
            Opening("P-02", "door", 3.45, 4.15, 0.0, 2.10, "a", -1, "Baño dormitorio 2")]),
        W("T-BAN-2b", (0.15, 4.325), (1.875, 4.325), TP, L),
        W("T-DM", (4.175, 1.225), (4.175, 7.85), TI, L),
        W("T-COR", (4.25, 1.225), (7.85, 1.225), TI, L, openings=[
            Opening("P-01", "door", 4.40, 5.20, 0.0, 2.10, "a", 1, "Dormitorio 3")]),
        W("T-BAN-3", (5.375, 1.30), (5.375, 3.225), TP, L, openings=[
            Opening("P-02", "door", 2.30, 3.00, 0.0, 2.10, "b", 1, "Baño dormitorio 3")]),
        W("T-BAN-3b", (5.33, 3.175), (7.85, 3.175), TP, L),
        W("T-MB", (7.925, 0.15), (7.925, 7.85), TI, L, openings=[
            Opening("P-01", "door", 0.25, 1.05, 0.0, 2.10, "a", 1, "Dormitorio 4 (principal)")]),
        W("T-BAN-4", (9.675, 0.15), (9.675, 2.475), TP, L, openings=[
            Opening("P-02", "door", 1.50, 2.20, 0.0, 2.10, "b", 1, "Baño dormitorio 4")]),
        W("T-BAN-4b", (9.63, 2.425), (11.85, 2.425), TP, L),
    ]
    # ================= TERRAZA: parapetos =================
    L = 3
    walls += [
        W("PAR-MED", (0.0, 0.075), (12.0, 0.075), TE, L, h=1.10, kind="parapeto"),
        W("PAR-POS", (11.925, 0.15), (11.925, 7.85), TE, L, h=1.10, kind="parapeto"),
        W("PAR-CAL", (0.075, 2.35), (0.075, 7.85), TE, L, h=1.00, kind="parapeto"),
        W("PAR-FRA", (0.15, 7.925), (11.85, 7.925), TE, L, h=1.00, kind="parapeto"),
        W("PAR-ESC", (0.15, 2.425), (2.90, 2.425), TI, L, h=1.00, kind="parapeto"),
    ]
    return walls


# --------------------------------------------------------------------------
# AMBIENTES
# --------------------------------------------------------------------------
@dataclass
class Room:
    name: str
    level: int
    rect: tuple                # x1, y1, x2, y2 (modelo)
    finish: str = ""
    label_at: tuple = None     # (x, y) modelo
    area_m2: float = None

    @property
    def area(self):
        if self.area_m2 is not None:
            return self.area_m2
        x1, y1, x2, y2 = self.rect
        return (x2 - x1) * (y2 - y1)


def build_rooms():
    return [
        Room("COCHERA / REUNIONES", 1, (0.0, 8.0, 12.0, 13.0), "Concreto estampado", (6.0, 11.30)),
        Room("DORMITORIO 1", 1, (0.15, 4.35, 2.75, 7.85), "Piso laminado", (1.45, 6.20)),
        Room("BAÑO 1", 1, (0.15, 2.50, 2.75, 4.20), "Porcelanato", (1.10, 3.30)),
        Room("VESTÍBULO", 1, (2.90, 0.15, 4.10, 7.85), "Porcelanato 60x120", (3.50, 6.70)),
        Room("BAÑO VISITAS", 1, (4.25, 0.15, 5.725, 1.875), "Cerámico", (5.00, 1.05)),
        Room("SALA", 1, (4.25, 2.00, 7.80, 7.85), "Porcelanato 60x120", (6.00, 4.30)),
        Room("COMEDOR", 1, (7.80, 0.15, 9.90, 7.85), "Porcelanato 60x120", (8.85, 4.30)),
        Room("COCINA", 1, (9.90, 0.15, 11.85, 7.85), "Porcelanato 60x120", (10.85, 4.30)),
        Room("DORMITORIO 2", 2, (0.15, 2.50, 4.10, 7.85), "Piso laminado", (2.40, 5.80), 3.95 * 5.35 - 1.70 * 1.85),
        Room("BAÑO 2", 2, (0.15, 2.50, 1.775, 4.275), "Porcelanato", (0.95, 3.35)),
        Room("DORMITORIO 3", 2, (4.25, 3.25, 7.85, 7.85), "Piso laminado", (6.05, 5.80)),
        Room("BAÑO 3", 2, (5.425, 1.30, 7.85, 3.125), "Porcelanato", (6.65, 2.20)),
        Room("DORMITORIO 4", 2, (8.0, 2.50, 11.85, 7.85), "Piso laminado", (9.90, 5.80)),
        Room("BAÑO 4", 2, (9.725, 0.15, 11.85, 2.375), "Porcelanato", (10.80, 1.25)),
        Room("WALK-IN", 2, (8.0, 0.15, 9.625, 2.375), "Piso laminado", (8.80, 1.70)),
        Room("HALL", 2, (2.90, 0.15, 7.85, 1.15), "Piso laminado", (5.90, 0.62), 1.20 * 2.20 + 3.75 * 1.0),
        Room("TERRAZA", 3, (0.15, 0.15, 11.85, 7.85), "Porcelanato antideslizante", (6.00, 4.60),
             11.70 * 7.70 - 2.75 * 2.20),
    ]


# --------------------------------------------------------------------------
# GENERACION DE PRISMAS 3D
# --------------------------------------------------------------------------
def wall_prisms(w: Wall):
    out = []
    mat = {"medianera": "muro_gris", "fachada": "muro_blanco", "parapeto": "muro_blanco"}.get(w.kind, "muro_int")
    z0 = w.base()
    H = w.height()
    x1, y1, x2, y2 = w.rect()
    s_lo, s_hi = (x1, x2) if w.horizontal else (y1, y2)
    ops = sorted(w.openings, key=lambda o: o.s1)
    cuts, cur = [], s_lo
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
            out.append(box(a, b, y1, y2, z0 + zl, z0 + zh, mat, "muro", level=w.level, name=w.name, group=f"{w.name}@{w.level}"))
        else:
            out.append(box(x1, x2, a, b, z0 + zl, z0 + zh, mat, "muro", level=w.level, name=w.name, group=f"{w.name}@{w.level}"))
    for o in ops:
        zl, zh = z0 + o.sill, z0 + o.head
        gid = f"{o.name}@{w.name}@{o.s1:.2f}@{w.level}"
        if o.kind == "window":
            m, c = "vidrio", "ventana"
        elif o.kind == "slide":
            m, c = "vidrio", "puerta"
        elif o.kind == "door2":
            m, c = "madera_osc", "puerta"
        else:
            m, c = "madera", "puerta"
        if w.horizontal:
            yc = (y1 + y2) / 2
            out.append(box(o.s1, o.s2, yc - 0.03, yc + 0.03, zl, zh, m, c, level=w.level, name=o.name, group=gid))
            if m == "vidrio":
                xs = [o.s1, o.s2 - 0.05] + ([(o.s1 + o.s2) / 2 - 0.025] if o.kind == "slide" else [])
                for xx in xs:
                    out.append(box(xx, xx + 0.05, yc - 0.04, yc + 0.04, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                for zz in (zl, zh - 0.05):
                    out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zz, zz + 0.05, "aluminio", c, level=w.level, name=o.name, group=gid))
            elif o.kind in ("door", "door2"):
                out.append(box(o.s1 + 0.05, o.s1 + 0.12, yc + 0.03, yc + 0.06, zl + 1.0, zl + 1.05, "acero_galv", c, level=w.level, name=o.name, group=gid))
        else:
            xc = (x1 + x2) / 2
            out.append(box(xc - 0.03, xc + 0.03, o.s1, o.s2, zl, zh, m, c, level=w.level, name=o.name, group=gid))
            if m == "vidrio":
                for yy in (o.s1, o.s2 - 0.05):
                    out.append(box(xc - 0.04, xc + 0.04, yy, yy + 0.05, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                for zz in (zl, zh - 0.05):
                    out.append(box(xc - 0.04, xc + 0.04, o.s1, o.s2, zz, zz + 0.05, "aluminio", c, level=w.level, name=o.name, group=gid))
    return out


def stair_prisms(storey):
    """Escalera en U con tramos a lo largo de X: escalones macizos (soffit escalonado)."""
    z0 = LV[storey]
    g = f"ESC-{storey}"
    out = []
    xf, xl = ST_X_FL[1], ST_X_FL[0]
    for i in range(1, N_TREADS + 1):                                   # tramo A: sube hacia la calle
        xa = xf - TREAD * i
        zt = z0 + RISER * i
        out.append(box(xa, xa + TREAD, ST_Y_A[0], ST_Y_A[1], max(z0 - 0.02, zt - 0.32), zt, "concreto", "escalera",
                       level=storey, name=f"ESC-T1-{storey}", group=g))
    zl = z0 + 8 * RISER
    out.append(box(ST_X_LAND[0], ST_X_LAND[1], STAIR_ZONE[1], STAIR_ZONE[3], zl - SLAB, zl, "concreto", "escalera",
                   level=storey, name=f"ESC-DESC-{storey}", group=g))
    for j in range(1, N_TREADS + 1):                                   # tramo B: regresa hacia el fondo
        xa = xl + TREAD * (j - 1)
        zt = zl + RISER * j
        out.append(box(xa, xa + TREAD, ST_Y_B[0], ST_Y_B[1], zt - 0.32, zt, "concreto", "escalera",
                       level=storey, name=f"ESC-T2-{storey}", group=g))
    for k in range(N_TREADS):
        xa = xl + TREAD * k
        out.append(box(xa, xa + TREAD, 1.22, 1.28, zl + RISER * (k + 1) - 0.30, zl + RISER * (k + 1) + 0.95, "vidrio", "baranda",
                       level=storey, name=f"BAR-{storey}", group=g))
    return out


def _slab(L, z, name, holes=True):
    t = (z - SLAB, z)
    x1, y1, x2, y2 = STAIR_ZONE
    return [box(0, 12, y2, HOUSE_Y, *t, "concreto", "losa", level=L, name=name, group=name),
            box(x2, 12, 0, y2, *t, "concreto", "losa", level=L, name=name, group=name),
            box(0.15, x2, 0, y1, *t, "concreto", "losa", level=L, name=name, group=name)]


def slab_prisms():
    out = [box(0, 12, 0, HOUSE_Y, -0.10, 0.0, "piso_int", "losa", level=1, name="CONTRAPISO-1"),
           box(0, 12, HOUSE_Y, LOT_Y, -0.15, -0.05, "piso_cochera", "losa", level=1, name="LOSA-FRANJA"),
           box(-1.20, 0, 0, LOT_Y, -0.30, -0.15, "vereda", "losa", level=1, name="VEREDA")]
    out += _slab(2, LV[2], "LOSA-2")
    out += _slab(3, LV[3], "LOSA-3")
    # balcones del 2do piso (volados hacia la franja) + barandas de vidrio
    for (x1, x2) in BALCONIES:
        out.append(box(x1, x2, HOUSE_Y, HOUSE_Y + 1.0, LV[2] - SLAB, LV[2], "concreto_visto", "losa", level=2, name="BALCÓN", group=f"BALCON-{x1}"))
        out.append(box(x1, x2, HOUSE_Y + 0.95, HOUSE_Y + 0.98, LV[2], LV[2] + 1.0, "vidrio", "baranda", level=2, name="BARANDA BALCÓN", group=f"BALCON-{x1}"))
        out.append(box(x1, x2, HOUSE_Y + 0.93, HOUSE_Y + 1.0, LV[2] + 0.98, LV[2] + 1.03, "acero", "baranda", level=2, name="PASAMANOS", group=f"BALCON-{x1}"))
        for xx in (x1, x2 - 0.03):
            out.append(box(xx, xx + 0.03, HOUSE_Y, HOUSE_Y + 0.98, LV[2], LV[2] + 1.0, "vidrio", "baranda", level=2, name="BARANDA BALCÓN", group=f"BALCON-{x1}"))
    return out


BALCONIES = ((0.70, 3.90), (4.40, 7.60), (8.30, 11.50))


def structure_prisms():
    out = []
    for ax, (x1, x2) in COL_X.items():
        for ay, (y1, y2) in COL_Y.items():
            nm = f"C-{ax}{ay}"
            out.append(box(x1, x2, y1, y2, -1.0, LV[3] + 1.0, "concreto", "columna", level=1, name=nm, group=nm))
            out.append(box(max(x1 - 0.35, 0), min(x2 + 0.35, 12), max(y1 - 0.35, 0), min(y2 + 0.35, HOUSE_Y),
                           -1.60, -1.00, "cimiento", "cimentacion", level=1, name=f"Z-{ax}{ay}"))
    for L in (2, 3):
        z = LV[L]
        b = (z - BEAM_H, z - SLAB)
        for ay, (y1, y2) in COL_Y.items():
            out.append(box(0.0, 12.0, y1, y2, *b, "concreto", "viga", level=L, name=f"VP-{ay}"))
        for ax, (x1, x2) in COL_X.items():
            ya = STAIR_ZONE[3] if ax == "1" else 0.0
            out.append(box(x1, x2, ya, HOUSE_Y, *b, "concreto", "viga", level=L, name=f"VS-{ax}"))
        out.append(box(2.90, 3.15, 0.15, 2.35, *b, "concreto", "viga", level=L, name="VB-ESC"))
    for (x1, x2, y1, y2) in [(0, 12, 0, 0.60), (0, 12, 7.40, 8.0), (0, 0.60, 0, 8.0), (11.40, 12, 0, 8.0),
                             (3.90, 4.45, 0, 8.0), (7.65, 8.20, 0, 8.0), (0, 12, 2.15, 2.70)]:
        out.append(box(x1, x2, y1, y2, -1.00, -0.30, "cimiento", "cimentacion", level=1, name="CIMIENTO"))
    return out


def facade_prisms():
    """Linterna de la escalera sobre la fachada de calle + celosia de listones."""
    out = []
    zt = LV[3] + 1.00
    y1, y2 = STAIR_ZONE[1], STAIR_ZONE[3]
    out.append(box(0.06, 0.09, 0.25, y2, 0.0, zt, "vidrio", "muro_cortina", level=1, name="LINTERNA"))
    for ym in (0.25, (0.25 + y2) / 2, y2 - 0.05):
        out.append(box(0.03, 0.12, ym, ym + 0.05, 0.0, zt, "aluminio", "muro_cortina", level=1, name="LINTERNA-MONT"))
    for z in (LV[2], LV[3], zt):
        out.append(box(0.03, 0.12, 0.25, y2, z - 0.05, z, "aluminio", "muro_cortina", level=1, name="LINTERNA-TRAV"))
    y = 0.28
    while y < y2 + 0.10:
        out.append(box(-0.02, 0.02, y, y + 0.04, -0.05, zt + 0.10, "madera", "celosia", level=1, name="CELOSIA-LINTERNA", group="CELOSIA-LINTERNA"))
        y += 0.11
    for (zb, zt_) in ((LV[2] - SLAB, LV[2]), (LV[3] - SLAB, LV[3] + 1.0)):
        out.append(box(0.0, 12.0, HOUSE_Y - 0.02, HOUSE_Y + 0.08, zb, zt_, "concreto_visto", "fachada", level=2 if zb < 3 else 3, name="BANDA-LOSA"))
    return out


def strip_cover_prisms():
    """Cobertura de la franja 5 x 12: una sola agua hacia el lindero, 4 columnas sobre pedestales."""
    out = []
    t = strip_top
    out.append(sloped(0.0, 12.0, 8.10, 9.40, t, 0.0, 0.012, "policarbonato", "cobertura", "POLICARBONATO (luz a fachada)"))
    out.append(sloped(0.0, 12.0, 9.40, 12.95, t, 0.0, 0.05, "panel_tr4", "cobertura", "PANEL TR4 FRANJA"))
    for yc in (8.30, 9.25, 10.20, 11.15, 12.10, 12.85):
        out.append(sloped(0.05, 11.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA CO-1 50x100x2"))
    for i in range(9):
        xc = 0.30 + i * 1.425
        out.append(sloped(xc - 0.05, xc + 0.05, 8.05, 12.95, t, 0.15, 0.35, "acero", "viga_met", "VIGA VM-1 100x200x3"))
    out.append(box(0.05, 11.95, 8.00, 8.10, t(8.05) - 0.55, t(8.05) - 0.35, "acero", "viga_met", name="ÁNGULO AN-1 L100x100x6", group="COBERTURA"))
    ztop = t(STRIP_COL_Y) - 0.35
    out.append(box(0.05, 11.95, STRIP_COL_Y - 0.075, STRIP_COL_Y + 0.075, ztop - 0.30, ztop, "acero", "viga_met", name="VIGA VM-2 150x300x4", group="COBERTURA"))
    for xc in STRIP_COLS_X:
        yc = STRIP_COL_Y
        nm = f"CM-{xc:.2f}"
        out.append(box(xc - 0.075, xc + 0.075, yc - 0.075, yc + 0.075, 0.512, ztop - 0.30, "acero", "columna_met", name="COL CM-1 150x150x4", group=nm))
        out.append(box(xc - 0.15, xc + 0.15, yc - 0.15, yc + 0.15, 0.50, 0.512, "acero", "columna_met", name="PLANCHA BASE 300x300x12", group=nm))
        for dx in (-0.10, 0.10):
            for dy in (-0.10, 0.10):
                out.append(box(xc + dx - 0.008, xc + dx + 0.008, yc + dy - 0.008, yc + dy + 0.008, 0.05, 0.56, "acero_galv", "columna_met", name="PERNO DE ANCLAJE 5/8", group=nm))
        out.append(box(xc - 0.20, xc + 0.20, yc - 0.20, yc + 0.20, -0.60, 0.50, "concreto_visto", "pedestal", name="PEDESTAL 0.40x0.40", group=nm))
        zx = min(max(xc - 0.45, 0.0), 11.10)
        out.append(box(zx, zx + 0.90, 12.10, 13.0, -1.20, -0.60, "cimiento", "cimentacion", name=f"ZAPATA {nm}"))
        out.append(box(xc + 0.08, xc + 0.16, yc - 0.04, yc + 0.04, -0.05, t(12.9) - 0.12, "acero_galv", "bajante", name="BAJANTE 3in", group=nm))
    out.append(box(0.05, 11.95, 12.80, 13.0, t(12.9) - 0.12, t(12.9) + 0.07, "acero_galv", "canaleta", name="CANALETA FRANJA", group="COBERTURA"))
    return out


def terrace_cover_prisms():
    out = []
    t = terrace_top
    out.append(sloped(0.0, 12.0, 0.05, 7.95, t, 0.0, 0.05, "panel_tr4", "cobertura", "PANEL TR4 TERRAZA", 3, "COB-TERRAZA"))
    for yc in (0.30, 1.30, 2.30, 3.30, 4.30, 5.30, 6.30, 7.30, 7.85):
        out.append(sloped(0.05, 11.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA CO-1 50x100x2", 3, "COB-TERRAZA"))
    xs = (0.20, AX_X["2"], AX_X["3"], 11.80)
    for xc in xs:
        out.append(sloped(xc - 0.05, xc + 0.05, 0.05, 7.95, t, 0.15, 0.40, "acero", "viga_met", "VIGA VT-1 100x250x3", 3, "COB-TERRAZA"))
        for yc in (0.20, AX_Y["B"], 7.80):
            ztop = t(yc) - 0.40
            out.append(box(xc - 0.05, xc + 0.05, yc - 0.05, yc + 0.05, LV[3], ztop, "acero", "columna_met", level=3, name="COL CT-1 100x100x3", group="COB-TERRAZA"))
    out.append(box(0.05, 11.95, 7.92, 8.10, t(8.0) - 0.12, t(8.0) + 0.05, "acero_galv", "canaleta", level=3, name="CANALETA TERRAZA", group="COB-TERRAZA"))
    for xb in (0.40, 11.55):
        out.append(box(xb, xb + 0.08, 8.10, 8.18, -0.05, t(8.0) - 0.12, "acero_galv", "bajante", level=1, name="BAJANTE 3in", group="COB-TERRAZA"))
    return out


# --------------------------------------------------------------------------
# MOBILIARIO REALISTA (compuesto por piezas y rebanadas)
# --------------------------------------------------------------------------
def _xf(dx, dy, ox, oy, rot):
    """Local (a lo largo, a lo ancho) -> global segun orientacion rot en grados (0,90,180,270)."""
    if rot == 0:
        return ox + dx, oy + dy
    if rot == 90:
        return ox - dy, oy + dx
    if rot == 180:
        return ox - dx, oy - dy
    return ox + dy, oy - dx


def lbox(ox, oy, rot, a1, a2, b1, b2, z1, z2, mat, cat, name, group, level=1):
    """Caja en coordenadas locales (a: fondo/largo, b: ancho) de un mueble orientado."""
    p1 = _xf(a1, b1, ox, oy, rot)
    p2 = _xf(a2, b2, ox, oy, rot)
    return box(min(p1[0], p2[0]), max(p1[0], p2[0]), min(p1[1], p2[1]), max(p1[1], p2[1]), z1, z2, mat, cat,
               level=level, name=name, group=group)


def bed(ox, oy, rot, w, l, z, level, tag):
    """Cama: cabecera en a=0, largo l a lo largo de a, ancho w a lo ancho de b."""
    g = f"CAMA-{tag}"
    o = []
    o.append(lbox(ox, oy, rot, 0.0, 0.06, 0, w, z, z + 1.05, "madera", "mobiliario", "CABECERA", g, level))
    o.append(lbox(ox, oy, rot, 0.06, l, 0.02, w - 0.02, z + 0.12, z + 0.32, "madera_osc", "mobiliario", "BASE CAMA", g, level))
    o.append(lbox(ox, oy, rot, 0.08, l - 0.02, 0.04, w - 0.04, z + 0.32, z + 0.55, "colchon", "mobiliario", "COLCHÓN", g, level))
    o.append(lbox(ox, oy, rot, 0.62, l - 0.01, 0.02, w - 0.02, z + 0.55, z + 0.60, "edredon", "mobiliario", "EDREDÓN", g, level))
    o.append(lbox(ox, oy, rot, l - 0.45, l - 0.01, 0.0, w, z + 0.30, z + 0.58, "edredon", "mobiliario", "PIE EDREDÓN", g, level))
    n = 2 if w > 1.2 else 1
    pw = (w - 0.20) / n
    for k in range(n):
        b0 = 0.10 + k * pw
        o.append(lbox(ox, oy, rot, 0.12, 0.50, b0 + 0.03, b0 + pw - 0.03, z + 0.55, z + 0.70, "almohada", "mobiliario", "ALMOHADA", g, level))
    for b0 in (-0.50, w + 0.05):
        o.append(lbox(ox, oy, rot, 0.02, 0.42, b0, b0 + 0.45, z, z + 0.50, "madera", "mobiliario", "VELADOR", g, level))
        cxy = _xf(0.21, b0 + 0.225, ox, oy, rot)
        o += vcyl(cxy[0], cxy[1], z + 0.50, z + 0.62, 0.04, "acero", "mobiliario", "LÁMPARA", g, level, n=4)
        o += vcyl(cxy[0], cxy[1], z + 0.62, z + 0.82, 0.11, "lampara", "mobiliario", "LÁMPARA", g, level, n=6, r2=0.08)
    return o


def sofa(ox, oy, rot, l, d, z, level, tag):
    """Sofa: respaldo en a=0, largo l (b), fondo d (a)."""
    g = f"SOFA-{tag}"
    o = [lbox(ox, oy, rot, 0.0, d, 0.0, l, z + 0.08, z + 0.42, "tela_osc", "mobiliario", "BASE SOFÁ", g, level),
         lbox(ox, oy, rot, 0.0, 0.20, 0.0, l, z + 0.42, z + 0.85, "tela_osc", "mobiliario", "RESPALDO", g, level),
         lbox(ox, oy, rot, 0.0, d, 0.0, 0.18, z + 0.42, z + 0.62, "tela_osc", "mobiliario", "BRAZO", g, level),
         lbox(ox, oy, rot, 0.0, d, l - 0.18, l, z + 0.42, z + 0.62, "tela_osc", "mobiliario", "BRAZO", g, level)]
    n = 3
    cw = (l - 0.36) / n
    for k in range(n):
        b0 = 0.18 + k * cw
        o.append(lbox(ox, oy, rot, 0.20, d - 0.02, b0 + 0.01, b0 + cw - 0.01, z + 0.42, z + 0.52, "tela", "mobiliario", "COJÍN", g, level))
        o.append(lbox(ox, oy, rot, 0.20, 0.34, b0 + 0.05, b0 + cw - 0.05, z + 0.52, z + 0.80, "tela", "mobiliario", "COJÍN RESPALDO", g, level))
    return o


def table(x1, y1, x2, y2, z, level, tag, h=0.75, mat="madera"):
    g = f"MESA-{tag}"
    o = [box(x1, x2, y1, y2, z + h - 0.04, z + h, mat, "mobiliario", level=level, name="TABLERO", group=g)]
    for (xa, ya) in ((x1 + 0.05, y1 + 0.05), (x2 - 0.10, y1 + 0.05), (x1 + 0.05, y2 - 0.10), (x2 - 0.10, y2 - 0.10)):
        o.append(box(xa, xa + 0.05, ya, ya + 0.05, z, z + h - 0.04, "acero", "mobiliario", level=level, name="PATA", group=g))
    return o


def chair(cx, cy, rot, z, level, tag, mat="madera"):
    """Silla: el respaldo queda hacia +a local."""
    g = f"SILLA-{tag}"
    o = [lbox(cx, cy, rot, -0.21, 0.21, -0.21, 0.21, z + 0.43, z + 0.47, mat, "mobiliario", "ASIENTO", g, level),
         lbox(cx, cy, rot, 0.17, 0.21, -0.21, 0.21, z + 0.47, z + 0.88, mat, "mobiliario", "RESPALDO", g, level)]
    for (a, b) in ((-0.19, -0.19), (0.15, -0.19), (-0.19, 0.15), (0.15, 0.15)):
        o.append(lbox(cx, cy, rot, a, a + 0.04, b, b + 0.04, z, z + 0.43, "acero", "mobiliario", "PATA", g, level))
    return o


def dining(x1, y1, x2, y2, z, level, tag, mat="madera"):
    """Mesa con sillas a ambos lados largos (largo a lo largo de x)."""
    o = table(x1, y1, x2, y2, z, level, tag, mat=mat)
    n = max(1, int((x2 - x1) / 0.60))
    for k in range(n):
        cx = x1 + (k + 0.5) * (x2 - x1) / n
        o += chair(cx, y1 - 0.25, 90 + 180, z, level, f"{tag}-{k}a")
        o += chair(cx, y2 + 0.25, 90, z, level, f"{tag}-{k}b")
    return o


def kitchen_run(x1, x2, y_wall, depth_dir, z, level, tag, uppers=True):
    """Muebles bajos de cocina a lo largo de x junto a un muro en y_wall; depth_dir=+1/-1 hacia el ambiente."""
    g = f"COCINA-{tag}"
    yw, yi = y_wall, y_wall + 0.60 * depth_dir
    o = [box(x1, x2, min(yw, yi), max(yw, yi), z + 0.10, z + 0.88, "laca", "mobiliario", level=level, name="MUEBLE BAJO", group=g),
         box(x1, x2, min(yw, yi + 0.02 * depth_dir), max(yw, yi + 0.02 * depth_dir), z + 0.88, z + 0.92, "cuarzo", "mobiliario", level=level, name="ENCIMERA", group=g),
         box(x1, x2, min(yw, yi - 0.05 * depth_dir), max(yw, yi - 0.05 * depth_dir), z, z + 0.10, "acero", "mobiliario", level=level, name="ZÓCALO", group=g)]
    if uppers:
        yu = y_wall + 0.35 * depth_dir
        o.append(box(x1, x2, min(yw, yu), max(yw, yu), z + 1.50, z + 2.20, "laca", "mobiliario", level=level, name="MUEBLE ALTO", group=g))
    return o


def sphere(cx, cy, cz, rx, rz, mat, cat, name, group, level=1, n=9, seg=14, ry=None):
    """Elipsoide aproximado por rebanadas transversales (poligonos en YZ)."""
    ry = rx if ry is None else ry
    out = []
    for k in range(n):
        ta = -rx + 2 * rx * k / n
        tb = -rx + 2 * rx * (k + 1) / n
        tm = (ta + tb) / 2
        f = math.sqrt(max(1 - (tm / rx) ** 2, 0.0))
        if f < 0.05:
            continue
        poly = [(cy + ry * f * math.cos(2 * math.pi * i / seg), cz + rz * f * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        out.append(Prism(cx + ta, cx + tb, poly, mat, cat, level, "F1", name, group))
    return out


def vcyl(cx, cy, z1, z2, r, mat, cat, name, group, level=1, n=8, r2=None):
    """Cilindro (o tronco de cono) de eje vertical por rebanadas."""
    r2 = r if r2 is None else r2
    out = []
    for k in range(n):
        ta = -r + 2 * r * k / n
        tb = -r + 2 * r * (k + 1) / n
        tm = (ta + tb) / 2
        f = math.sqrt(max(1 - (tm / r) ** 2, 0.0))
        poly = [(cy - r * f, z1), (cy + r * f, z1), (cy + r2 * f, z2), (cy - r2 * f, z2)]
        out.append(Prism(cx + ta, cx + tb, poly, mat, cat, level, "F1", name, group))
    return out


def plant(cx, cy, z, level, tag, r=0.30, h=1.10):
    g = f"PLANTA-{tag}"
    o = vcyl(cx, cy, z, z + 0.42, 0.17, "maceta", "jardin", "MACETA", g, level, r2=0.21)
    o += sphere(cx, cy, z + 0.42 + (h - 0.42) * 0.55, r, (h - 0.42) * 0.55, "verde", "jardin", "FOLLAJE", g, level)
    return o


def toilet(cx, cy, rot, z, level, tag):
    g = f"INODORO-{tag}"
    return [lbox(cx, cy, rot, 0.0, 0.18, -0.20, 0.20, z + 0.40, z + 0.78, "loza", "mobiliario", "TANQUE", g, level),
            lbox(cx, cy, rot, 0.12, 0.66, -0.18, 0.18, z, z + 0.40, "loza", "mobiliario", "TAZA", g, level),
            lbox(cx, cy, rot, 0.18, 0.68, -0.19, 0.19, z + 0.40, z + 0.43, "loza", "mobiliario", "ASIENTO", g, level)]


def vanity(cx, cy, rot, w, z, level, tag):
    g = f"LAVATORIO-{tag}"
    return [lbox(cx, cy, rot, 0.0, 0.48, -w / 2, w / 2, z + 0.15, z + 0.82, "madera", "mobiliario", "MUEBLE LAVATORIO", g, level),
            lbox(cx, cy, rot, 0.0, 0.50, -w / 2, w / 2, z + 0.82, z + 0.86, "cuarzo", "mobiliario", "TABLERO", g, level),
            lbox(cx, cy, rot, 0.10, 0.40, -0.20, 0.20, z + 0.86, z + 0.98, "loza", "mobiliario", "OVALÍN", g, level),
            lbox(cx, cy, rot, 0.0, 0.02, -w / 2 + 0.05, w / 2 - 0.05, z + 1.10, z + 1.90, "espejo", "mobiliario", "ESPEJO", g, level)]


def shower(x1, y1, x2, y2, z, level, tag, glass_side="x2"):
    g = f"DUCHA-{tag}"
    o = [box(x1, x2, y1, y2, z, z + 0.04, "loza", "mobiliario", level=level, name="PLATO DUCHA", group=g)]
    if glass_side == "x2":
        o.append(box(x2 - 0.02, x2, y1, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    elif glass_side == "y1":
        o.append(box(x1, x2, y1, y1 + 0.02, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    elif glass_side == "y2":
        o.append(box(x1, x2, y2 - 0.02, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    else:
        o.append(box(x1, x1 + 0.02, y1, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    return o


def wardrobe(x1, y1, x2, y2, z, level, tag, h=2.20):
    g = f"CLOSET-{tag}"
    return [box(x1, x2, y1, y2, z, z + h, "laca", "mobiliario", level=level, name="CLOSET", group=g)]


def desk(x1, y1, x2, y2, z, level, tag):
    o = table(x1, y1, x2, y2, z, level, f"ESC-{tag}", h=0.75, mat="madera")
    return o


def car(x0, y0, color, tag, L=4.45, Wd=1.80):
    """Auto tipo sedan/SUV compacto modelado por rebanadas transversales (frente hacia -x)."""
    g = f"AUTO-{tag}"
    o = []
    yc = y0 + Wd / 2
    n = 48
    dt = L / n

    def belt(t):          # linea de cintura (techo de la carroceria baja)
        if t < 0.25:
            return 0.62 + 0.80 * t
        if t < 1.10:
            return 0.82 + 0.10 * (t - 0.25) / 0.85
        if t < L - 0.55:
            return 0.92
        return 0.92 - 0.25 * (t - (L - 0.55)) / 0.55

    def roof(t):          # techo de la cabina
        if 1.15 <= t < 1.95:
            return 0.92 + 0.56 * (t - 1.15) / 0.80
        if 1.95 <= t < 3.35:
            return 1.48
        if 3.35 <= t < 3.95:
            return 1.48 - 0.50 * (t - 3.35) / 0.60
        return None

    for i in range(n):
        ta, tb = i * dt, (i + 1) * dt
        tm = (ta + tb) / 2
        taper = 0.06 if (tm < 0.30 or tm > L - 0.30) else 0.0
        w = Wd - 2 * taper
        zb = belt(tm)
        body = [(yc - w / 2, 0.24), (yc + w / 2, 0.24), (yc + w / 2, zb - 0.06), (yc + w / 2 - 0.06, zb),
                (yc - w / 2 + 0.06, zb), (yc - w / 2, zb - 0.06)]
        o.append(Prism(x0 + ta, x0 + tb, body, color, "vehiculo", 1, "F1", "CARROCERÍA", g))
        zr = roof(tm)
        if zr is not None and zr > zb + 0.02:
            gb, gt = w - 0.14, w - 0.40
            if zr - zb > 0.10:
                glass = [(yc - gb / 2, zb), (yc + gb / 2, zb), (yc + gt / 2, zr - 0.04), (yc - gt / 2, zr - 0.04)]
                o.append(Prism(x0 + ta, x0 + tb, glass, "vidrio_auto", "vehiculo", 1, "F1", "VENTANAS", g))
                o.append(Prism(x0 + ta, x0 + tb, [(yc - gt / 2, zr - 0.04), (yc + gt / 2, zr - 0.04), (yc + gt / 2, zr), (yc - gt / 2, zr)],
                               color, "vehiculo", 1, "F1", "TECHO", g))
    # paragolpes y luces
    o.append(box(x0 - 0.04, x0 + 0.10, y0 + 0.08, y0 + Wd - 0.08, 0.26, 0.48, "plastico", "vehiculo", name="PARACHOQUE", group=g))
    o.append(box(x0 + L - 0.10, x0 + L + 0.04, y0 + 0.08, y0 + Wd - 0.08, 0.30, 0.52, "plastico", "vehiculo", name="PARACHOQUE", group=g))
    for yy in (y0 + 0.12, y0 + Wd - 0.40):
        o.append(box(x0 - 0.01, x0 + 0.06, yy, yy + 0.28, 0.62, 0.72, "faro", "vehiculo", name="FARO", group=g))
        o.append(box(x0 + L - 0.05, x0 + L + 0.01, yy, yy + 0.28, 0.72, 0.82, "faro_post", "vehiculo", name="STOP", group=g))
    # espejos
    for yy in (y0 - 0.12, y0 + Wd):
        o.append(box(x0 + 1.25, x0 + 1.40, yy, yy + 0.12, 0.92, 1.04, color, "vehiculo", name="ESPEJO", group=g))
    # ruedas (rebanadas con perfil circular)
    r = 0.33
    for axle in (0.95, L - 1.00):
        for (ya, yb) in ((y0 - 0.01, y0 + 0.22), (y0 + Wd - 0.22, y0 + Wd + 0.01)):
            m = 14
            for k in range(m):
                ta = axle - r + 2 * r * k / m
                tb = axle - r + 2 * r * (k + 1) / m
                tm = (ta + tb) / 2 - axle
                h = math.sqrt(max(r * r - tm * tm, 0.0))
                o.append(box(x0 + ta, x0 + tb, ya, yb, r - h, r + h, "llanta", "vehiculo", name="LLANTA", group=g))
                if abs(tm) < r * 0.62:
                    hh = math.sqrt(max((r * 0.6) ** 2 - tm * tm, 0.0))
                    yy = (ya - 0.005, ya + 0.01) if ya < yc else (yb - 0.01, yb + 0.005)
                    o.append(box(x0 + ta, x0 + tb, yy[0], yy[1], r - hh, r + hh, "aro", "vehiculo", name="ARO", group=g))
    return o


def tree(cx, cy, z, level, tag, h=3.4, r=1.1):
    g = f"ARBOL-{tag}"
    o = vcyl(cx, cy, z, z + h * 0.62, 0.10, "madera_osc", "jardin", "TRONCO", g, level, n=6, r2=0.07)
    o += sphere(cx, cy, z + h * 0.72, r, h * 0.28, "verde", "jardin", "COPA", g, level, n=11, seg=16)
    o += sphere(cx + r * 0.25, cy - r * 0.2, z + h * 0.88, r * 0.65, h * 0.16, "verde_claro", "jardin", "COPA", g, level, n=8)
    return o


def program_prisms():
    o = []
    z1, z2, z3 = LV[1], LV[2], LV[3]
    # ---- franja: 2 autos en fila + area de reuniones con parrilla
    o += car(0.40, 10.25, "pintura_1", "1")
    o += car(5.15, 10.25, "pintura_2", "2")
    o += [box(9.95, 11.35, 11.95, 12.55, -0.05, 0.85, "concreto_visto", "mobiliario", name="BARRA PARRILLA", group="PARRILLA"),
          box(10.40, 10.95, 12.00, 12.50, 0.85, 0.95, "acero", "mobiliario", name="PARRILLA", group="PARRILLA"),
          box(10.35, 11.00, 11.98, 12.52, 1.80, 2.20, "acero", "mobiliario", name="CAMPANA", group="PARRILLA"),
          box(10.60, 10.80, 12.15, 12.35, 2.20, 5.30, "acero", "mobiliario", name="CHIMENEA", group="PARRILLA")]
    o += dining(10.05, 9.55, 11.85, 10.45, -0.05, 1, "EXT")
    o += plant(0.35, 8.45, -0.05, 1, "F1", 0.28, 1.0)
    o += plant(9.85, 8.45, -0.05, 1, "F2", 0.28, 1.0)
    o += tree(11.30, 8.75, -0.05, 1, "F", 3.6, 0.62)
    # ---- 1er piso
    o += bed(0.15, 5.95, 0, 1.35, 1.95, z1, 1, "D1")
    o += wardrobe(0.20, 4.35, 1.45, 4.95, z1, 1, "D1")
    o += shower(0.15, 2.50, 1.05, 3.40, z1, 1, "B1", "x2")
    o += toilet(1.55, 2.50, 90, z1, 1, "B1")
    o += vanity(2.30, 2.50, 90, 0.60, z1, 1, "B1")
    o += toilet(5.40, 0.15, 90, z1, 1, "BV")
    o += vanity(4.70, 0.15, 90, 0.55, z1, 1, "BV")
    o += sofa(5.20, 4.80, 270, 2.40, 0.90, z1, 1, "S1")
    o += table(5.80, 3.00, 7.00, 3.60, z1, 1, "CENTRO", h=0.40)
    o += [box(6.10, 7.60, 2.05, 2.45, z1, z1 + 0.50, "madera", "mobiliario", level=1, name="MUEBLE TV", group="TV"),
          box(6.30, 7.40, 2.12, 2.17, z1 + 0.80, z1 + 1.45, "pantalla", "mobiliario", level=1, name="TV 65in", group="TV")]
    o += plant(4.55, 7.45, z1, 1, "S", 0.30, 1.30)
    o += dining(8.05, 3.50, 9.65, 4.40, z1, 1, "COM")
    o += [box(8.05, 9.65, 3.80, 4.10, z1 + 1.55, z1 + 1.60, "lampara", "mobiliario", level=1, name="LÁMPARA COLGANTE", group="LAMP")]
    o += kitchen_run(9.95, 11.85, 0.15, 1, z1, 1, "K1")
    o += [box(11.25, 11.85, 0.75, 6.10, z1 + 0.10, z1 + 0.88, "laca", "mobiliario", level=1, name="MUEBLE BAJO", group="COCINA-K2"),
          box(11.23, 11.85, 0.75, 6.10, z1 + 0.88, z1 + 0.92, "cuarzo", "mobiliario", level=1, name="ENCIMERA", group="COCINA-K2"),
          box(11.50, 11.85, 0.75, 6.10, z1 + 1.50, z1 + 2.20, "laca", "mobiliario", level=1, name="MUEBLE ALTO", group="COCINA-K2"),
          box(11.20, 11.85, 6.20, 6.95, z1, z1 + 1.95, "acero_inox", "mobiliario", level=1, name="REFRIGERADORA", group="REFRI"),
          box(11.30, 11.80, 2.40, 3.00, z1 + 0.92, z1 + 0.94, "acero", "mobiliario", level=1, name="COCINA 4H", group="COCINA-K2")]
    # ---- 2do piso
    o += bed(4.10, 6.45, 180, 1.50, 2.00, z2, 2, "D2")
    o += wardrobe(1.95, 2.55, 3.10, 3.15, z2, 2, "D2")
    o += desk(0.25, 5.20, 0.85, 6.40, z2, 2, "D2")
    o += shower(0.15, 2.50, 1.05, 3.40, z2, 2, "B2", "x2")
    o += toilet(0.15, 3.85, 0, z2, 2, "B2")
    o += vanity(1.10, 4.27, 180, 0.55, z2, 2, "B2")
    o += bed(7.85, 6.40, 180, 1.35, 1.95, z2, 2, "D3")
    o += wardrobe(4.30, 3.25, 4.90, 5.10, z2, 2, "D3")
    o += desk(6.80, 3.30, 7.80, 3.90, z2, 2, "D3")
    o += shower(6.95, 1.30, 7.85, 3.12, z2, 2, "B3", "x1")
    o += toilet(6.35, 1.30, 90, z2, 2, "B3")
    o += vanity(5.85, 1.30, 90, 0.60, z2, 2, "B3")
    o += bed(11.85, 6.10, 180, 1.80, 2.00, z2, 2, "D4")
    o += [box(9.00, 9.60, 0.20, 2.30, z2, z2 + 2.20, "laca", "mobiliario", level=2, name="CLOSET WALK-IN", group="WALKIN")]
    o += shower(10.85, 0.15, 11.85, 1.25, z2, 2, "B4", "y2")
    o += toilet(11.85, 1.85, 180, z2, 2, "B4")
    o += vanity(10.30, 0.15, 90, 0.90, z2, 2, "B4")
    o += desk(8.10, 2.60, 9.10, 3.20, z2, 2, "D4")
    for (x1, x2) in BALCONIES:
        o += chair(x1 + 0.60, HOUSE_Y + 0.55, 180, z2, 2, f"BAL{x1}")
        o += plant(x2 - 0.35, HOUSE_Y + 0.55, z2, 2, f"BAL{x1}", 0.22, 0.85)
    # ---- terraza
    o += [box(9.85, 10.65, 0.20, 0.80, z3, z3 + 0.90, "concreto_visto", "mobiliario", level=3, name="LAVADERO", group="LAV"),
          box(10.80, 11.40, 0.20, 0.80, z3, z3 + 0.85, "blanco", "mobiliario", level=3, name="LAVADORA", group="LAV"),
          box(11.45, 11.85, 0.20, 0.80, z3, z3 + 0.85, "blanco", "mobiliario", level=3, name="SECADORA", group="LAV")]
    for yy in (2.0, 2.5, 3.0, 3.5):
        o.append(box(8.30, 11.70, yy - 0.005, yy + 0.005, z3 + 1.90, z3 + 1.91, "acero", "mobiliario", level=3, name="TENDAL", group="TENDAL"))
    o += sofa(3.40, 7.80, 270, 2.40, 0.85, z3, 3, "T1")
    o += sofa(6.40, 4.20, 90, 2.00, 0.80, z3, 3, "T2")
    o += table(4.05, 5.30, 5.65, 6.40, z3, 3, "TC", h=0.40)
    o += dining(4.70, 2.80, 6.90, 3.70, z3, 3, "TER")
    for (cx, cy) in ((0.45, 7.55), (3.20, 7.55), (7.60, 7.55), (11.50, 7.55)):
        o += plant(cx, cy, z3, 3, f"T{cx}", 0.25, 1.0)
    return o


SPLIT_PREFIX = ("C-", "LINTERNA", "CELOSIA-LINTERNA")


def split_by_levels(p):
    if len(p.poly) != 4 or not p.name.startswith(SPLIT_PREFIX):
        return [p]
    y1, y2, z1, z2 = p.yz_bounds()
    zs = [z1] + [c for c in (LV[2], LV[3]) if z1 + 1e-6 < c < z2 - 1e-6] + [z2]
    out = []
    for a, b in zip(zs[:-1], zs[1:]):
        mid = (a + b) / 2
        lvl = 1 if mid < LV[2] else 2 if mid < LV[3] else 3
        out.append(box(p.x1, p.x2, y1, y2, a, b, p.mat, p.cat, level=lvl, name=p.name, group=p.group))
    return out


_ALL = None


def all_prisms():
    global _ALL
    if _ALL is not None:
        return _ALL
    P = []
    for w in build_walls():
        P += wall_prisms(w)
    for s in (1, 2):
        P += stair_prisms(s)
    P += slab_prisms() + structure_prisms() + facade_prisms() + strip_cover_prisms() + terrace_cover_prisms() + program_prisms()
    out = []
    for p in P:
        out += split_by_levels(p)
    _ALL = out
    return out


MATERIALS = {
    "muro_blanco": ("#f4f1ea", 1.0), "muro_gris": ("#d9d5cc", 1.0), "muro_int": ("#efebe3", 1.0),
    "concreto": ("#b9b6b0", 1.0), "concreto_visto": ("#8f8c87", 1.0), "cimiento": ("#9c958a", 1.0),
    "vidrio": ("#9ec9dc", 0.35), "aluminio": ("#3a3d40", 1.0), "madera": ("#b07a45", 1.0),
    "madera_osc": ("#6b4528", 1.0), "acero": ("#2f3236", 1.0), "acero_galv": ("#a7adb2", 1.0), "acero_inox": ("#c9ccce", 1.0),
    "panel_tr4": ("#4a4f55", 1.0), "policarbonato": ("#e8f2f5", 0.50), "celosia_met": ("#3b3f44", 0.55),
    "piso_int": ("#d8cdbb", 1.0), "piso_cochera": ("#b3aea4", 1.0), "vereda": ("#bdbab3", 1.0),
    "verde": ("#5f8f4e", 1.0), "verde_claro": ("#77a65c", 1.0), "maceta": ("#7d5a44", 1.0), "tela": ("#d8d2c6", 1.0), "tela_osc": ("#6f7378", 1.0),
    "cuarzo": ("#ebe8e2", 1.0), "laca": ("#e9e6df", 1.0), "blanco": ("#fafafa", 1.0), "loza": ("#f7f7f5", 1.0),
    "espejo": ("#c7d6dd", 1.0), "colchon": ("#f2efe8", 1.0), "edredon": ("#8fa3ad", 1.0), "almohada": ("#fbfaf7", 1.0),
    "lampara": ("#f3e2b3", 1.0), "pantalla": ("#111315", 1.0),
    "pintura_1": ("#e6e8ea", 1.0), "pintura_2": ("#2d4f73", 1.0), "vidrio_auto": ("#26323a", 1.0),
    "llanta": ("#1b1c1e", 1.0), "aro": ("#b8bcc0", 1.0), "plastico": ("#2a2b2d", 1.0), "faro": ("#f4f6f8", 1.0),
    "faro_post": ("#a3221c", 1.0),
}

if __name__ == "__main__":
    P = all_prisms()
    print(len(P), "prismas")
    for r in build_rooms():
        print(f"{r.level} {r.name:22s} {r.area:6.2f}")
