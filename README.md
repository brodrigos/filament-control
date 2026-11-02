# Filament3D

Gerenciador e rastreador de consumo de filamento para impressoras 3D rodando **Klipper / Moonraker** (ex: `192.168.1.101:85`). 

Desenvolvido para monitoramento em tempo real do estado da impressora, cálculo de custos em **USD ($)**, gerenciamento de bobinas (spools) e **débito automático** de filamento em impressões concluídas ou canceladas.

---

## 📷 Preview

![Filament3D Dashboard](screenshot-main.png)

---

## 🚀 Instalação Direta no Servidor da Impressora (Linux)

Rode o script de instalação automática via SSH no host da sua impressora (Raspberry Pi ou SBC Linux):

```bash
git clone https://github.com/brodrigos/filament-control.git
cd filament-control
chmod +x install-script.sh
bash install-script.sh
```

O script configura automaticamente um serviço do Systemd (`filament-control`), garantindo que o app rode em segundo plano na porta **3030** e reinicie junto com o Moonraker/sistema.

---

## 🛠️ Comandos de Gerenciamento do Serviço

- **Ver status:**
  ```bash
  sudo systemctl status filament-control
  ```
- **Ver logs em tempo real:**
  ```bash
  journalctl -u filament-control -f
  ```
- **Reiniciar o serviço:**
  ```bash
  sudo systemctl restart filament-control
  ```

---

## 💡 Recursos
- Conexão direta com o Moonraker (`/printer/objects/query`).
- Cálculo de custo proporcional por grama em USD ($).
- Detecção e débito automático de filamento em falhas, cancelamentos ou conclusões.
- Histórico completo de impressões e consumo.
