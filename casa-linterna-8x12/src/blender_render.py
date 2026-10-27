"""Render fotorrealista con Blender (bpy) + Cycles a partir del modelo parametrico.

Uso:  python3 src/blender_render.py [--shots calle,cochera,...] [--samples 256] [--res 1920x1200] [--blend]

- Geometria: cada grupo de prismas del modelo se convierte en una malla (con bisel en aristas).
- Materiales PBR con texturas CC0 de Poly Haven proyectadas en caja (sin UV).
- Mobiliario real de Poly Haven (sofas, sillones, sillas, mesas de centro, plantas) en lugar de los bloques.
- Autos: carroceria por secciones con superficie de subdivision, pintura con barniz, llantas y aros.
- Cielo HDRI + sol, contexto urbano (calle, veredas, vecinos) y luces interiores.
"""
import argparse
import math
import os
import sys
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Vector, Matrix  # noqa: E402

import polyhaven as ph  # noqa: E402
from model import all_prisms, build_rooms, LV, LOT_X, LOT_Y, Y0, SLAB  # noqa: E402

OUT = os.path.join(HERE, "..", "entregables", "renders")

# ---------------------------------------------------------------------------
# MATERIALES
# ---------------------------------------------------------------------------
_MATS = {}


def _inp(node, *names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    raise KeyError(names)


def pbr(name, tex=None, size=1.0, color=(0.8, 0.8, 0.8), tint=None, rough=0.5, metallic=0.0, nstr=0.6,
        coat=0.0, transmission=0.0, ior=1.45, emission=None, estr=0.0, rot=0.0, glass=False, alpha=1.0, sheen=0.0):
    """Material Principled; tex = id de textura Poly Haven proyectada en caja con coordenadas de mundo."""
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputMaterial")
    bsdf = N.new("ShaderNodeBsdfPrincipled")
    _inp(bsdf, "Base Color").default_value = (*color, 1)
    _inp(bsdf, "Roughness").default_value = rough
    _inp(bsdf, "Metallic").default_value = metallic
    _inp(bsdf, "IOR").default_value = ior
    if coat:
        _inp(bsdf, "Coat Weight").default_value = coat
        _inp(bsdf, "Coat Roughness").default_value = 0.03
    if transmission:
        _inp(bsdf, "Transmission Weight").default_value = transmission
    if sheen:
        _inp(bsdf, "Sheen Weight").default_value = sheen
    if emission:
        _inp(bsdf, "Emission Color").default_value = (*emission, 1)
        _inp(bsdf, "Emission Strength").default_value = estr
    if alpha < 1:
        _inp(bsdf, "Alpha").default_value = alpha
    if tex:
        files = ph.texture(tex)
        geo = N.new("ShaderNodeNewGeometry")
        mp = N.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1 / size, 1 / size, 1 / size)
        mp.inputs["Rotation"].default_value = (0, 0, math.radians(rot))
        L.new(geo.outputs["Position"], mp.inputs["Vector"])

        def img(path, noncolor):
            t = N.new("ShaderNodeTexImage")
            t.image = bpy.data.images.load(path, check_existing=True)
            if noncolor:
                t.image.colorspace_settings.name = "Non-Color"
            t.projection = "BOX"
            t.projection_blend = 0.25
            L.new(mp.outputs["Vector"], t.inputs["Vector"])
            return t
        if "diff" in files:
            d = img(files["diff"], False)
            if tint:
                mix = N.new("ShaderNodeMix")
                mix.data_type = "RGBA"
                mix.blend_type = "MULTIPLY"
                mix.inputs["Factor"].default_value = 1.0
                ins = [i for i in mix.inputs if i.type == "RGBA"]
                L.new(d.outputs["Color"], ins[0])
                ins[1].default_value = (*tint, 1)
                outs = [o for o in mix.outputs if o.type == "RGBA"]
                L.new(outs[0], _inp(bsdf, "Base Color"))
            else:
                L.new(d.outputs["Color"], _inp(bsdf, "Base Color"))
        if "rough" in files:
            r = img(files["rough"], True)
            rm = N.new("ShaderNodeMapRange")
            rm.inputs["To Min"].default_value = max(0.0, rough - 0.25)
            rm.inputs["To Max"].default_value = min(1.0, rough + 0.25)
            L.new(r.outputs["Color"], rm.inputs["Value"])
            L.new(rm.outputs["Result"], _inp(bsdf, "Roughness"))
        if "nor" in files:
            nm = N.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = nstr
            L.new(img(files["nor"], True).outputs["Color"], nm.inputs["Color"])
            L.new(nm.outputs["Normal"], _inp(bsdf, "Normal"))
    shader = bsdf.outputs["BSDF"]
    if glass:
        # vidrio: transparente para los rayos de sombra (deja pasar el sol al interior)
        lp = N.new("ShaderNodeLightPath")
        tr = N.new("ShaderNodeBsdfTransparent")
        tr.inputs["Color"].default_value = (0.92, 0.96, 0.97, 1)
        mx = N.new("ShaderNodeMixShader")
        L.new(lp.outputs["Is Shadow Ray"], mx.inputs["Fac"])
        L.new(shader, mx.inputs[1])
        L.new(tr.outputs["BSDF"], mx.inputs[2])
        shader = mx.outputs["Shader"]
    L.new(shader, out.inputs["Surface"])
    _MATS[name] = m
    return m


