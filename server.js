const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3030;
const DATA_FILE = path.join(__dirname, 'data.json');
const STATE_FILE = path.join(__dirname, 'last_print_state.json');

function loadLastPrintState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { state: null, filename: null, filamentUsed: 0, timestamp: null };
    }
}

function saveLastPrintState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const defaultData = {
            spools: [
                {
                    id: "1",
                    name: "PLA Branco Genérico",
                    material: "PLA",
                    color: "#FFFFFF",
                    initialWeightGrams: 1000,
                    emptySpoolWeightGrams: 200,
                    currentWeightGrams: 1000,
                    densityGcm3: 1.24,
                    diameterMm: 1.75,
                    cost: 89.90,
                    notes: "Bobina principal",
                    createdAt: new Date().toISOString()
                }
            ],
            activeSpoolId: "1",
            history: [],
            settings: {
                printerUrl: "http://192.168.1.101:85",
                lowFilamentThresholdGrams: 100
            }
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Proxy/Fetcher helper para Moonraker
function fetchPrinterStatus(printerUrl, callback) {
    const parsed = url.parse(`${printerUrl}/printer/objects/query?print_stats&virtual_sdcard&toolhead`);
    const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.path,
        timeout: 3000
    }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(body);
                callback(null, json.result.status);
            } catch (e) {
                callback(e);
            }
        });
    });
    req.on('error', err => callback(err));
    req.on('timeout', () => { req.destroy(); callback(new Error('Timeout connecting to printer')); });
}

