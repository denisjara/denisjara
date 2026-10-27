# -*- coding: utf-8 -*-
"""
CASA LINTERNA 8x12 - Generador de modelo NATIVO en Revit.

Lee 'casa_linterna_revit.json' (misma carpeta) y crea dentro del proyecto
abierto en Revit:
  - Niveles (NPT +0.00 / +2.80 / +5.60 / +8.40) y ejes 1-4 / A-D
  - Tipos de muro, losa y techo parametricos (capa unica con espesor exacto)
  - Muros nativos (incluye muros de perfil inclinado bajo la cobertura)
  - Puertas y ventanas nativas: duplica un tipo cargado por cada medida
    (P-01 0.80x2.10, V-04 2.40x2.30 ...) y fija alfeizar, mano y sentido
  - Losas aligeradas con hueco de escalera, contrapiso, techo de caseta
  - Escaleras en U nativas (StairsEditScope: 2 tramos + descanso, 16 cp de 0.175)
  - Cobertura liviana como techo por extrusion (pendiente 10 %)
  - Columnas, vigas, estructura metalica, celosias, marco volado y mobiliario
    como DirectShape con categoria BIM y material (no dependen de familias)
  - Habitaciones (Rooms) con nombre, numero y acabado + separadores
  - Vistas: plantas por nivel, cortes A-A..D-D, elevaciones, 3D y laminas A-01..A-06
  - Elementos del 3er piso marcados en Comentarios como "FASE 2 - PROYECCION"

Ejecucion (Revit 2022 o superior, plantilla metrica de arquitectura):
  * pyRevit .............. colocar en un boton o usar "Run Script" (IronPython o CPython)
  * RevitPythonShell ..... File > Run script
  * Dynamo (Python Script) copiar el contenido; se detecta automaticamente
  * Revit MCP ............ si tu servidor MCP de Revit ejecuta Python, enviar este
                           archivo; si solo ejecuta C#, usa el IFC entregado.
NOTA: script escrito contra la API publica de Revit; no se pudo ejecutar en el
entorno donde se genero. Cada bloque esta protegido con try/except y reporta en
la consola lo que crea u omite.
"""
import os, sys, json, math

import clr
clr.AddReference("RevitAPI")
from Autodesk.Revit.DB import *                                   # noqa
from Autodesk.Revit.DB.Architecture import *                      # noqa
from Autodesk.Revit.DB.Structure import StructuralType
from System.Collections.Generic import List

# ---------------------------------------------------------------- documento
try:                                   # pyRevit
    doc = __revit__.ActiveUIDocument.Document          # noqa
except Exception:
    try:                               # Dynamo
        clr.AddReference("RevitServices")
        from RevitServices.Persistence import DocumentManager
        from RevitServices.Transactions import TransactionManager
        doc = DocumentManager.Instance.CurrentDBDocument
        TransactionManager.Instance.ForceCloseTransaction()
    except Exception:
        doc = __revit__.ActiveUIDocument.Document      # noqa  (RevitPythonShell)

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
JSON_PATH = os.path.join(HERE, "casa_linterna_revit.json")
if "IN" in globals() and IN and IN[0]:          # noqa  Dynamo: ruta del JSON en la entrada IN[0]
    JSON_PATH = IN[0]                           # noqa
with open(JSON_PATH, "rb") as fh:
    D = json.loads(fh.read().decode("utf-8"))

FT = 1.0 / 0.3048
LOG = []


def ft(v):
    return v * FT


def xyz(x, y, z=0.0):
    return XYZ(ft(x), ft(y), ft(z))


def log(msg):
    LOG.append(msg)
    print(msg)


class FP(IFailuresPreprocessor):
    """Descarta advertencias para que los commits no se detengan."""
    __namespace__ = "CasaLinterna"

    def PreprocessFailures(self, fa):
        for f in fa.GetFailureMessages():
            if f.GetSeverity() == FailureSeverity.Warning:
                fa.DeleteWarning(f)
        return FailureProcessingResult.Continue


