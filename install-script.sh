#!/bin/bash
# Script de instalação do Filament3D no servidor da impressora (Linux / Klipper / Moonraker)

INSTALL_DIR="$HOME/filament-control"
SERVICE_NAME="filament-control"
PORT="3030"

echo "=== Instalando Filament3D ==="
mkdir -p "$INSTALL_DIR"

# Copiar arquivos do repositório atual se existirem
if [ -d "filament-control" ]; then
    cp -r filament-control/* "$INSTALL_DIR/"
elif [ -f "server.js" ]; then
    cp server.js data.json package.json "$INSTALL_DIR/" 2>/dev/null || true
fi

cd "$INSTALL_DIR"

if [ ! -f "package.json" ]; then
    echo "Criando package.json..."
    echo '{"name":"filament-control","version":"1.0.0","main":"server.js","dependencies":{}}' > package.json
fi

NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "Erro: Node.js não encontrado! Instale o Node.js no sistema."
    exit 1
fi

echo "=== Criando serviço Systemd ($SERVICE_NAME) ==="
sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service" << EOT
[Unit]
Description=Filament3D - Gerenciador de Consumo de Filamento
After=network.target moonraker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=5
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
EOT

echo "=== Habilitando e iniciando o serviço ==="
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "=== Instalação concluída! ==="
echo "O Filament3D está rodando em: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "Status do serviço: sudo systemctl status $SERVICE_NAME"
