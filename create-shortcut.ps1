$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\PR Review Assistant.lnk')
$Shortcut.TargetPath = 'powershell.exe'
$Shortcut.Arguments = '-WindowStyle Hidden -File "e:\pr-review-assistant\start-server.ps1"'
$Shortcut.WorkingDirectory = 'e:\pr-review-assistant'
$Shortcut.IconLocation = 'shell32.dll,13'
$Shortcut.Save()

Write-Output 'Shortcut updated'
