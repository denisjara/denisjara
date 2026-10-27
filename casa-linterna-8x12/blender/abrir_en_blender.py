# Pegar en Blender: pestaña "Scripting" > botón "Nuevo" > pegar > "Ejecutar script" (Alt+P).
# Descarga la escena de la Casa Linterna desde GitHub y la abre.
import bpy, os, tempfile, urllib.request

URL = ("https://raw.githubusercontent.com/denisjara/denisjara/claude/vibrant-curie-ckl6zq/"
       "casa-linterna-8x12/blender/CasaLinterna.blend")
dest = os.path.join(tempfile.gettempdir(), "CasaLinterna.blend")
print("Descargando", URL)
urllib.request.urlretrieve(URL, dest)
bpy.ops.wm.open_mainfile(filepath=dest)
print("Abierto:", dest, "- cámaras: Cam calle, Cam cochera, Cam sala, Cam cocina, Cam dormitorio, Cam terraza, Cam aerea")
