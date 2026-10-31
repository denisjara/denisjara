<#
  04-script-csharp.ps1
  Ejecuta scripts C# DENTRO de Navisworks con la herramienta nwd_send_code (solo lectura en estos ejemplos).
  Es la herramienta más potente del MCP: Claude la usa cuando ninguna otra herramienta cubre lo que pides.

  Uso:  powershell -ExecutionPolicy Bypass -File .\04-script-csharp.ps1
#>
param([string]$Salida = "$PSScriptRoot\salida")
$ErrorActionPreference = "Stop"
Import-Module "$PSScriptRoot\NwdMcpCliente.psm1" -Force
if (-not (Test-Path $Salida)) { New-Item -ItemType Directory -Path $Salida | Out-Null }

# Variables disponibles en el script: doc (Document activo). Imports: System, System.Linq,
# System.Collections.Generic, Autodesk.Navisworks.Api. Lo escrito con Console.WriteLine vuelve como stdout
# y el valor de la última expresión vuelve como result.

$ejemplos = [ordered]@{
    "Modelos cargados y unidades" = @'
foreach (var m in doc.Models)
    Console.WriteLine(m.RootItem.DisplayName + " | " + m.FileName + " | unidades: " + m.Units);
doc.Models.Count
'@

    "Elementos con geometría por clase (top 15)" = @'
var grupos = doc.Models.RootItemDescendantsAndSelf
    .Where(i => i.HasGeometry)
    .Take(200000)
    .GroupBy(i => string.IsNullOrEmpty(i.ClassDisplayName) ? "(sin clase)" : i.ClassDisplayName)
    .OrderByDescending(g => g.Count())
    .Take(15);
foreach (var g in grupos) Console.WriteLine(g.Key + ";" + g.Count());
"ok"
'@

    "Caja envolvente del proyecto" = @'
var bb = doc.GetBoundingBox(false);
Console.WriteLine("Min: " + bb.Min.X.ToString("0.00") + ", " + bb.Min.Y.ToString("0.00") + ", " + bb.Min.Z.ToString("0.00"));
Console.WriteLine("Max: " + bb.Max.X.ToString("0.00") + ", " + bb.Max.Y.ToString("0.00") + ", " + bb.Max.Z.ToString("0.00"));
Console.WriteLine("Tamaño: " + bb.Size.X.ToString("0.00") + " x " + bb.Size.Y.ToString("0.00") + " x " + bb.Size.Z.ToString("0.00") + " " + doc.Units);
"ok"
'@
}

try {
    $info = Start-NwdMcp -Target 2027
    if ($info.Herramientas -notcontains "nwd_send_code") {
        Write-Host "nwd_send_code está desactivado en el servidor (BIMWRIGHT_NWD_ENABLE_SEND_CODE / --read-only)." -ForegroundColor Yellow
        return
    }
    $resultados = [ordered]@{}
    foreach ($titulo in $ejemplos.Keys) {
        Write-Paso $titulo
        Write-Host "  Código C#:" -ForegroundColor DarkGray
        $ejemplos[$titulo] -split "`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        $r = Invoke-NwdTool nwd_send_code @{ code = $ejemplos[$titulo] } -TimeoutSec 300
        $stdout = Find-NwdProperty $r "stdout"
        $err = Find-NwdProperty $r "error"
        Write-Host "  Resultado:" -ForegroundColor Yellow
        if ($stdout) { $stdout -split "`n" | Where-Object { $_ } | ForEach-Object { Write-Host "    $_" } }
        if ($err)    { Write-Host "    ERROR: $err" -ForegroundColor Red }
        $resultados[$titulo] = $r
    }
    Save-NwdJson $resultados "$Salida\04-scripts-csharp.json"
    Write-Host "`nListo. Escribe tus propios scripts copiando estos ejemplos." -ForegroundColor Green
}
finally {
    Stop-NwdMcp
}
