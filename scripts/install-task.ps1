# Реєструє щоденне завдання «ATB Price» у Планувальнику завдань Windows.
# Якщо о вказаний час комп'ютер вимкнено — завдання виконається, щойно він увімкнеться.
param([string]$At = '07:30')

$script = Join-Path $PSScriptRoot 'daily.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3)

Register-ScheduledTask -TaskName 'ATB Price' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Щоденний збір цін АТБ і публікація на GitHub' -Force | Out-Null
Write-Host "Завдання 'ATB Price' зареєстровано: щодня о $At."
