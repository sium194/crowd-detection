@echo off 
:loop 
cloudflared tunnel --url http://localhost:3000 --protocol http2 
timeout /t 5 
goto loop