def materials():
    W = (0.93, 0.92, 0.89)
    return {
        "muro_blanco": pbr("Pintura exterior", "painted_plaster_wall", 2.0, tint=(1.0, 0.985, 0.955), rough=0.85, nstr=0.35),
        "muro_int": pbr("Pintura interior", "plastered_wall_04", 2.0, tint=(1.0, 0.99, 0.965), rough=0.9, nstr=0.25),
        "muro_gris": pbr("Pintura interior", "plastered_wall_04", 2.0, tint=(1.0, 0.99, 0.965), rough=0.9, nstr=0.25),
        "concreto": pbr("Cielo raso tarrajeado", "plastered_wall_04", 2.0, tint=W, rough=0.9, nstr=0.2),
        "concreto_visto": pbr("Concreto caravista", "brushed_concrete", 1.5, tint=(0.95, 0.95, 0.95), rough=0.75, nstr=0.6),
        "vidrio": pbr("Vidrio templado", color=(0.95, 0.98, 0.98), rough=0.02, transmission=1.0, ior=1.5, glass=True),
        "aluminio": pbr("Aluminio negro", color=(0.025, 0.026, 0.028), rough=0.35, metallic=0.85),
        "madera": pbr("Madera roble", "oak_veneer_01", 1.2, rough=0.45, nstr=0.3),
        "madera_osc": pbr("Madera nogal", "mocha_oak_veneer", 1.2, rough=0.4, nstr=0.3),
        "acero": pbr("Acero pintado negro", color=(0.03, 0.032, 0.035), rough=0.42, metallic=0.4),
        "acero_galv": pbr("Acero galvanizado", color=(0.62, 0.64, 0.66), rough=0.3, metallic=1.0),
        "acero_inox": pbr("Acero inoxidable", color=(0.75, 0.76, 0.77), rough=0.22, metallic=1.0),
        "panel_tr4": pbr("Panel TR4", "corrugated_iron_02", 0.9, tint=(0.33, 0.35, 0.38), rough=0.45, metallic=0.6, nstr=1.0, rot=90),
        "policarbonato": pbr("Policarbonato", color=(0.93, 0.96, 0.97), rough=0.35, transmission=0.85, ior=1.58, glass=True),
        "piso_cochera": pbr("Concreto pulido cochera", "brushed_concrete", 2.5, tint=(1.12, 1.10, 1.06), rough=0.65, nstr=0.5),
        "vereda": pbr("Vereda", "concrete_tiles", 2.0, rough=0.85, nstr=0.6),
        "piso_int": pbr("Contrapiso", "brushed_concrete", 2.0, rough=0.8),
        "tela": pbr("Tela clara", "fabric_pattern_07", 0.4, color=(0.80, 0.77, 0.72), rough=0.9, nstr=0.4, sheen=0.4),
        "tela_osc": pbr("Tela gris", "fabric_pattern_07", 0.4, color=(0.25, 0.27, 0.29), rough=0.9, nstr=0.4, sheen=0.4),
        "cuarzo": pbr("Cuarzo", "marble_01", 1.0, tint=(1.05, 1.05, 1.05), rough=0.15, nstr=0.1),
        "laca": pbr("Laca blanca", color=(0.86, 0.85, 0.82), rough=0.3, coat=0.3),
        "blanco": pbr("Esmalte blanco", color=(0.9, 0.9, 0.9), rough=0.25),
        "loza": pbr("Loza", color=(0.93, 0.93, 0.92), rough=0.08, coat=0.6),
        "espejo": pbr("Espejo", color=(0.95, 0.95, 0.95), rough=0.0, metallic=1.0),
        "colchon": pbr("Sábana", "fabric_pattern_07", 0.3, color=(0.93, 0.92, 0.9), rough=0.95, nstr=0.2, sheen=0.5),
        "almohada": pbr("Almohada", "fabric_pattern_07", 0.3, color=(0.95, 0.94, 0.92), rough=0.95, nstr=0.2, sheen=0.5),
        "edredon": pbr("Edredón", "fabric_pattern_07", 0.35, color=(0.42, 0.50, 0.55), rough=0.95, nstr=0.5, sheen=0.6),
        "lampara": pbr("Pantalla lámpara", color=(0.95, 0.88, 0.72), rough=0.6, emission=(1.0, 0.82, 0.6), estr=6.0),
        "pantalla": pbr("Pantalla TV", color=(0.01, 0.01, 0.012), rough=0.05),
        "maceta": pbr("Maceta", "brushed_concrete", 0.5, tint=(0.75, 0.62, 0.52), rough=0.8),
        "canto_rodado": pbr("Canto rodado", "concrete_floor_01", 1.0, rough=0.9),
        "piso_ext": pbr("Cerámico exterior", "anti_slip_concrete", 1.5, rough=0.8),
        "verde": pbr("Follaje", color=(0.18, 0.32, 0.12), rough=0.6),
        "verde_claro": pbr("Follaje claro", color=(0.25, 0.42, 0.16), rough=0.6),
        "cimiento": pbr("Cimiento", color=(0.5, 0.48, 0.45), rough=0.9),
        "celosia_met": pbr("Celosía metálica", color=(0.05, 0.05, 0.05), rough=0.5, metallic=0.5),
    }


