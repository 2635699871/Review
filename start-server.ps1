# Start server in background
$proc = Start-Process -FilePath "E:\AI\node.exe" `
  -ArgumentList "e:\pr-review-assistant\node_modules\tsx\dist\cli.mjs src\server.ts" `
  -WorkingDirectory "e:\pr-review-assistant" `
  -WindowStyle Hidden `
  -PassThru

# Wait for server to be ready
do {
  Start-Sleep -Milliseconds 500
  try {
    $null = Invoke-WebRequest -Uri "http://localhost:3300" -TimeoutSec 1 -UseBasicParsing
    break
  } catch {}
} while ($true)

# Open browser
Start-Process "http://localhost:3300"