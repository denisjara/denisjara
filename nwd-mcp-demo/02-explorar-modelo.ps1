<#
  02-explorar-modelo.ps1
  Solo LECTURA: no cambia nada en Navisworks.
  - Árbol del modelo (exportado a CSV)
  - Búsqueda de elementos por nombre
  - Propiedades de los elementos encontrados (exportadas a CSV)
  - Vistas guardadas y conjuntos de selección/búsqueda

  Uso:
    powershell -ExecutionPolicy Bypass -File .\02-explorar-modelo.ps1
    powershell -ExecutionPolicy Bypass -File .\02-explorar-modelo.ps1 -Buscar "Muro" -MaxElementos 50
#>
param(
    [string]$Buscar = "",          # texto a buscar en el nombre de los elementos (vacío = usa el árbol)
    [int]$Profundidad = 3,         # niveles del árbol del modelo
    [int]$MaxElementos = 25,       # cuántos elementos leer en detalle
    [string]$Salida = "$PSScriptRoot\salida"
)
$ErrorActionPreference = "Stop"
Import-Module "$PSScriptRoot\NwdMcpCliente.psm1" -Force
if (-not (Test-Path $Salida)) { New-Item -ItemType Directory -Path $Salida | Out-Null }

# Recorre el árbol y lo convierte en filas planas
function Expand-Arbol($nodos, [int]$nivel, [string]$ruta) {
    foreach ($n in $nodos) {
        $r = if ($ruta) { "$ruta / $($n.name)" } else { $n.name }
        [pscustomobject]@{
            Nivel        = $nivel
            Id           = $n.id
            Nombre       = $n.name
            Tipo         = $n.type
            TieneGeometria = $n.has_geometry
            Ruta         = $r
        }
        if ($n.children) { Expand-Arbol $n.children ($nivel + 1) $r }
    }
}

try {
    $info = Start-NwdMcp -Target 2027 -ReadOnly
    Write-Host "Conectado a $($info.Servidor) en modo SOLO LECTURA ($($info.Herramientas.Count) herramientas)" -ForegroundColor Green

    # ---------------------------------------------------------------- árbol
    Write-Paso "1. Árbol del modelo (profundidad $Profundidad)"
    $arbol = Get-NwdData (Invoke-NwdTool nwd_get_model_tree @{ max_depth = $Profundidad; max_items = 2000 } -TimeoutSec 180)
    $filas = @(Expand-Arbol $arbol.roots 0 "")
    $filas | Select-Object -First 30 | ForEach-Object {
        Write-Host ("  " + ("  " * $_.Nivel) + "- " + $_.Nombre + "  [" + $_.Tipo + "]")
    }
    if ($filas.Count -gt 30) { Write-Host "  ... ($($filas.Count) nodos en total)" -ForegroundColor DarkGray }
    $filas | Export-Csv "$Salida\02-arbol-modelo.csv" -NoTypeInformation -Encoding UTF8 -Delimiter ";"
    Write-Host "  -> guardado: $Salida\02-arbol-modelo.csv" -ForegroundColor DarkGray

    # ---------------------------------------------------------------- búsqueda
    if ($Buscar) {
        Write-Paso "2. Buscando elementos cuyo nombre contiene '$Buscar'"
        $res = Get-NwdData (Invoke-NwdTool nwd_find_items_by_name @{ name = $Buscar; max_items = 500 } -TimeoutSec 180)
        $ids = @($res.item_ids)
        Write-Host "  Encontrados: $($ids.Count)"
    } else {
        Write-Paso "2. Sin -Buscar: se toman elementos con geometría del árbol"
        $ids = @($filas | Where-Object { $_.TieneGeometria -eq $true } | ForEach-Object { $_.Id })
        if ($ids.Count -eq 0) { $ids = @($filas | Where-Object { $_.Nivel -gt 0 } | ForEach-Object { $_.Id }) }
        Write-Host "  Candidatos: $($ids.Count)  (usa -Buscar ""texto"" para filtrar por nombre)"
    }
    $ids = @($ids | Select-Object -First $MaxElementos)
    Save-NwdJson $ids "$Salida\02-ids-seleccionados.json"

    # ---------------------------------------------------------------- propiedades
    if ($ids.Count -gt 0) {
        Write-Paso "3. Propiedades de $($ids.Count) elementos"
        $props = Get-NwdData (Invoke-NwdTool nwd_batch_get_properties @{ item_ids = $ids; max_items = $MaxElementos } -TimeoutSec 180)
        $tabla = foreach ($it in $props.items) {
            foreach ($cat in $it.categories) {
                foreach ($p in $cat.properties) {
                    [pscustomobject]@{
                        Id        = $it.item_id
                        Elemento  = $it.display_name
                        Clase     = $it.class_display_name
                        Categoria = $cat.name
                        Propiedad = $p.name
                        Valor     = $p.value
                    }
                }
            }
        }
        $tabla = @($tabla)
        $tabla | Export-Csv "$Salida\02-propiedades.csv" -NoTypeInformation -Encoding UTF8 -Delimiter ";"
        Write-Host "  $($tabla.Count) valores de propiedades -> $Salida\02-propiedades.csv" -ForegroundColor DarkGray

        $primero = $props.items | Select-Object -First 1
        if ($primero) {
            Write-Host "`n  Ejemplo: '$($primero.display_name)' ($($primero.class_display_name))" -ForegroundColor Yellow
            foreach ($cat in ($primero.categories | Select-Object -First 4)) {
                Write-Host "    [$($cat.name)]" -ForegroundColor Cyan
                foreach ($p in ($cat.properties | Select-Object -First 6)) { Write-Host "      $($p.name): $($p.value)" }
            }
        }

        Write-Paso "4. Categorías de propiedades más comunes"
        $tabla | Group-Object Categoria | Sort-Object Count -Descending | Select-Object -First 10 |
            ForEach-Object { Write-Host ("  {0,-40} {1,6} valores" -f $_.Name, $_.Count) }
    }

    # ---------------------------------------------------------------- vistas y conjuntos
    Write-Paso "5. Vistas guardadas"
    $vps = Get-NwdData (Invoke-NwdTool nwd_list_viewpoints)
    if (@($vps.viewpoints).Count -eq 0) { Write-Host "  (no hay vistas guardadas)" }
    else { $vps.viewpoints | ForEach-Object { Write-Host "  - [$($_.type)] $($_.name)" } }
    Save-NwdJson $vps "$Salida\02-vistas.json"

    Write-Paso "6. Conjuntos de selección y búsqueda"
    $sets = Get-NwdData (Invoke-NwdTool nwd_list_sets)
    if (@($sets.sets).Count -eq 0) { Write-Host "  (no hay conjuntos)" }
    else { $sets.sets | ForEach-Object { Write-Host "  - [$($_.type)] $($_.name)  $(if ($_.count) { "($($_.count) elementos)" })" } }
    Save-NwdJson $sets "$Salida\02-conjuntos.json"

    Write-Paso "7. Cámara actual"
    $cam = Get-NwdData (Invoke-NwdTool nwd_get_current_viewpoint)
    Save-NwdJson $cam "$Salida\02-camara-actual.json"

    Write-Host "`nExploración terminada. Resultados en: $Salida" -ForegroundColor Green
    Write-Host "Siguiente paso: .\03-interactuar.ps1 -Buscar ""texto""" -ForegroundColor Green
}
finally {
    Stop-NwdMcp
}