FLOOR_FINISH = {
    "Porcelanato 60x120": ("Porcelanato 60x120", "marble_01", 3.0, (1.02, 1.0, 0.97), 0.12),
    "Piso laminado": ("Piso laminado roble", "laminate_floor_02", 2.0, None, 0.35),
    "Porcelanato": ("Porcelanato baño", "floor_tiles_06", 1.2, None, 0.2),
    "Cerámico": ("Cerámico baño", "floor_tiles_06", 1.2, None, 0.2),
    "Porcelanato antideslizante": ("Porcelanato exterior", "concrete_tiles", 1.8, (1.08, 1.06, 1.02), 0.7),
    "Concreto estampado": None,
}

# ---------------------------------------------------------------------------
# GEOMETRIA
# ---------------------------------------------------------------------------
COL = {}


def coll(name):
    if name not in COL:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        COL[name] = c
    return COL[name]


def mesh_from_prisms(name, prisms, mat, collection, smooth=False):
    bm = bmesh.new()
    for p in prisms:
        pts = []
        for q in p.poly:
            if not pts or (abs(q[0] - pts[-1][0]) > 1e-6 or abs(q[1] - pts[-1][1]) > 1e-6):
                pts.append(q)
        if len(pts) > 2 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6:
            pts.pop()
        if len(pts) < 3 or p.x2 - p.x1 < 1e-6:
            continue
        a = [bm.verts.new((p.x1, y, z)) for y, z in pts]
        b = [bm.verts.new((p.x2, y, z)) for y, z in pts]
        try:
            bm.faces.new(a[::-1])
            bm.faces.new(b)
            n = len(pts)
            for i in range(n):
                j = (i + 1) % n
                bm.faces.new((a[i], a[j], b[j], b[i]))
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    collection.objects.link(ob)
    return ob


def loft(name, slices, mat, collection, subdiv=2):
    """Malla continua a traves de rebanadas contiguas con el mismo numero de vertices (carroceria de autos)."""
    st = [(slices[0].x1, slices[0].poly)] + [((s.x1 + s.x2) / 2, s.poly) for s in slices] + [(slices[-1].x2, slices[-1].poly)]
    bm = bmesh.new()
    rings = [[bm.verts.new((x, y, z)) for y, z in poly] for x, poly in st]
    n = len(rings[0])
    for r0, r1 in zip(rings[:-1], rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    collection.objects.link(ob)
    if subdiv:
        m = ob.modifiers.new("Subdivision", "SUBSURF")
        m.levels = m.render_levels = subdiv
    return ob


def bevel(ob, w, seg=2):
    m = ob.modifiers.new("Bisel", "BEVEL")
    m.width = w
    m.segments = seg
    m.limit_method = "ANGLE"
    m.harden_normals = False
    return m


def cylinder(name, c_y, c_z, r, x1, x2, mat, collection, verts=48, bevel_w=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=x2 - x1, location=((x1 + x2) / 2, c_y, c_z),
                                        rotation=(0, math.pi / 2, 0))
    ob = bpy.context.active_object
    ob.name = name
    for c in ob.users_collection:
        c.objects.unlink(ob)
    collection.objects.link(ob)
    ob.data.materials.append(mat)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    if bevel_w:
        bevel(ob, bevel_w, 4)
    return ob


# ---------------------------------------------------------------------------
# MOBILIARIO REAL (Poly Haven) — instancias de coleccion ajustadas al volumen del modelo
# ---------------------------------------------------------------------------
_ASSETS = {}


def asset(name):
    if name in _ASSETS:
        return _ASSETS[name]
    path = ph.model(name)
    c = bpy.data.collections.new("ASSET_" + name)
    bpy.context.scene.collection.children.link(c)
    lc = bpy.context.view_layer.layer_collection.children[c.name]
    bpy.context.view_layer.active_layer_collection = lc
    bpy.ops.import_scene.gltf(filepath=path)
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection
    bpy.context.scene.collection.children.unlink(c)
    pts = []
    for ob in c.all_objects:
        if ob.type == "MESH":
            mw = ob.matrix_world
            pts += [mw @ v.co for v in ob.data.vertices]
    xs, ys, zs = [p.x for p in pts], [p.y for p in pts], [p.z for p in pts]
    lo, hi = Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))
    ctr = (lo + hi) / 2
    top = [p for p in pts if p.z > lo.z + 0.7 * (hi.z - lo.z)]
    back = Vector((sum(p.x for p in top) / len(top) - ctr.x, sum(p.y for p in top) / len(top) - ctr.y, 0)) if top else Vector((0, 1, 0))
    _ASSETS[name] = (c, lo, hi, back)
    return _ASSETS[name]