def tx(name):
    t = Transaction(doc, name)
    t.Start()
    opts = t.GetFailureHandlingOptions()
    opts.SetFailuresPreprocessor(FP())
    t.SetFailureHandlingOptions(opts)
    return t


def eid(i):
    """Valor entero de un ElementId (Revit 2024+ usa .Value)."""
    return i.Value if hasattr(i, "Value") else i.IntegerValue


def first(cls, pred=None):
    for e in FilteredElementCollector(doc).OfClass(cls):
        if pred is None or pred(e):
            return e
    return None


def set_comment(el, text):
    try:
        el.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(text)
    except Exception:
        pass


# ================================================================ MATERIALES
MATS = {}


def material(key):
    if key in MATS:
        return MATS[key]
    name = "CL - " + key
    m = first(Material, lambda e: e.Name == name)
    if m is None:
        m = doc.GetElement(Material.Create(doc, name))
    spec = D["materials"].get(key, {"rgb": [200, 200, 200], "transparency": 0})
    m.Color = Color(spec["rgb"][0], spec["rgb"][1], spec["rgb"][2])
    m.Transparency = spec["transparency"]
    MATS[key] = m.Id
    return m.Id


# ================================================================ NIVELES Y EJES
LEVELS = {}
t = tx("CL - Niveles y ejes")
existing = list(FilteredElementCollector(doc).OfClass(Level))
for lv in D["levels"]:
    match = [l for l in existing if abs(l.Elevation - ft(lv["elev"])) < 1e-3]
    L = match[0] if match else Level.Create(doc, ft(lv["elev"]))
    try:
        L.Name = lv["name"]
    except Exception:
        pass
    LEVELS[lv["id"]] = L
for g in D["grids"]:
    try:
        gr = Grid.Create(doc, Line.CreateBound(xyz(*g["p1"]), xyz(*g["p2"])))
        gr.Name = g["name"]
    except Exception as e:
        log("Eje {} omitido: {}".format(g["name"], e))
t.Commit()
log("Niveles: {}  Ejes: {}".format(len(LEVELS), len(D["grids"])))

# ================================================================ TIPOS PARAMETRICOS
WALL_TYPES, FLOOR_TYPES = {}, {}


def wall_type(thk, kind):
    key = (round(thk, 3), kind)
    if key in WALL_TYPES:
        return WALL_TYPES[key]
    name = "CL - Muro {} {:.0f} cm".format(kind, thk * 100)
    wt = first(WallType, lambda e: e.Name == name)
    if wt is None:
        base = first(WallType, lambda e: e.Kind == WallKind.Basic)
        wt = base.Duplicate(name)
        mk = {"medianera": "muro_gris", "fachada": "muro_blanco", "parapeto": "muro_blanco"}.get(kind, "muro_int")
        cs = CompoundStructure.CreateSingleLayerCompoundStructure(MaterialFunctionAssignment.Structure, ft(thk), material(mk))
        wt.SetCompoundStructure(cs)
    WALL_TYPES[key] = wt
    return wt


def floor_type(thk, name):
    key = (round(thk, 3), name)
    if key in FLOOR_TYPES:
        return FLOOR_TYPES[key]
    tname = "CL - {} {:.0f} cm".format(name, thk * 100)
    ftp = first(FloorType, lambda e: e.Name == tname)
    if ftp is None:
        base = first(FloorType, lambda e: not e.IsFoundationSlab)
        ftp = base.Duplicate(tname)
        cs = CompoundStructure.CreateSingleLayerCompoundStructure(MaterialFunctionAssignment.Structure, ft(thk), material("concreto"))
        ftp.SetCompoundStructure(cs)
    FLOOR_TYPES[key] = ftp
    return ftp


