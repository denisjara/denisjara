<#
  01-diagnostico.ps1
  Comprueba que todo funciona: instalación, conexión con Navisworks y datos básicos del modelo.
  Requisito: Navisworks Manage 2027 abierto con un modelo cargado.
  Uso:  powershell -ExecutionPolicy Bypass -File .\01-diagnostico.ps1
#>
param([string]$Salida = "$PSScriptRoot\salida")
$ErrorActionPreference = "Stop"
Import-Module "$PSScriptRoot\NwdMcpCliente.psm1" -Force

function Check($nombre, $ok, $detalle) {
    if ($ok) { Write-Host ("  [OK]    {0,-28} {1}" -f $nombre, $detalle) -ForegroundColor Green }
    else     { Write-Host ("  [FALLA] {0,-28} {1}" -f $nombre, $detalle) -ForegroundColor Red }
}

Write-Paso "1. Instalación local"
$exe = "$env:LOCALAPPDATA\Bimwright\nwd-mcp\server\current\nwd-mcp.exe"
$dll = "$env:APPDATA\Autodesk\ApplicationPlugins\Bimwright.Nwd.bundle\Contents\2027\Bimwright.Nwd.Plugin.Navis27.dll"
$disc = Get-ChildItem "$env:LOCALAPPDATA\Bimwright\nwd-mcp\navis-2027-*.json" -ErrorAction SilentlyContinue
$navis = Get-Process -Name "Roamer" -ErrorAction SilentlyContinue
Check "Servidor MCP"          (Test-Path $exe) $exe
Check "Plugin Navisworks 2027" (Test-Path $dll) $dll
Check "Navisworks abierto"    ([bool]$navis)  ($(if ($navis) { "PID $($navis[0].Id)" } else { "abre Navisworks Manage 2027" }))
Check "Plugin cargado"        ([bool]$disc)   ($(if ($disc) { $disc[0].Name } else { "¿aparece la pestaña Bimwright?" }))
if (-not (Test-Path $exe)) { Write-Host "`nEjecuta primero .\00-instalar-2027.ps1" -ForegroundColor Yellow; exit 1 }

Write-Paso "2. Conexión MCP"
try {
    $info = Start-NwdMcp -Target 2027
    Check "Servidor MCP responde" $true $info.Servidor
    Check "Herramientas"          ($info.Herramientas.Count -gt 0) "$($info.Herramientas.Count) herramientas"

    Write-Paso "3. nwd_health_check"
    $hc = Invoke-NwdTool nwd_health_check
    Save-NwdJson $hc "$Salida\01-health-check.json"
    $conectado = Find-NwdProperty $hc "host_connected"
    $detalle = "host_connected = $conectado"
    if ($null -eq $conectado) {
        # Versiones anteriores del servidor no incluyen host_connected: se prueba leyendo el documento
        try {
            $prueba = Invoke-NwdTool nwd_get_document_info
            $okDoc = Find-NwdProperty $prueba "ok"
            $conectado = ($okDoc -eq $true) -or ($null -ne (Find-NwdProperty $prueba "title"))
            $detalle = "comprobado leyendo el documento (ok = $okDoc)"
        } catch { $conectado = $false; $detalle = "$_" }
    }
    Check "Conectado a Navisworks" ($conectado -eq $true) $detalle

    if ($conectado -ne $true) {
        Write-Host "`nRespuesta del health check:" -ForegroundColor Yellow
        $txt = if ($hc -is [string]) { $hc } else { $hc | ConvertTo-Json -Depth 10 }
        Write-Host ($txt.Substring(0, [Math]::Min(1500, $txt.Length)))
        Write-Host "`nEl servidor funciona pero no ve Navisworks. Comprueba que hay un modelo abierto y repite." -ForegroundColor Yellow
        return
    }

    Write-Paso "4. Instancias de Navisworks detectadas"
    $targets = Invoke-NwdTool nwd_list_available_targets
    $targets | ConvertTo-Json -Depth 10
    Save-NwdJson $targets "$Salida\01-targets.json"

    Write-Paso "5. Documento activo"
    $doc = Get-NwdData (Invoke-NwdTool nwd_get_document_info)
    Write-Host "  Título:   $($doc.title)"
    Write-Host "  Archivo:  $($doc.file_name)"
    Write-Host "  Modelos:  $($doc.model_count)"

    Write-Paso "6. Estadísticas del modelo"
    $st = Get-NwdData (Invoke-NwdTool nwd_get_model_statistics)
    Write-Host "  Elementos:             $($st.item_count)  (completo: $($st.item_count_complete))"
    Write-Host "  Modelos:               $($st.model_count)"
    Write-Host "  Seleccionados ahora:   $($st.current_selection_count)"
    Save-NwdJson @{ documento = $doc; estadisticas = $st } "$Salida\01-resumen.json"

    Write-Host "`nTodo funciona. Siguiente paso: .\02-explorar-modelo.ps1" -ForegroundColor Green
}
finally {
    Stop-NwdMcp
}