def place_asset(name, tgt_lo, tgt_hi, tgt_back=None, fit="footprint", collection=None):
    c, lo, hi, back = asset(name)
    ang = 0.0
    if tgt_back is not None and back.length > 0.02:
        ang = math.atan2(tgt_back[1], tgt_back[0]) - math.atan2(back.y, back.x)
    R = Matrix.Rotation(ang, 4, "Z")
    dims = R.to_3x3() @ (hi - lo)
    dx, dy, dz = abs(dims.x), abs(dims.y), hi.z - lo.z
    tx, ty, tz = tgt_hi[0] - tgt_lo[0], tgt_hi[1] - tgt_lo[1], tgt_hi[2] - tgt_lo[2]
    s = tz / dz if fit == "height" else min(tx / dx, ty / dy)
    ctr = (lo + hi) / 2
    rc = R.to_3x3() @ ctr
    loc = Vector(((tgt_lo[0] + tgt_hi[0]) / 2 - s * rc.x, (tgt_lo[1] + tgt_hi[1]) / 2 - s * rc.y, tgt_lo[2] - s * lo.z))
    e = bpy.data.objects.new(f"{name}@{tgt_lo[0]:.2f},{tgt_lo[1]:.2f}", None)
    e.instance_type = "COLLECTION"
    e.instance_collection = c
    e.matrix_world = Matrix.Translation(loc) @ R @ Matrix.Scale(s, 4)
    (collection or coll("Mobiliario")).objects.link(e)
    return e


def _bbox(prisms):
    xs = [p.x1 for p in prisms] + [p.x2 for p in prisms]
    ys = [q[0] for p in prisms for q in p.poly]
    zs = [q[1] for p in prisms for q in p.poly]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def _back(prisms, part="RESPALDO"):
    lo, hi = _bbox(prisms)
    bk = [p for p in prisms if p.name.startswith(part)]
    if not bk:
        return None
    blo, bhi = _bbox(bk)
    v = ((blo[0] + bhi[0]) / 2 - (lo[0] + hi[0]) / 2, (blo[1] + bhi[1]) / 2 - (lo[1] + hi[1]) / 2)
    return (1.0 if v[0] > 0 else -1.0, 0.0) if abs(v[0]) > abs(v[1]) else (0.0, 1.0 if v[1] > 0 else -1.0)


def replace_with_asset(group, prisms):
    """Devuelve True si el grupo se reemplaza por un modelo real."""
    lo, hi = _bbox(prisms)
    if group.startswith("SOFA-"):
        l = max(hi[0] - lo[0], hi[1] - lo[1])
        place_asset("sofa_02" if l > 1.4 else "modern_arm_chair_01", lo, (hi[0], hi[1], lo[2] + 0.85), _back(prisms))
        return True
    if group.startswith("SILLA-"):
        place_asset("dining_chair_02", lo, hi, _back(prisms))
        return True
    if group.startswith(("MESA-CENTRO", "MESA-TC")):
        place_asset("modern_coffee_table_01", lo, hi)
        return True
    if group.startswith("PLANTA-"):
        h = hi[2] - lo[2]
        place_asset("potted_plant_01" if h > 1.05 else "potted_plant_04", lo, (hi[0], hi[1], lo[2] + h * 1.15), fit="height")
        return True
    if group.startswith("BANQ"):
        place_asset("bar_chair_round_01", lo, (hi[0], hi[1], lo[2] + 0.75), fit="height")
        return True
    return False


SOFT = ("COLCHÓN", "EDREDÓN", "PIE EDREDÓN", "ALMOHADA", "COJÍN", "COJÍN RESPALDO", "BASE SOFÁ", "RESPALDO", "BRAZO")


# ---------------------------------------------------------------------------
# ESCENA
# ---------------------------------------------------------------------------
def build_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = materials()
    P = all_prisms()
    groups = OrderedDict()
    for i, p in enumerate(P):
        if p.cat == "cimentacion":
            continue
        groups.setdefault(p.group or f"{p.name}#{i}", []).append(p)
    cars = defaultdict(list)
    n_obj = 0
    for g, ps in groups.items():
        if ps[0].cat == "vehiculo":
            cars[g] += ps
            continue
        if replace_with_asset(g, ps):
            continue
        by_mat = OrderedDict()
        for p in ps:
            key = p.mat
            if p.cat == "mobiliario" and p.name in SOFT:
                key = p.mat + "|soft"
            by_mat.setdefault(key, []).append(p)
        for key, pp in by_mat.items():
            mat_key = key.split("|")[0]
            mat = M.get(mat_key) or pbr(mat_key, color=(0.7, 0.7, 0.7))
            if pp[0].name in ("LOSA-COCHERA",):
                mat = M["piso_cochera"]
            cat = pp[0].cat
            cname = {"mobiliario": "Mobiliario", "jardin": "Mobiliario"}.get(cat, "Arquitectura" if cat in (
                "muro", "losa", "viga", "columna", "escalera", "fachada", "puerta", "ventana", "baranda", "celosia") else "Estructura metalica")
            ob = mesh_from_prisms(f"{cat}:{g}:{mat_key}", pp, mat, coll(cname), smooth=key.endswith("soft"))
            n_obj += 1
            if key.endswith("soft"):
                bevel(ob, 0.035 if "COLCH" in pp[0].name or "EDRED" in pp[0].name else 0.03, 4)
            elif cat == "mobiliario":
                bevel(ob, 0.006, 2)
            elif cat in ("muro", "columna", "viga", "fachada", "losa"):
                bevel(ob, 0.004, 1)
    floors(M)
    for g, ps in cars.items():
        build_car(g, ps)
    context(M)
    lights()
    print("objetos de arquitectura/mobiliario:", n_obj, "autos:", len(cars))


