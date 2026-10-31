<#
  03-interactuar.ps1
  Demostración de acciones que SÍ cambian la vista de Navisworks (no modifica ni guarda el archivo):
    1. Guarda la vista actual como "MCP demo - antes"
    2. Selecciona los elementos cuyo nombre contiene -Buscar
    3. Los oculta, espera a que lo veas, y los vuelve a mostrar
    4. Limpia la selección y guarda una vista "MCP demo - despues"

  Uso:
    powershell -ExecutionPolicy Bypass -File .\03-interactuar.ps1 -Buscar "Muro"
    (-Si para no pedir confirmación, -SinPausa para no esperar a Enter)
#>
param(
    [Parameter(Mandatory)][string]$Buscar,
    [switch]$Si,
    [switch]$SinPausa,
    [string]$Salida = "$PSScriptRoot\salida"
)
$ErrorActionPreference = "Stop"
Import-Module "$PSScriptRoot\NwdMcpCliente.psm1" -Force

if (-not $Si) {
    Write-Host "Este script va a seleccionar, ocultar y volver a mostrar elementos en Navisworks," -ForegroundColor Yellow
    Write-Host "y a crear dos vistas guardadas 'MCP demo - ...'. No guarda el archivo." -ForegroundColor Yellow
    $r = Read-Host "¿Continuar? (s/n)"
    if ($r -notmatch "^[sSyY]") { Write-Host "Cancelado."; exit 0 }
}

function Pausa($msg) {
    if (-not $SinPausa) { Read-Host "  >> $msg  [Enter para seguir]" | Out-Null } else { Start-Sleep -Seconds 3 }
}

$log = New-Object System.Collections.ArrayList
function Registrar($accion, $resultado) {
    [void]$log.Add([pscustomobject]@{ Hora = (Get-Date).ToString("HH:mm:ss"); Accion = $accion; Resultado = ($resultado | ConvertTo-Json -Depth 10 -Compress) })
}

try {
    $info = Start-NwdMcp -Target 2027
    Write-Host "Conectado a $($info.Servidor) ($($info.Herramientas.Count) herramientas)" -ForegroundColor Green

    Write-Paso "1. Guardando la vista actual"
    $r = Invoke-NwdTool nwd_save_viewpoint @{ name = "MCP demo - antes" }
    Registrar "save_viewpoint antes" $r
    Write-Host "  Vista 'MCP demo - antes' guardada"

    Write-Paso "2. Buscando y seleccionando '$Buscar'"
    $res = Get-NwdData (Invoke-NwdTool nwd_find_items_by_name @{ name = $Buscar; max_items = 1000 } -TimeoutSec 180)
    $ids = @($res.item_ids)
    Write-Host "  Elementos encontrados: $($ids.Count)"
    if ($ids.Count -eq 0) { Write-Host "  Nada que hacer: prueba con otro texto en -Buscar." -ForegroundColor Yellow; return }

    $filtro = @{ category = "Item"; property = "Name"; operator = "contains"; value = $Buscar } | ConvertTo-Json -Compress
    $sel = Invoke-NwdTool nwd_select_items_by_search @{ filters_json = $filtro } -TimeoutSec 180
    Registrar "select_items_by_search" $sel
    $actual = Get-NwdData (Invoke-NwdTool nwd_get_current_selection)
    Write-Host "  Seleccionados en Navisworks: $(@($actual.item_ids).Count)" -ForegroundColor Green
    Pausa "Mira Navisworks: los elementos están seleccionados"

    Write-Paso "3. Ocultando los elementos encontrados"
    $h = Get-NwdData (Invoke-NwdTool nwd_hide_items @{ item_ids = $ids; hide = $true } -TimeoutSec 180)
    Registrar "hide_items" $h
    Write-Host "  Ocultados: $($h.hidden_count)"
    Pausa "Mira Navisworks: ahora están ocultos"

    Write-Paso "4. Volviendo a mostrarlos"
    $h2 = Get-NwdData (Invoke-NwdTool nwd_hide_items @{ item_ids = $ids; hide = $false } -TimeoutSec 180)
    Registrar "show_items" $h2
    Write-Host "  Mostrados de nuevo: $($h2.hidden_count)"

    Write-Paso "5. Limpiando selección y guardando vista final"
    Registrar "clear_selection" (Invoke-NwdTool nwd_clear_selection)
    Registrar "save_viewpoint despues" (Invoke-NwdTool nwd_save_viewpoint @{ name = "MCP demo - despues" })
    Write-Host "  Vista 'MCP demo - despues' guardada (panel Vistas guardadas de Navisworks)"

    Write-Paso "6. Volviendo a la vista inicial"
    $vps = Get-NwdData (Invoke-NwdTool nwd_list_viewpoints)
    $antes = @($vps.viewpoints | Where-Object { $_.name -like "*MCP demo - antes" }) | Select-Object -Last 1
    if ($antes) {
        Registrar "goto_viewpoint" (Invoke-NwdTool nwd_goto_viewpoint @{ viewpoint_id = $antes.id })
        Write-Host "  Cámara restaurada a 'MCP demo - antes'"
    }

    if (-not (Test-Path $Salida)) { New-Item -ItemType Directory -Path $Salida | Out-Null }
    $log | Export-Csv "$Salida\03-registro-acciones.csv" -NoTypeInformation -Encoding UTF8 -Delimiter ";"
    Write-Host "`nDemostración terminada. Registro: $Salida\03-registro-acciones.csv" -ForegroundColor Green
}
finally {
    Stop-NwdMcp
}
