# Щоденний збір цін з цього комп'ютера і публікація на GitHub.
# Запускається Планувальником завдань Windows (див. scripts\install-task.ps1).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path (Join-Path $root 'daily.log') -Append | Out-Null

function Invoke-Step($name, [scriptblock]$cmd) {
    Write-Host "== $name"
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$name завершився з кодом $LASTEXITCODE" }
}

try {
    Write-Host "Старт: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Invoke-Step 'git pull' { git pull --rebase --quiet }
    Invoke-Step 'npm ci' { npm ci --silent }
    Invoke-Step 'Збір цін' { npm run scrape }
    Invoke-Step 'git add' { git add site/data }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Step 'git commit' { git commit --quiet -m "Ціни за $(Get-Date -Format 'yyyy-MM-dd')" }
        Invoke-Step 'git push' { git push --quiet }
        Write-Host 'Дані опубліковано.'
    } else {
        Write-Host 'Змін немає.'
    }
} catch {
    Write-Host "ПОМИЛКА: $_"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