def floors(M):
    """Acabados de piso por ambiente (sobre la losa)."""
    c = coll("Acabados")
    for i, r in enumerate(build_rooms()):
        spec = FLOOR_FINISH.get(r.finish)
        if not spec or r.level == 3:
            continue
        nm, tex, size, tint, rough = spec
        mat = pbr(nm, tex, size, tint=tint, rough=rough, nstr=0.4)
        x1, y1, x2, y2 = r.rect
        z = LV[r.level] + (0.004 if r.name.startswith("BAÑO") else 0.002)
        from model import box
        mesh_from_prisms(f"piso:{r.name}:{r.level}", [box(x1, x2, y1, y2, z - 0.002, z, "x", "losa")], mat, c)
    # terraza: sobre las piezas de la losa del 3er nivel
    mat = pbr("Porcelanato exterior", "concrete_tiles", 1.8, tint=(1.08, 1.06, 1.02), rough=0.7, nstr=0.4)
    from model import box
    pieces = [p for p in all_prisms() if p.name == "LOSA-3"]
    mesh_from_prisms("piso:TERRAZA", [box(p.x1, p.x2, p.yz_bounds()[0], p.yz_bounds()[1], LV[3], LV[3] + 0.003, "x", "losa")
                                       for p in pieces], mat, c)


def _superellipse(hw, z0, z1, n=4.0, k=28):
    """Seccion transversal redondeada (media altura con laterales casi rectos)."""
    zc, hz = (z0 + z1) / 2, (z1 - z0) / 2
    pts = []
    for i in range(k):
        t = 2 * math.pi * i / k
        c, s_ = math.cos(t), math.sin(t)
        x = hw * math.copysign(abs(c) ** (2 / n), c)
        z = zc + hz * math.copysign(abs(s_) ** (2 / n), s_)
        pts.append((x, z))
    return pts


