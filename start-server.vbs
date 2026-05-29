Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "e:\pr-review-assistant"
WshShell.Run "E:\AI\node.exe e:\pr-review-assistant\node_modules\tsx\dist\cli.mjs src\server.ts", 0, False