# ================================================================ MUROS
WALLS = {}
t = tx("CL - Muros")
for w in D["walls"]:
    try:
        L = LEVELS[w["level"]]
        wt = wall_type(w["t"], w["kind"])
        if "profile_yz" in w:                         # muro con coronacion inclinada (bajo cobertura)
            x = w["a"][0]
            prof = List[Curve]()
            pts = [xyz(x, y, z) for (y, z) in w["profile_yz"]]
            for i in range(len(pts)):
                prof.Add(Line.CreateBound(pts[i], pts[(i + 1) % len(pts)]))
            wall = Wall.Create(doc, prof, wt.Id, L.Id, False)
        else:
            line = Line.CreateBound(xyz(w["a"][0], w["a"][1]), xyz(w["b"][0], w["b"][1]))
            wall = Wall.Create(doc, line, wt.Id, L.Id, ft(w["height"]), ft(w["base_offset"]), False, False)
            wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE).Set(ElementId.InvalidElementId)
            wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM).Set(ft(w["height"]))
        set_comment(wall, "FASE 2 - PROYECCION" if w["phase"] == "F2" else "FASE 1")
        WALLS[w["id"]] = wall
    except Exception as e:
        log("Muro {} (nivel {}) omitido: {}".format(w["name"], w["level"], e))
t.Commit()
log("Muros creados: {}".format(len(WALLS)))

# ================================================================ PUERTAS Y VENTANAS
SYMBOLS = {}


def get_symbol(kind, w, h, tag):
    cat = BuiltInCategory.OST_Windows if kind == "window" else BuiltInCategory.OST_Doors
    key = (tag, round(w, 2), round(h, 2))
    if key in SYMBOLS:
        return SYMBOLS[key]
    base = None
    for s in FilteredElementCollector(doc).OfClass(FamilySymbol).OfCategory(cat):
        base = s
        fam = s.FamilyName.lower()
        if kind == "slide" and ("slid" in fam or "corred" in fam):
            break
        if kind != "slide":
            break
    if base is None:
        return None
    name = "{} {:.2f}x{:.2f}".format(tag, w, h)
    sym = first(FamilySymbol, lambda e: e.Name == name and e.Category is not None and eid(e.Category.Id) == int(cat))
    if sym is None:
        sym = base.Duplicate(name)
        for bip, val in ((BuiltInParameter.DOOR_WIDTH, w), (BuiltInParameter.DOOR_HEIGHT, h),
                         (BuiltInParameter.WINDOW_WIDTH, w), (BuiltInParameter.WINDOW_HEIGHT, h),
                         (BuiltInParameter.FAMILY_WIDTH_PARAM, w), (BuiltInParameter.FAMILY_HEIGHT_PARAM, h)):
            p = sym.get_Parameter(bip)
            if p is not None and not p.IsReadOnly:
                p.Set(ft(val))
        for pname, val in (("Width", w), ("Height", h), ("Ancho", w), ("Altura", h), ("Alto", h)):
            p = sym.LookupParameter(pname)
            if p is not None and not p.IsReadOnly:
                p.Set(ft(val))
    if not sym.IsActive:
        sym.Activate()
    SYMBOLS[key] = sym
    return sym


t = tx("CL - Puertas y ventanas")
n_ok = n_open = 0
for w in D["walls"]:
    wall = WALLS.get(w["id"])
    if wall is None:
        continue
    L = LEVELS[w["level"]]
    horiz = abs(w["a"][1] - w["b"][1]) < 1e-9
    for o in w["openings"]:
        width, height = o["s2"] - o["s1"], o["head"] - o["sill"]
        mid = (o["s1"] + o["s2"]) / 2.0
        p = xyz(mid, w["a"][1], 0) if horiz else xyz(w["a"][0], mid, 0)
        try:
            sym = get_symbol(o["kind"], width, height, o["tag"])
            if sym is None:
                raise Exception("sin familia cargada")
            doc.Regenerate()
            inst = doc.Create.NewFamilyInstance(p, sym, wall, L, StructuralType.NonStructural)
            sp = inst.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)
            if sp is not None and not sp.IsReadOnly:
                sp.Set(ft(o["sill"]))
            want = XYZ(0, o["side"], 0) if horiz else XYZ(o["side"], 0, 0)
            if o["kind"] in ("door", "door2") and inst.FacingOrientation.DotProduct(want) < 0:
                inst.flipFacing()
            inst.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(o["tag"])
            set_comment(inst, o["desc"])
            n_ok += 1
        except Exception as e:
            try:                                   # sin familia: vano limpio en el muro
                z0 = L.Elevation + ft(w["base_offset"])
                if horiz:
                    a, b = xyz(o["s1"], w["a"][1]), xyz(o["s2"], w["a"][1])
                else:
                    a, b = xyz(w["a"][0], o["s1"]), xyz(w["a"][0], o["s2"])
                doc.Create.NewOpening(wall, XYZ(a.X, a.Y, z0 + ft(o["sill"])), XYZ(b.X, b.Y, z0 + ft(o["head"])))
                n_open += 1
            except Exception as e2:
                log("Vano {} omitido: {} / {}".format(o["tag"], e, e2))