def _loft_sections(name, sections, mat, collection):
    """sections: lista de (y, [(x, z), ...]) con el mismo numero de puntos; cierra los extremos."""
    bm = bmesh.new()
    rings = [[bm.verts.new((x, y, z)) for x, z in pts] for y, pts in sections]
    n = len(rings[0])
    for r0, r1 in zip(rings[:-1], rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    c0 = bm.verts.new(sum((v.co for v in rings[0]), Vector()) / n)
    c1 = bm.verts.new(sum((v.co for v in rings[-1]), Vector()) / n)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][j], rings[0][i], c0))
        bm.faces.new((rings[-1][i], rings[-1][j], c1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    collection.objects.link(ob)
    return ob


def make_car(tag, x0, y0, L, W, paint_rgb):
    """Auto compacto tipo hatchback/SUV: frente hacia +y (y0 = parte posterior)."""
    c = coll("Autos")
    xc = x0 + W / 2
    paint = pbr(f"Pintura auto {tag}", color=paint_rgb, rough=0.3, metallic=0.75, coat=1.0)
    glass = pbr("Vidrio auto", color=(0.015, 0.02, 0.025), rough=0.02, coat=1.0, metallic=0.2)
    plastic = pbr("Plástico negro", color=(0.018, 0.018, 0.02), rough=0.6)
    chrome = pbr("Cromo", color=(0.9, 0.9, 0.9), rough=0.08, metallic=1.0)
    head = pbr("Faro", color=(0.9, 0.92, 0.95), rough=0.02, emission=(1, 0.97, 0.9), estr=3.0)
    tail = pbr("Stop", color=(0.45, 0.01, 0.01), rough=0.05, emission=(1, 0.04, 0.02), estr=2.0)
    tire = pbr("Neumático", color=(0.025, 0.025, 0.027), rough=0.85)
    rim = pbr("Aro aleación", color=(0.72, 0.73, 0.74), rough=0.22, metallic=1.0)
    hood0 = L - 1.15          # base del parabrisas

    def belt(s):              # cara superior de la carroceria baja
        if s < 0.30:
            return 0.62 + 0.36 * math.sqrt(max(0.0, 1 - ((0.30 - s) / 0.30) ** 2))
        if s <= hood0:
            return 0.98 + 0.03 * (s - 0.30) / (hood0 - 0.30)
        u = (s - hood0) / (L - hood0)
        return 1.01 - 0.17 * u ** 1.7 - (0.20 * ((u - 0.9) / 0.1) ** 2 if u > 0.9 else 0.0)

    def bottom(s):
        return 0.30 + (0.10 * (1 - s / 0.35) if s < 0.35 else 0.0) + (0.08 * ((s - (L - 0.45)) / 0.45) if s > L - 0.45 else 0.0)

    def halfw(s):
        r = 0.42
        e = min(s, L - s)
        return W / 2 * (math.sqrt(max(0.0, 1 - ((r - e) / r) ** 2)) * 0.25 + 0.75) if e < r else W / 2

    secs = []
    N = 64
    for i in range(N + 1):
        s = L * i / N
        s = min(max(s, 0.01), L - 0.01)
        secs.append((y0 + s, [(xc + x, z) for x, z in _superellipse(halfw(s), bottom(s), belt(s), 5.0)]))
    body = _loft_sections(f"{tag}:carroceria", secs, paint, c)
    body.modifiers.new("Normales", "WEIGHTED_NORMAL")
    # pasos de rueda (booleana)
    rw, fw, R = 0.95, L - 1.00, 0.40
    for ax in (rw, fw):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=R, depth=W + 0.4, location=(xc, y0 + ax, 0.33), rotation=(0, math.pi / 2, 0))
        cut = bpy.context.active_object
        cut.display_type = "WIRE"
        cut.hide_render = True
        m = body.modifiers.new("Paso de rueda", "BOOLEAN")
        m.operation = "DIFFERENCE"
        m.object = cut
        body.modifiers.move(len(body.modifiers) - 1, 0)
    # cabina: vidrio + techo + parantes
    s_ws, s_rf, s_rr, s_bk = hood0, hood0 - 0.85, 1.05, 0.40

    def roof(s):
        if s >= s_rf:
            return 1.0 + 0.55 * (hood0 - s) / (hood0 - s_rf)
        if s >= s_rr:
            return 1.55 + 0.02 * (s - s_rr) / (s_rf - s_rr)
        return 1.0 + 0.55 * (s - s_bk) / (s_rr - s_bk)

    cs = []
    M_ = 40
    for i in range(M_ + 1):
        s = s_bk + (s_ws - s_bk) * i / M_
        zb, zt = belt(s) - 0.02, max(roof(s), belt(s) + 0.02)
        hb, ht = halfw(s) - 0.06, halfw(s) - 0.24
        pts = []
        for x, z in _superellipse(1.0, 0.0, 1.0, 4.0, 24):
            u = (z - 0.0)                       # 0..1
            if u < 0.5:
                u = 0.5                         # mitad inferior colapsada sobre la cintura
            t = (u - 0.5) * 2
            hwz = hb + (ht - hb) * t
            pts.append((xc + x * hwz, zb + (zt - zb) * t))
        cs.append((y0 + s, pts))
    cab = _loft_sections(f"{tag}:cabina", cs, glass, c)
    cab.data.materials.append(paint)
    for poly in cab.data.polygons:
        cen = poly.center
        s = cen.y - y0
        top = poly.normal.z > 0.75 and s_rr + 0.04 < s < s_rf - 0.04
        pillar = abs(poly.normal.x) > 0.55 and (abs(s - 2.18) < 0.06 or s < s_rr - 0.08 or s > s_rf + 0.12)
        if top or pillar:
            poly.material_index = 1
    cab.modifiers.new("Normales", "WEIGHTED_NORMAL")
    # paragolpes, parrilla, luces, placas y espejos
    def blk(name, x1, x2, y1, y2, z1, z2, mat, bw=0.02):
        from model import box
        o = mesh_from_prisms(f"{tag}:{name}", [box(x1, x2, y1, y2, z1, z2, "x", "vehiculo")], mat, c, smooth=True)
        bevel(o, bw, 3)
        return o
    blk("parachoque_del", x0 + 0.10, x0 + W - 0.10, y0 + L - 0.10, y0 + L + 0.015, 0.30, 0.44, plastic, 0.04)
    blk("parachoque_pos", x0 + 0.10, x0 + W - 0.10, y0 - 0.015, y0 + 0.12, 0.33, 0.47, plastic, 0.04)
    blk("parrilla", xc - 0.45, xc + 0.45, y0 + L - 0.07, y0 + L - 0.02, 0.50, 0.66, plastic, 0.02)
    blk("emblema", xc - 0.06, xc + 0.06, y0 + L - 0.035, y0 + L - 0.015, 0.56, 0.61, chrome, 0.005)
    for xa in (x0 + 0.16, x0 + W - 0.52):
        blk("faro", xa, xa + 0.36, y0 + L - 0.13, y0 + L - 0.07, 0.72, 0.80, head, 0.015)
        blk("stop", xa, xa + 0.36, y0 + 0.04, y0 + 0.10, 0.80, 0.90, tail, 0.015)
    blk("placa_del", xc - 0.26, xc + 0.26, y0 + L + 0.01, y0 + L + 0.02, 0.33, 0.44, pbr("Placa", color=(0.85, 0.85, 0.82), rough=0.4), 0.004)
    blk("placa_pos", xc - 0.26, xc + 0.26, y0 - 0.02, y0 - 0.01, 0.52, 0.63, pbr("Placa", color=(0.85, 0.85, 0.82), rough=0.4), 0.004)
    for xa, xb in ((x0 - 0.13, x0 + 0.04), (x0 + W - 0.04, x0 + W + 0.13)):
        blk("espejo", xa, xb, y0 + hood0 - 0.18, y0 + hood0 - 0.04, 0.98, 1.10, paint, 0.03)
    blk("manija_i", x0 + 0.01, x0 + 0.02, y0 + 2.45, y0 + 2.60, 0.90, 0.93, chrome, 0.004)
    blk("manija_d", x0 + W - 0.02, x0 + W - 0.01, y0 + 2.45, y0 + 2.60, 0.90, 0.93, chrome, 0.004)
    # ruedas: neumatico redondeado + aro de 5 rayos + disco
    for ax in (rw, fw):
        for side in (-1, 1):
            xo = xc + side * (W / 2 - 0.12)
            t = cylinder(f"{tag}:neumatico", y0 + ax, 0.33, 0.33, xo - 0.11, xo + 0.11, tire, c, verts=64, bevel_w=0.07)
            face = xo + side * 0.105
            cylinder(f"{tag}:disco", y0 + ax, 0.33, 0.22, min(face, face - side * 0.04), max(face, face - side * 0.04),
                     pbr("Disco freno", color=(0.15, 0.15, 0.15), rough=0.4, metallic=0.8), c, verts=32)
            cylinder(f"{tag}:aro", y0 + ax, 0.33, 0.215, min(face, face + side * 0.012), max(face, face + side * 0.012), rim, c, verts=48, bevel_w=0.006)
            cylinder(f"{tag}:maza", y0 + ax, 0.33, 0.055, min(face, face + side * 0.03), max(face, face + side * 0.03), chrome, c, verts=24)
            for k in range(5):
                a = 2 * math.pi * k / 5
                yy, zz = y0 + ax + 0.12 * math.cos(a), 0.33 + 0.12 * math.sin(a)
                from model import box
                sp = mesh_from_prisms(f"{tag}:rayo", [box(min(face, face + side * 0.022), max(face, face + side * 0.022),
                                                          yy - 0.10, yy + 0.10, zz - 0.022, zz + 0.022, "x", "vehiculo")], rim, c)
                sp.rotation_euler = (a, 0, 0)
                sp.location = (0, 0, 0)
                # girar alrededor del eje de la rueda
                piv = Vector((0, y0 + ax, 0.33))
                sp.data.transform(Matrix.Translation(-Vector((0, yy, zz))))
                sp.data.transform(Matrix.Rotation(a + math.pi / 2, 4, "X"))
                sp.data.transform(Matrix.Translation(Vector((0, yy, zz))))
                sp.rotation_euler = (0, 0, 0)


def build_car(g, ps):
    lo, hi = _bbox([p for p in ps if p.name == "CARROCERÍA"])
    paint = {"pintura_1": (0.82, 0.83, 0.84), "pintura_2": (0.03, 0.09, 0.24)}
    col = paint.get([p for p in ps if p.name == "CARROCERÍA"][0].mat, (0.5, 0.5, 0.5))
    make_car(g, lo[0], lo[1], hi[1] - lo[1], hi[0] - lo[0], col)


def context(M):
    """Calle, veredas, sardineles y edificios vecinos para dar escala urbana."""
    c = coll("Contexto")
    from model import box
    asph = pbr("Asfalto", "asphalt_02", 3.0, rough=0.85, nstr=0.8)
    side = pbr("Vereda", "concrete_tiles", 2.0, rough=0.85, nstr=0.6)
    curb = pbr("Sardinel", "brushed_concrete", 1.0, tint=(0.85, 0.85, 0.85), rough=0.8)
    mesh_from_prisms("calle", [box(-40, 48, -9.5, -1.35, -0.45, -0.32, "x", "losa")], asph, c)
    mesh_from_prisms("vereda", [box(-40, 0, -1.20, 0.0, -0.30, -0.15, "x", "losa"), box(8, 48, -1.20, 0.0, -0.30, -0.15, "x", "losa"),
                                box(-40, 48, -11.0, -9.65, -0.30, -0.15, "x", "losa")], side, c)
    mesh_from_prisms("sardinel", [box(-40, 48, -1.35, -1.20, -0.45, -0.15, "x", "losa"), box(-40, 48, -9.65, -9.50, -0.45, -0.15, "x", "losa")], curb, c)
    mesh_from_prisms("rampa", [box(0, 8, -1.20, 0.0, -0.30, -0.14, "x", "losa")], M["piso_cochera"], c)
    ground = pbr("Terreno", color=(0.35, 0.33, 0.30), rough=0.95)
    mesh_from_prisms("terreno", [box(-60, 70, -60, 80, -0.50, -0.46, "x", "losa")], ground, c)
    # vecinos: volumenes con ventanas, tarrajeo y color
    neigh = [(-8.5, 0.0, 3.0, 6.3, (0.86, 0.80, 0.70)), (8.0, 16.5, 1.0, 8.9, (0.80, 0.82, 0.84)),
             (-17.0, -8.5, 2.0, 5.9, (0.92, 0.88, 0.82)), (16.5, 25.0, 3.0, 6.5, (0.78, 0.74, 0.68))]
    for i, (x1, x2, yf, h, colr) in enumerate(neigh):
        mw = pbr(f"Vecino {i}", "painted_plaster_wall", 2.0, tint=colr, rough=0.88, nstr=0.4)
        mesh_from_prisms(f"vecino{i}", [box(x1, x2, yf, 18.0, -0.30, h, "x", "muro")], mw, c)
        win = pbr("Ventana vecino", color=(0.05, 0.07, 0.08), rough=0.05, coat=1.0)
        fr = pbr("Marco vecino", color=(0.12, 0.12, 0.12), rough=0.4)
        n = max(1, int((x2 - x1) / 3.0))
        for k in range(n):
            xa = x1 + (k + 0.5) * (x2 - x1) / n - 0.8
            for z in [1.0 + 2.8 * j for j in range(int(h / 2.8))]:
                mesh_from_prisms(f"v{i}{k}{z}", [box(xa, xa + 1.6, yf - 0.03, yf + 0.01, z, z + 1.3, "x", "ventana")], win, c)
                mesh_from_prisms(f"vf{i}{k}{z}", [box(xa - 0.05, xa + 1.65, yf - 0.06, yf - 0.02, z - 0.05, z, "x", "ventana")], fr, c)
        if i == 0:     # reja + puerta de cochera del vecino izquierdo
            gate = pbr("Portón metálico", color=(0.06, 0.06, 0.065), rough=0.4, metallic=0.5)
            mesh_from_prisms("porton", [box(x1 + 1.0, x1 + 4.0, yf - 0.05, yf, -0.15, 2.4, "x", "puerta")], gate, c)
    place_asset("street_lamp_01", (13.0, -1.00, -0.15), (13.8, -0.30, 4.6), fit="height", collection=c)
    place_asset("street_lamp_01", (-9.5, -1.00, -0.15), (-8.7, -0.30, 4.6), fit="height", collection=c)


def lights():
    c = coll("Luces")
    sc = bpy.context.scene
    # cielo HDRI
    w = bpy.data.worlds.new("Cielo")
    sc.world = w
    w.use_nodes = True
    N, L = w.node_tree.nodes, w.node_tree.links
    env = N.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(ph.hdri(ph.HDRI))
    mp = N.new("ShaderNodeMapping")
    tc = N.new("ShaderNodeTexCoord")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(200))
    L.new(tc.outputs["Generated"], mp.inputs["Vector"])
    L.new(mp.outputs["Vector"], env.inputs["Vector"])
    bg = N["Background"]
    bg.inputs["Strength"].default_value = 1.0
    L.new(env.outputs["Color"], bg.inputs["Color"])
    # sol de media manana desde el frente izquierdo
    sun = bpy.data.lights.new("Sol", "SUN")
    sun.energy = 4.8
    sun.angle = math.radians(0.8)
    sun.color = (1.0, 0.96, 0.9)
    so = bpy.data.objects.new("Sol", sun)
    d = Vector((0.55, 0.62, -0.56)).normalized()
    so.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    c.objects.link(so)
    # luces interiores (paneles en el cielo raso)
    for r in build_rooms():
        if r.level > 2 or r.name.startswith(("COCHERA", "BALCÓN")):
            continue
        x1, y1, x2, y2 = r.rect
        a = bpy.data.lights.new(f"Luz {r.name} {r.level}", "AREA")
        a.shape = "RECTANGLE"
        a.size, a.size_y = min(0.9, (x2 - x1) * 0.4), min(0.9, (y2 - y1) * 0.4)
        a.energy = 18.0 * (x2 - x1) * (y2 - y1) / 4 if not r.name.startswith("BAÑO") else 25
        a.color = (1.0, 0.86, 0.68)
        ob = bpy.data.objects.new(a.name, a)
        ob.location = ((x1 + x2) / 2, (y1 + y2) / 2, LV[r.level + 1] - SLAB - 0.02)
        c.objects.link(ob)


