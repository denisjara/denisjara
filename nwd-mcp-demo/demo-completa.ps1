<#
  demo-completa.ps1
  Ejecuta toda la demostración y genera un informe HTML (salida\informe.html) que se abre al terminar.

  Uso:
    powershell -ExecutionPolicy Bypass -File .\demo-completa.ps1
    powershell -ExecutionPolicy Bypass -File .\demo-completa.ps1 -Buscar "Muro" -Interactuar
#>
param(
    [string]$Buscar = "",
    [switch]$Interactuar,     # además ejecuta 03-interactuar.ps1 (selecciona/oculta elementos)
    [string]$Salida = "$PSScriptRoot\salida"
)
$ErrorActionPreference = "Stop"
if (Test-Path $Salida) { Remove-Item "$Salida\*" -Recurse -Force -ErrorAction SilentlyContinue }
else { New-Item -ItemType Directory -Path $Salida | Out-Null }

& "$PSScriptRoot\01-diagnostico.ps1" -Salida $Salida
if (-not (Test-Path "$Salida\01-resumen.json")) {
    Write-Host "`nEl diagnóstico no pudo leer el modelo; se detiene la demo." -ForegroundColor Red
    exit 1
}
& "$PSScriptRoot\02-explorar-modelo.ps1" -Buscar $Buscar -Salida $Salida
& "$PSScriptRoot\04-script-csharp.ps1" -Salida $Salida
if ($Interactuar -and $Buscar) { & "$PSScriptRoot\03-interactuar.ps1" -Buscar $Buscar -Si -SinPausa -Salida $Salida }

# ------------------------------------------------------------------ informe HTML
function Enc($s) { [System.Net.WebUtility]::HtmlEncode([string]$s) }
function Tabla($filas, $max = 200) {
    $filas = @($filas | Select-Object -First $max)
    if ($filas.Count -eq 0) { return "<p class='vacio'>Sin datos</p>" }
    $cols = $filas[0].PSObject.Properties.Name
    $h = "<table><tr>" + (($cols | ForEach-Object { "<th>$(Enc $_)</th>" }) -join "") + "</tr>"
    foreach ($f in $filas) { $h += "<tr>" + (($cols | ForEach-Object { "<td>$(Enc $f.$_)</td>" }) -join "") + "</tr>" }
    return $h + "</table>"
}

$res = Get-Content "$Salida\01-resumen.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$arbol = if (Test-Path "$Salida\02-arbol-modelo.csv") { Import-Csv "$Salida\02-arbol-modelo.csv" -Delimiter ";" } else { @() }
$props = if (Test-Path "$Salida\02-propiedades.csv") { Import-Csv "$Salida\02-propiedades.csv" -Delimiter ";" } else { @() }
$vistas = if (Test-Path "$Salida\02-vistas.json") { (Get-Content "$Salida\02-vistas.json" -Raw -Encoding UTF8 | ConvertFrom-Json).viewpoints } else { @() }
$sets = if (Test-Path "$Salida\02-conjuntos.json") { (Get-Content "$Salida\02-conjuntos.json" -Raw -Encoding UTF8 | ConvertFrom-Json).sets } else { @() }
$cs = if (Test-Path "$Salida\04-scripts-csharp.json") { Get-Content "$Salida\04-scripts-csharp.json" -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$acciones = if (Test-Path "$Salida\03-registro-acciones.csv") { Import-Csv "$Salida\03-registro-acciones.csv" -Delimiter ";" } else { @() }

$csHtml = ""
if ($cs) {
    foreach ($p in $cs.PSObject.Properties) {
        $out = ""
        $node = $p.Value
        if ($node.data) { $node = $node.data }
        if ($node.stdout) { $out = $node.stdout } elseif ($node.error) { $out = "ERROR: " + $node.error }
        $csHtml += "<h3>$(Enc $p.Name)</h3><pre>$(Enc $out)</pre>"
    }
}

$porCategoria = $props | Group-Object Categoria | Sort-Object Count -Descending |
    Select-Object @{n = "Categoría"; e = { $_.Name } }, @{n = "Valores"; e = { $_.Count } }

$html = @"
<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Informe nwd-mcp</title>
<style>
 body{font-family:Segoe UI,Arial,sans-serif;margin:32px;color:#1d2733;background:#f6f8fa}
 h1{color:#2D9B9B;margin-bottom:0} .sub{color:#667;margin-top:4px}
 .kpis{display:flex;gap:16px;margin:24px 0} .kpi{background:#fff;border-radius:10px;padding:16px 22px;box-shadow:0 1px 3px #0002;min-width:150px}
 .kpi b{display:block;font-size:28px;color:#2D9B9B} section{background:#fff;border-radius:10px;padding:8px 22px 18px;margin:18px 0;box-shadow:0 1px 3px #0002}
 table{border-collapse:collapse;width:100%;font-size:13px} th,td{border-bottom:1px solid #e3e7eb;padding:5px 8px;text-align:left}
 th{background:#eef5f5} pre{background:#1d2733;color:#d8f3f3;padding:12px;border-radius:6px;overflow:auto} .vacio{color:#999}
</style></head><body>
<h1>Informe nwd-mcp · Navisworks Manage 2027</h1>
<p class="sub">Generado $(Get-Date -Format "yyyy-MM-dd HH:mm") · documento: <b>$(Enc $res.documento.title)</b> · $(Enc $res.documento.file_name)</p>
<div class="kpis">
 <div class="kpi"><b>$($res.estadisticas.item_count)</b>elementos</div>
 <div class="kpi"><b>$($res.estadisticas.model_count)</b>modelos</div>
 <div class="kpi"><b>$(@($vistas).Count)</b>vistas guardadas</div>
 <div class="kpi"><b>$(@($sets).Count)</b>conjuntos</div>
</div>
<section><h2>Árbol del modelo (primeros 200 nodos)</h2>$(Tabla ($arbol | Select-Object Nivel, Nombre, Tipo, TieneGeometria, Id))</section>
<section><h2>Propiedades por categoría</h2>$(Tabla $porCategoria 30)</section>
<section><h2>Propiedades de los elementos analizados (primeras 300)</h2>$(Tabla $props 300)</section>
<section><h2>Vistas guardadas</h2>$(Tabla ($vistas | Select-Object name, type))</section>
<section><h2>Conjuntos de selección / búsqueda</h2>$(Tabla ($sets | Select-Object name, type, count))</section>
<section><h2>Scripts C# ejecutados dentro de Navisworks</h2>$csHtml</section>
<section><h2>Acciones sobre la vista</h2>$(Tabla ($acciones | Select-Object Hora, Accion))</section>
</body></html>
"@
$html | Set-Content "$Salida\informe.html" -Encoding UTF8
Write-Host "`nInforme: $Salida\informe.html" -ForegroundColor Green
Start-Process "$Salida\informe.html"