t.Commit()
log("Puertas/ventanas: {} familias + {} vanos simples".format(n_ok, n_open))

# ================================================================ LOSAS
t = tx("CL - Losas")
for fl in D["floors"]:
    try:
        L = LEVELS[fl["level"]]
        ftp = floor_type(fl["t"], "Losa")
        loops = List[CurveLoop]()
        for loop in fl["loops"]:
            cl = CurveLoop()
            pts = [xyz(x, y) for (x, y) in loop]
            for i in range(len(pts)):
                cl.Append(Line.CreateBound(pts[i], pts[(i + 1) % len(pts)]))
            loops.Add(cl)
        try:
            floor = Floor.Create(doc, loops, ftp.Id, L.Id)                       # Revit 2022+
        except Exception:
            ca = CurveArray()
            for c in loops[0]:
                ca.Append(c)
            floor = doc.Create.NewFloor(ca, ftp, L, False)                        # Revit <= 2021
            for hole in list(loops)[1:]:
                ha = CurveArray()
                for c in hole:
                    ha.Append(c)
                doc.Create.NewOpening(floor, ha, True)
        floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(ft(fl["offset"]))
        floor.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(fl["name"])
        if fl.get("phase") == "F2":
            set_comment(floor, fl["name"] + " | FASE 2 - PROYECCION")
    except Exception as e:
        log("Losa {} omitida: {}".format(fl["name"], e))
t.Commit()

# ================================================================ COBERTURA LIVIANA (techo por extrusion)
t = tx("CL - Cobertura liviana")
for rf in D["roofs"]:
    try:
        base = first(RoofType)
        name = "CL - Panel TR4 {:.0f} mm".format(rf["t"] * 1000)
        rt = first(RoofType, lambda e: e.Name == name)
        if rt is None:
            rt = base.Duplicate(name)
            rt.SetCompoundStructure(CompoundStructure.CreateSingleLayerCompoundStructure(
                MaterialFunctionAssignment.Structure, ft(rf["t"]), material("panel_tr4")))
        view = doc.ActiveView
        rp = doc.Create.NewReferencePlane(xyz(rf["x1"], 0, 0), xyz(rf["x1"], 10, 0), XYZ.BasisZ, view)
        rp.Name = "CL - Plano cobertura"
        prof = CurveArray()
        (y1, z1), (y2, z2) = rf["profile_yz"]
        prof.Append(Line.CreateBound(xyz(rf["x1"], y1, z1), xyz(rf["x1"], y2, z2)))
        roof = doc.Create.NewExtrusionRoof(prof, rp, LEVELS[1], rt, 0.0, ft(rf["x2"] - rf["x1"]))
        doc.Regenerate()
        bb = roof.get_BoundingBox(None)
        if bb is not None and bb.Min.X < ft(rf["x1"]) - 0.1:      # extruyo hacia -X: trasladar
            ElementTransformUtils.MoveElement(doc, roof.Id, XYZ(ft(rf["x2"] - rf["x1"]), 0, 0))
        set_comment(roof, "Pendiente {} % hacia canaleta".format(rf["slope_pct"]))
        log("Cobertura creada")
    except Exception as e:
        log("Cobertura nativa omitida ({}); se usara DirectShape".format(e))
        D["_roof_failed"] = True
t.Commit()