SHOTS = OrderedDict([
    ("calle",      dict(eye=(-2.6, -7.6, 1.60), tgt=(4.6, 5.0, 3.5), lens=24, exp=0.0)),
    ("cochera",    dict(eye=(3.30, -2.6, 1.55), tgt=(3.2, 5.0, 2.6), lens=18, exp=0.3)),
    ("sala",       dict(eye=(7.35, 9.55, 1.45), tgt=(1.4, 6.6, 0.95), lens=17, exp=0.6)),
    ("cocina",     dict(eye=(4.35, 11.55, 1.55), tgt=(6.6, 15.6, 1.0), lens=17, exp=1.0)),
    ("dormitorio", dict(eye=(3.10, 8.30, 4.30), tgt=(0.9, 5.3, 3.55), lens=16, exp=0.6)),
    ("terraza",    dict(eye=(1.0, 5.55, 7.25), tgt=(5.8, 15.0, 6.20), lens=17, exp=1.3)),
    ("aerea",      dict(eye=(-10.5, -13.0, 15.0), tgt=(4.0, 7.0, 3.0), lens=32, exp=0.0)),
])


def camera(name, eye, tgt, lens):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.05
    ob = bpy.data.objects.new("Cam " + name, cam)
    ob.location = eye
    ob.rotation_euler = (Vector(tgt) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
    coll("Camaras").objects.link(ob)
    return ob


def render(shots, samples, res):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = "OPENIMAGEDENOISE"
    sc.cycles.max_bounces = 8
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 4
    sc.cycles.transmission_bounces = 8
    sc.cycles.transparent_max_bounces = 16
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.cycles.blur_glossy = 1.0
    sc.render.use_persistent_data = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = "PNG"
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    os.makedirs(OUT, exist_ok=True)
    for k in shots:
        s = SHOTS[k]
        sc.camera = camera(k, s["eye"], s["tgt"], s["lens"])
        sc.view_settings.exposure = s["exp"]
        sc.render.filepath = os.path.join(OUT, f"foto-{k}.png")
        bpy.ops.render.render(write_still=True)
        print("render", k, flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=",".join(SHOTS))
    ap.add_argument("--samples", type=int, default=192)
    ap.add_argument("--res", default="1920x1200")
    ap.add_argument("--blend", action="store_true")
    a = ap.parse_args()
    build_scene()
    for k, s in SHOTS.items():
        camera(k, s["eye"], s["tgt"], s["lens"])
    if a.blend:
        p = os.path.join(HERE, "..", "blender", "CasaLinterna.blend")
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(p), compress=True)
        bpy.ops.file.make_paths_relative()
        bpy.ops.wm.save_mainfile(compress=True)
        print("blend:", p)
    render([k for k in a.shots.split(",") if k], a.samples, tuple(int(v) for v in a.res.split("x")))