// Servidor HTTP
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API: Obter dados gerais
    if (pathname === '/api/state' && req.method === 'GET') {
        const data = loadData();
        fetchPrinterStatus(data.settings.printerUrl, (err, printerStatus) => {
            if (!err && printerStatus && printerStatus.print_stats) {
                const ps = printerStatus.print_stats;
                const lastState = loadLastPrintState();
                const currentState = ps.state; // 'printing', 'complete', 'cancelled', 'standby'
                const filename = ps.filename || 'Desconhecido.gcode';
                const filamentUsedMm = ps.filament_used || 0; // em milímetros
                const filamentUsedMeters = filamentUsedMm / 1000;
                // Densidade média PLA ~1.24 g/cm3, diâmetro 1.75mm -> gramas = pi * (r^2) * comprimento * densidade
                // r = 0.875 mm = 0.0875 cm
                // volume cm3 = pi * (0.0875^2) * (comprimento_m * 100)
                const radiusCm = 0.0875;
                const lengthCm = filamentUsedMeters * 100;
                const volumeCm3 = Math.PI * Math.pow(radiusCm, 2) * lengthCm;
                const activeSpool = data.spools.find(s => s.id === data.activeSpoolId) || data.spools[0];
                const density = activeSpool ? (activeSpool.densityGcm3 || 1.24) : 1.24;
                const filamentUsedGrams = volumeCm3 * density;

                // Debitar TODA impressão (completo, cancelado, falhou, standby, etc.)
                if (lastState.state === 'printing' && currentState !== 'printing') {
                    const deltaMm = Math.max(0, filamentUsedMm - (lastState.filamentUsed || 0));
                    const deltaMeters = deltaMm / 1000;
                    const deltaGrams = Math.PI * Math.pow(radiusCm, 2) * (deltaMeters * 100) * density;

                    if (deltaGrams > 0.5 && activeSpool) {
                        activeSpool.currentWeightGrams = Math.max(0, activeSpool.currentWeightGrams - deltaGrams);
                        
                        const netWeight = activeSpool.initialWeightGrams - activeSpool.emptySpoolWeightGrams;
                        const costPerGram = netWeight > 0 ? (activeSpool.cost / netWeight) : 0;
                        const cost = deltaGrams * costPerGram;

                        let statusLabel = 'Concluído';
                        if (currentState === 'cancelled') statusLabel = 'Cancelado';
                        else if (currentState === 'error' || currentState === 'standby') statusLabel = 'Interrompido/Falha';
                        else statusLabel = 'Parado (' + currentState + ')';

                        data.history.unshift({
                            id: Date.now().toString(),
                            spoolId: activeSpool.id,
                            printName: filename + ' (' + statusLabel + ')',
                            filamentUsedMeters: parseFloat(deltaMeters.toFixed(2)),
                            filamentUsedGrams: parseFloat(deltaGrams.toFixed(1)),
                            cost: parseFloat(cost.toFixed(2)),
                            timestamp: new Date().toISOString()
                        });
                        saveData(data);
                    }
                }                saveLastPrintState({
                    state: currentState,
                    filename: filename,
                    filamentUsed: filamentUsedMm,
                    timestamp: new Date().toISOString()
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...data,
                printerConnected: !err,
                printerStatus: printerStatus || null,
                printerError: err ? err.message : null
            }));
        });
        return;
    }

    // API: Adicionar Bobina
    if (pathname === '/api/spools' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const newSpoolData = JSON.parse(body);
                const data = loadData();
                const newSpool = {
                    id: Date.now().toString(),
                    name: newSpoolData.name || 'Nova Bobina',
                    material: newSpoolData.material || 'PLA',
                    color: newSpoolData.color || '#cccccc',
                    initialWeightGrams: parseFloat(newSpoolData.initialWeightGrams) || 1000,
                    emptySpoolWeightGrams: parseFloat(newSpoolData.emptySpoolWeightGrams) || 200,
                    currentWeightGrams: parseFloat(newSpoolData.currentWeightGrams) || 1000,
                    densityGcm3: parseFloat(newSpoolData.densityGcm3) || 1.24,
                    diameterMm: parseFloat(newSpoolData.diameterMm) || 1.75,
                    cost: parseFloat(newSpoolData.cost) || 0.0,
                    notes: newSpoolData.notes || '',
                    createdAt: new Date().toISOString()
                };
                data.spools.push(newSpool);
                saveData(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, spool: newSpool }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Definir Bobina Ativa
    if (pathname === '/api/active-spool' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { spoolId } = JSON.parse(body);
                const data = loadData();
                const spool = data.spools.find(s => s.id === spoolId);
                if (!spool) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Spool not found' }));
                    return;
                }
                data.activeSpoolId = spoolId;
                saveData(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, activeSpoolId: spoolId }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Consumir filamento (Registrar impressão ou ajuste)
    if (pathname === '/api/consume' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { grams, meters, printName } = JSON.parse(body);
                const data = loadData();
                const spool = data.spools.find(s => s.id === data.activeSpoolId);
                if (!spool) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Nenhuma bobina ativa selecionada' }));
                    return;
                }

                const consumedGrams = parseFloat(grams) || 0;
                const consumedMeters = parseFloat(meters) || 0;
                spool.currentWeightGrams = Math.max(0, spool.currentWeightGrams - consumedGrams);

                // Calcular custo proporcional
                const netWeight = spool.initialWeightGrams - spool.emptySpoolWeightGrams;
                const costPerGram = netWeight > 0 ? (spool.cost / netWeight) : 0;
                const cost = consumedGrams * costPerGram;

                const historyItem = {
                    id: Date.now().toString(),
                    spoolId: spool.id,
                    printName: printName || 'Consumo Manual / Impressão',
                    filamentUsedMeters: consumedMeters,
                    filamentUsedGrams: consumedGrams,
                    cost: parseFloat(cost.toFixed(2)),
                    timestamp: new Date().toISOString()
                };

                data.history.unshift(historyItem);
                saveData(data);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, spool, historyItem }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Deletar bobina
    if (pathname.startsWith('/api/spools/') && req.method === 'DELETE') {
        const spoolId = pathname.split('/')[3];
        const data = loadData();
        data.spools = data.spools.filter(s => s.id !== spoolId);
        if (data.activeSpoolId === spoolId) {
            data.activeSpoolId = data.spools.length > 0 ? data.spools[0].id : null;
        }
        saveData(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Frontend HTML - aplicação funcional completa (Dashboard, Bobinas, Histórico)
    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTMLContent());
        return;
    }

    // Serve arquivos estáticos CSS/JS se solicitados diretamente
    const staticPath = path.join(__dirname, pathname.slice(1));
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        const ext = path.extname(staticPath).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(fs.readFileSync(staticPath));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

function getHTMLContent() {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        return fs.readFileSync(indexPath, 'utf8');
    }
    return '<h1 style="color:white">index.html not found</h1>';
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Gerenciador de Filamento rodando em http://localhost:${PORT}`);
    console.log(`Conectado à impressora em: http://192.168.1.101:85`);
});