# ================================================================ ESCALERAS NATIVAS
STAIRS_OK = set()
for st in D["stairs"]:
    try:
        scope = StairsEditScope(doc, "CL - Escalera")
        sid = scope.Start(LEVELS[st["base_level"]].Id, LEVELS[st["top_level"]].Id)
        t = tx("CL - Tramos")
        z = LEVELS[st["base_level"]].Elevation
        stairs = doc.GetElement(sid)
        stairs.DesiredRisersNumber = st["risers"]
        stairs.ActualTreadDepth = ft(st["tread"])
        r1 = StairsRun.CreateStraightRun(doc, sid, Line.CreateBound(
            XYZ(ft(st["run1"][0][0]), ft(st["run1"][0][1]), z), XYZ(ft(st["run1"][1][0]), ft(st["run1"][1][1]), z)),
            StairsRunJustification.Center)
        r2 = StairsRun.CreateStraightRun(doc, sid, Line.CreateBound(
            XYZ(ft(st["run2"][0][0]), ft(st["run2"][0][1]), z), XYZ(ft(st["run2"][1][0]), ft(st["run2"][1][1]), z)),
            StairsRunJustification.Center)
        for r in (r1, r2):
            r.ActualRunWidth = ft(st["width"])
        r2.BaseElevation = r1.TopElevation
        StairsLanding.CreateAutomaticLanding(doc, r1.Id, r2.Id)
        t.Commit()
        scope.Commit(FP())
        STAIRS_OK.add(st["base_level"])
        el = doc.GetElement(sid)
        if st["phase"] == "F2":
            t = tx("CL - comentario"); set_comment(el, "FASE 2 - PROYECCION"); t.Commit()
    except Exception as e:
        log("Escalera nivel {} -> DirectShape ({})".format(st["base_level"], e))
log("Escaleras nativas: {}".format(sorted(STAIRS_OK)))

# ================================================================ DIRECTSHAPES (estructura, metal, celosias...)
t = tx("CL - DirectShapes")
n_ds = 0
for e in D["directshapes"]:
    if e.get("fallback_only"):
        if e["bim_cat"] == "escalera" and e["level"] in STAIRS_OK:
            continue
        if e["bim_cat"] == "cobertura" and not D.get("_roof_failed"):
            continue
    try:
        x1, x2 = e["x1"], e["x2"]
        pts = [xyz(x1, y, z) for (y, z) in e["poly"]]
        cl = CurveLoop()
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            if a.DistanceTo(b) > 1e-4:
                cl.Append(Line.CreateBound(a, b))
        loops = List[CurveLoop](); loops.Add(cl)
        opts = SolidOptions(material(e["mat"]), ElementId.InvalidElementId)
        solid = GeometryCreationUtilities.CreateExtrusionGeometry(loops, XYZ.BasisX, ft(x2 - x1), opts)
        cat = ElementId(getattr(BuiltInCategory, e["cat"]))
        if not DirectShape.IsValidCategoryId(cat, doc):
            cat = ElementId(BuiltInCategory.OST_GenericModel)
        ds = DirectShape.CreateElement(doc, cat)
        ds.ApplicationId = "CasaLinterna"
        ds.ApplicationDataId = e["name"]
        geo = List[GeometryObject](); geo.Add(solid)
        ds.SetShape(geo)
        try:
            ds.Name = e["name"]
        except Exception:
            pass
        set_comment(ds, "{} | {}".format(e["bim_cat"], "FASE 2 - PROYECCION" if e["phase"] == "F2" else "FASE 1"))
        n_ds += 1
    except Exception as ex:
        log("DirectShape {} omitido: {}".format(e["name"], ex))
t.Commit()
log("DirectShapes: {}".format(n_ds))

# ================================================================ VISTAS
def vft(family):
    return first(ViewFamilyType, lambda e: e.ViewFamily == family)


VIEWS = {}
t = tx("CL - Vistas")
plan_t = vft(ViewFamily.FloorPlan)
for lv in D["levels"]:
    try:
        v = ViewPlan.Create(doc, plan_t.Id, LEVELS[lv["id"]].Id)
        v.Name = "PLANTA NPT {:+.2f}".format(lv["elev"])
        v.Scale = 50
        VIEWS[v.Name] = v
    except Exception as e:
        log("Planta {} omitida: {}".format(lv["name"], e))
sec_t = vft(ViewFamily.Section)
for s in D["sections"]:
    try:
        tr = Transform.Identity
        if s["plane"] == "x":
            tr.Origin = xyz(s["c"], 0, 0)
            tr.BasisZ = XYZ(-s["look"], 0, 0)               # hacia el observador
            tr.BasisY = XYZ.BasisZ
            tr.BasisX = tr.BasisY.CrossProduct(tr.BasisZ)
        else:
            tr.Origin = xyz(0, s["c"], 0) if s["look"] > 0 else xyz(8, s["c"], 0)
            tr.BasisZ = XYZ(0, -s["look"], 0)
            tr.BasisY = XYZ.BasisZ
            tr.BasisX = tr.BasisY.CrossProduct(tr.BasisZ)
        box = BoundingBoxXYZ()
        box.Transform = tr
        box.Min = XYZ(ft(s["umin"]), ft(-1.9), -ft(s["far"]))
        box.Max = XYZ(ft(s["umax"]), ft(11.4), 0)
        v = ViewSection.CreateSection(doc, sec_t.Id, box)
        v.Name = s["name"]
        v.Scale = 50
        VIEWS[s["name"]] = v
    except Exception as e:
        log("Corte {} omitido: {}".format(s["name"], e))
try:
    v3 = View3D.CreateIsometric(doc, vft(ViewFamily.ThreeDimensional).Id)
    v3.Name = "3D CASA LINTERNA"
    VIEWS[v3.Name] = v3
except Exception as e:
    log("Vista 3D omitida: {}".format(e))
t.Commit()

# ================================================================ HABITACIONES
t = tx("CL - Habitaciones")
for lv in D["levels"]:
    v = VIEWS.get("PLANTA NPT {:+.2f}".format(lv["elev"]))
    seps = [s for s in D["room_separations"] if s["level"] == lv["id"]]
    if v is None or not seps:
        continue
    try:
        sk = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ(0, 0, LEVELS[lv["id"]].Elevation)))
        ca = CurveArray()
        for s in seps:
            ca.Append(Line.CreateBound(xyz(s["a"][0], s["a"][1], lv["elev"]), xyz(s["b"][0], s["b"][1], lv["elev"])))
        doc.Create.NewRoomBoundaryLines(sk, ca, v)
    except Exception as e:
        log("Separadores nivel {}: {}".format(lv["id"], e))
doc.Regenerate()
n_rooms = 0
for r in D["rooms"]:
    try:
        room = doc.Create.NewRoom(LEVELS[r["level"]], UV(ft(r["pt"][0]), ft(r["pt"][1])))
        room.Name = r["name"]
        room.Number = r["number"]
        p = room.get_Parameter(BuiltInParameter.ROOM_FINISH_FLOOR)
        if p is not None:
            p.Set(r["finish"])
        n_rooms += 1
    except Exception as e:
        log("Habitacion {} omitida: {}".format(r["name"], e))
t.Commit()
log("Habitaciones: {}".format(n_rooms))

# ================================================================ LAMINAS
t = tx("CL - Laminas")
tb = first(FamilySymbol, lambda e: e.Category is not None and eid(e.Category.Id) == int(BuiltInCategory.OST_TitleBlocks))
for sh in D["sheets"]:
    try:
        sheet = ViewSheet.Create(doc, tb.Id if tb else ElementId.InvalidElementId)
        sheet.SheetNumber = sh["number"]
        sheet.Name = sh["name"]
        for i, vn in enumerate(sh["views"]):
            v = VIEWS.get(vn)
            if v is not None and Viewport.CanAddViewToSheet(doc, sheet.Id, v.Id):
                Viewport.Create(doc, sheet.Id, v.Id, XYZ(ft(0.20 + 0.33 * i), ft(0.29), 0))
    except Exception as e:
        log("Lamina {} omitida: {}".format(sh["number"], e))
t.Commit()

log("=== CASA LINTERNA creada. Guarda el proyecto como CasaLinterna.rvt ===")
OUT = "\n".join(LOG)                       # salida para nodo de Dynamo
