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

                // Verificar transição de 'printing' para 'complete' ou 'cancelled'
                if (lastState.state === 'printing' && (currentState === 'complete' || currentState === 'cancelled')) {
                    if (filamentUsedGrams > 1 && activeSpool) {
                        activeSpool.currentWeightGrams = Math.max(0, activeSpool.currentWeightGrams - filamentUsedGrams);
                        
                        const netWeight = activeSpool.initialWeightGrams - activeSpool.emptySpoolWeightGrams;
                        const costPerGram = netWeight > 0 ? (activeSpool.cost / netWeight) : 0;
                        const cost = filamentUsedGrams * costPerGram;

                        data.history.unshift({
                            id: Date.now().toString(),
                            spoolId: activeSpool.id,
                            printName: `${filename} (${currentState === 'complete' ? 'Concluído' : 'Cancelado'})`,
                            filamentUsedMeters: parseFloat(filamentUsedMeters.toFixed(2)),
                            filamentUsedGrams: parseFloat(filamentUsedGrams.toFixed(1)),
                            cost: parseFloat(cost.toFixed(2)),
                            timestamp: new Date().toISOString()
                        });
                        saveData(data);
                    }
                }

                saveLastPrintState({
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

    // Serve arquivos estáticos (index.html físico com Tailwind, etc.)
    const staticPath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname.slice(1));
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
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gerenciador de Filamento 3D - Klipper (192.168.1.101:85)</title>
    <script src="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-900 text-gray-100 font-sans antialiased min-h-screen">
    <div class="flex h-screen overflow-hidden">
        <!-- Sidebar -->
        <div class="w-64 bg-gray-800 border-r border-gray-700 flex flex-col justify-between">
            <div>
                <div class="p-5 flex items-center space-x-3 border-b border-gray-700">
                    <i class="fa-solid fa-cube text-indigo-400 text-2xl"></i>
                    <span class="font-bold text-lg tracking-wide">Filament3D</span>
                </div>
                <nav class="p-4 space-y-2">
                    <a href="#" onclick="switchTab('dashboard')" id="nav-dashboard" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium transition"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a>
                    <a href="#" onclick="switchTab('spools')" id="nav-spools" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition"><i class="fa-solid fa-scroll w-5"></i><span>Bobinas</span></a>
                    <a href="#" onclick="switchTab('history')" id="nav-history" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition"><i class="fa-solid fa-history w-5"></i><span>Histórico</span></a>
                </nav>
            </div>
            <div class="p-4 border-t border-gray-700 text-xs text-gray-400">
                <div class="flex items-center space-x-2 mb-2">
                    <div id="printer-status-dot" class="w-3 h-3 rounded-full bg-red-500"></div>
                    <span id="printer-status-text" class="font-semibold">Conectando à Impressora...</span>
                </div>
                <p>IP: 192.168.1.101:85</p>
            </div>
        </div>

        <!-- Main Content -->
        <div class="flex-1 flex flex-col overflow-y-auto">
            <header class="bg-gray-800 border-b border-gray-700 h-16 flex items-center justify-between px-8">
                <h1 id="page-title" class="text-xl font-bold">Dashboard de Consumo</h1>
                <div class="flex items-center space-x-4">
                    <button onclick="refreshData()" class="bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg text-sm flex items-center space-x-2 transition">
                        <i class="fa-solid fa-sync"></i><span>Atualizar</span>
                    </button>
                    <button onclick="openAddSpoolModal()" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg text-sm font-semibold flex items-center space-x-2 transition shadow">
                        <i class="fa-solid fa-plus"></i><span>Nova Bobina</span>
                    </button>
                </div>
            </header>

            <main class="p-8 space-y-6">
                <!-- TAB: DASHBOARD -->
                <div id="tab-dashboard" class="space-y-6">
                    <!-- Printer Live State Card -->
                    <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 shadow-lg grid grid-cols-1 md:grid-cols-4 gap-6">
                        <div class="flex items-center space-x-4">
                            <div class="p-4 bg-indigo-900 bg-opacity-50 text-indigo-400 rounded-xl text-2xl">
                                <i class="fa-solid fa-print"></i>
                            </div>
                            <div>
                                <p class="text-xs text-gray-400 uppercase font-semibold">Estado da Impressora</p>
                                <p id="lbl-printer-state" class="text-lg font-bold capitalize">-</p>
                            </div>
                        </div>
                        <div class="flex items-center space-x-4">
                            <div class="p-4 bg-blue-900 bg-opacity-50 text-blue-400 rounded-xl text-2xl">
                                <i class="fa-solid fa-file-lines"></i>
                            </div>
                            <div>
                                <p class="text-xs text-gray-400 uppercase font-semibold">Arquivo Atual</p>
                                <p id="lbl-print-file" class="text-sm font-bold truncate max-w-xs" title="-">-</p>
                            </div>
                        </div>
                        <div class="flex items-center space-x-4">
                            <div class="p-4 bg-green-900 bg-opacity-50 text-green-400 rounded-xl text-2xl">
                                <i class="fa-solid fa-ruler"></i>
                            </div>
                            <div>
                                <p class="text-xs text-gray-400 uppercase font-semibold">Filamento Usado (Job)</p>
                                <p id="lbl-filament-used" class="text-lg font-bold">0.00 m</p>
                            </div>
                        </div>
                        <div class="flex items-center space-x-4">
                            <div class="p-4 bg-purple-900 bg-opacity-50 text-purple-400 rounded-xl text-2xl">
                                <i class="fa-solid fa-chart-line"></i>
                            </div>
                            <div>
                                <p class="text-xs text-gray-400 uppercase font-semibold">Progresso</p>
                                <p id="lbl-print-progress" class="text-lg font-bold">0%</p>
                            </div>
                        </div>
                    </div>

                    <!-- Active Spool & Quick Stats -->
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <!-- Active Spool Card -->
                        <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 shadow-lg flex flex-col justify-between">
                            <div>
                                <div class="flex justify-between items-center mb-4">
                                    <h2 class="text-lg font-bold flex items-center space-x-2">
                                        <i class="fa-solid fa-circle-dot text-indigo-400"></i>
                                        <span>Bobina Ativa</span>
                                    </h2>
                                    <span id="active-spool-material" class="px-2.5 py-1 bg-indigo-900 text-indigo-300 text-xs font-bold rounded-full">PLA</span>
                                </div>
                                <div id="active-spool-details" class="space-y-3">
                                    <p class="text-xl font-bold text-white" id="active-spool-name">Nenhuma bobina selecionada</p>
                                    <div class="relative w-full bg-gray-700 rounded-full h-4 overflow-hidden">
                                        <div id="active-spool-bar" class="bg-indigo-500 h-full rounded-full transition-all duration-500" style="width: 0%"></div>
                                    </div>
                                    <div class="flex justify-between text-sm text-gray-400">
                                        <span>Restante: <strong id="active-spool-weight" class="text-white">0g</strong></span>
                                        <span>Total: <strong id="active-spool-total" class="text-white">1000g</strong></span>
                                    </div>
                                </div>
                            </div>
                            <div class="mt-6 pt-4 border-t border-gray-700 flex space-x-3">
                                <button onclick="openSimulateModal()" class="flex-1 bg-gray-700 hover:bg-gray-600 py-2 rounded-lg text-sm font-semibold transition">
                                    <i class="fa-solid fa-calculator mr-2"></i>Simular Consumo
                                </button>
                                <button onclick="switchTab('spools')" class="flex-1 bg-indigo-600 hover:bg-indigo-500 py-2 rounded-lg text-sm font-semibold transition">
                                    Trocar Bobina
                                </button>
                            </div>
                        </div>

                        <!-- Financial / Cost Summary -->
                        <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 shadow-lg col-span-2 flex flex-col justify-between">
                            <h2 class="text-lg font-bold mb-4 flex items-center space-x-2">
                                <i class="fa-solid fa-wallet text-green-400"></i>
                               <span>Resumo Financeiro e Consumo</span>
                            </h2>
                            <div class="grid grid-cols-3 gap-4 mb-4">
                                <div class="bg-gray-700 bg-opacity-40 p-4 rounded-xl border border-gray-600">
                                    <p class="text-xs text-gray-400 uppercase">Total Gasto (USD)</p>
                                    <p id="stat-total-cost" class="text-2xl font-bold text-green-400 mt-1">$ 0.00</p>
                                </div>
                                <div class="bg-gray-700 bg-opacity-40 p-4 rounded-xl border border-gray-600">
                                    <p class="text-xs text-gray-400 uppercase">Filamento Consumido</p>
                                    <p id="stat-total-grams" class="text-2xl font-bold text-blue-400 mt-1">0 g</p>
                                </div>
                                <div class="bg-gray-700 bg-opacity-40 p-4 rounded-xl border border-gray-600">
                                    <p class="text-xs text-gray-400 uppercase">Impressões Registradas</p>
                                    <p id="stat-total-prints" class="text-2xl font-bold text-purple-400 mt-1">0</p>
                                </div>
                            </div>
                            <div class="text-xs text-gray-400 flex items-center justify-between">
                                <span>* Cálculo baseado no peso líquido e custo cadastrado de cada bobina.</span>
                                <span class="text-indigo-400 font-semibold cursor-pointer" onclick="switchTab('history')">Ver histórico completo &rarr;</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB: SPOOLS -->
                <div id="tab-spools" class="space-y-6 hidden">
                    <div class="flex justify-between items-center">
                        <h2 class="text-xl font-bold">Gerenciamento de Bobinas</h2>
                        <button onclick="openAddSpoolModal()" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg text-sm font-semibold transition">
                            <i class="fa-solid fa-plus mr-2"></i>Adicionar Bobina
                        </button>
                    </div>
                    <div id="spools-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <!-- Spool cards injected dynamically -->
                    </div>
                </div>

                <!-- TAB: HISTORY -->
                <div id="tab-history" class="space-y-6 hidden">
                    <h2 class="text-xl font-bold">Histórico de Consumo e Impressões</h2>
                    <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden shadow-lg">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-gray-700 text-gray-300 text-xs uppercase tracking-wider border-b border-gray-600">
                                    <th class="p-4">Data / Hora</th>
                                    <th class="p-4">Impressão / Arquivo</th>
                                    <th class="p-4">Bobina</th>
                                    <th class="p-4">Consumido (g)</th>
                                    <th class="p-4">Comprimento (m)</th>
                                    <th class="p-4">Custo Estimado</th>
                                </tr>
                            </thead>
                            <tbody id="history-table-body" class="divide-y divide-gray-700 text-sm">
                                <!-- History rows injected dynamically -->
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </div>
    </div>

    <!-- MODAL: ADD SPOOL -->
    <div id="modal-add-spool" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center hidden z-50">
        <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
            <div class="flex justify-between items-center mb-4 border-b border-gray-700 pb-3">
                <h3 class="text-lg font-bold">Cadastrar Nova Bobina</h3>
                <button onclick="closeAddSpoolModal()" class="text-gray-400 hover:text-white"><i class="fa-solid fa-xmark text-lg"></i></button>
            </div>
            <form id="form-add-spool" onsubmit="submitAddSpool(event)" class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Nome da Bobina</label>
                    <input type="text" id="spool-name" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500" placeholder="Ex: PLA Azul Star">
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Material</label>
                        <select id="spool-material" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500">
                            <option value="PLA">PLA</option>
                            <option value="PETG">PETG</option>
                            <option value="ABS">ABS</option>
                            <option value="TPU">TPU</option>
                            <option value="ASA">ASA</option>
                            <option value="Outro">Outro</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Cor</label>
                        <div class="flex space-x-2">
                            <input type="color" id="spool-color" value="#3b82f6" class="w-12 h-10 bg-gray-900 border border-gray-700 rounded-lg cursor-pointer">
                            <input type="text" id="spool-color-hex" value="#3b82f6" class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm">
                        </div>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Peso Bruto (g)</label>
                        <input type="number" id="spool-initial" value="1000" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Peso Carretel (g)</label>
                        <input type="number" id="spool-empty" value="200" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Preço ($ USD)</label>
                        <input type="number" step="0.01" id="spool-cost" value="19.99" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500">
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Observações / Marca</label>
                    <input type="text" id="spool-notes" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500" placeholder="Ex: Voolt3D / Lote 42">
                </div>
                <div class="flex justify-end space-x-3 pt-4 border-t border-gray-700">
                    <button type="button" onclick="closeAddSpoolModal()" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm font-semibold">Cancelar</button>
                    <button type="submit" class="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold">Salvar Bobina</button>
                </div>
            </form>
        </div>
    </div>

    <!-- MODAL: SIMULATE CONSUMPTION -->
    <div id="modal-simulate" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center hidden z-50">
        <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div class="flex justify-between items-center mb-4 border-b border-gray-700 pb-3">
                <h3 class="text-lg font-bold">Simular / Registrar Consumo</h3>
                <button onclick="closeSimulateModal()" class="text-gray-400 hover:text-white"><i class="fa-solid fa-xmark text-lg"></i></button>
            </div>
            <form onsubmit="submitConsume(event)" class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Nome da Impressão / Peça</label>
                    <input type="text" id="sim-print-name" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500" placeholder="Ex: Peça V2 Caixa.gcode">
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Gramas Usadas (g)</label>
                        <input type="number" step="0.1" id="sim-grams" required class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500" placeholder="Ex: 45.2">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Comprimento (m)</label>
                        <input type="number" step="0.1" id="sim-meters" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500" placeholder="Ex: 15.0">
                    </div>
                </div>
                <div class="flex justify-end space-x-3 pt-4 border-t border-gray-700">
                    <button type="button" onclick="closeSimulateModal()" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm font-semibold">Cancelar</button>
                    <button type="submit" class="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold">Registrar Consumo</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        let appData = null;

        function switchTab(tabId) {
            ['dashboard', 'spools', 'history'].forEach(id => {
                document.getElementById('tab-' + id).classList.add('hidden');
                document.getElementById('nav-' + id).classList.remove('bg-indigo-600', 'text-white');
                document.getElementById('nav-' + id).classList.add('text-gray-300', 'hover:bg-gray-700');
            });
            document.getElementById('tab-' + tabId).classList.remove('hidden');
            document.getElementById('nav-' + tabId).classList.add('bg-indigo-600', 'text-white');
            document.getElementById('nav-' + tabId).classList.remove('text-gray-300', 'hover:bg-gray-700');

            const titles = { dashboard: 'Dashboard de Consumo', spools: 'Gerenciamento de Bobinas', history: 'Histórico de Consumo' };
            document.getElementById('page-title').innerText = titles[tabId];
        }

        function refreshData() {
            fetch('/api/state')
                .then(res => res.json())
                .then(data => {
                    appData = data;
                    renderUI();
                })
                .catch(err => console.error('Erro ao buscar dados:', err));
        }

        function renderUI() {
            if (!appData) return;

            // Status impressora
            const dot = document.getElementById('printer-status-dot');
            const statusText = document.getElementById('printer-status-text');
            if (appData.printerConnected) {
                dot.className = 'w-3 h-3 rounded-full bg-green-500 animate-pulse';
                statusText.innerText = 'Conectado (Moonraker)';
                
                if (appData.printerStatus) {
                    const ps = appData.printerStatus.print_stats;
                    const vs = appData.printerStatus.virtual_sdcard;
                    document.getElementById('lbl-printer-state').innerText = ps.state || '-';
                    document.getElementById('lbl-print-file').innerText = ps.filename || 'Nenhum arquivo';
                    document.getElementById('lbl-print-file').title = ps.filename || '';
                    document.getElementById('lbl-filament-used').innerText = (ps.filament_used ? (ps.filament_used / 1000).toFixed(2) : '0.00') + ' m';
                    document.getElementById('lbl-print-progress').innerText = (vs && vs.progress ? (vs.progress * 100).toFixed(1) : '0') + '%';
                }
            } else {
                dot.className = 'w-3 h-3 rounded-full bg-red-500';
                statusText.innerText = 'Impressora Desconectada';
                document.getElementById('lbl-printer-state').innerText = 'Offline';
            }

            // Bobina Ativa
            const activeSpool = appData.spools.find(s => s.id === appData.activeSpoolId) || appData.spools[0];
            if (activeSpool) {
                document.getElementById('active-spool-name').innerText = activeSpool.name;
                document.getElementById('active-spool-material').innerText = activeSpool.material;
                const netInitial = activeSpool.initialWeightGrams - activeSpool.emptySpoolWeightGrams;
                const netCurrent = Math.max(0, activeSpool.currentWeightGrams - activeSpool.emptySpoolWeightGrams);
                const pct = netInitial > 0 ? Math.min(100, Math.max(0, (netCurrent / netInitial) * 100)) : 0;
                document.getElementById('active-spool-bar').style.width = pct + '%';
                document.getElementById('active-spool-weight').innerText = netCurrent.toFixed(0) + 'g';
                document.getElementById('active-spool-total').innerText = netInitial.toFixed(0) + 'g';
            } else {
                document.getElementById('active-spool-name').innerText = 'Nenhuma bobina cadastrada';
            }

            // Stats
            let totalCost = 0;
            let totalGrams = 0;
            appData.history.forEach(h => {
                totalCost += h.cost || 0;
                totalGrams += h.filamentUsedGrams || 0;
            });
            document.getElementById('stat-total-cost').innerText = '$ ' + totalCost.toFixed(2);
            document.getElementById('stat-total-grams').innerText = totalGrams.toFixed(1) + ' g';
            document.getElementById('stat-total-prints').innerText = appData.history.length;

            // Render Spools Grid
            const spoolsGrid = document.getElementById('spools-grid');
            spoolsGrid.innerHTML = '';
            appData.spools.forEach(spool => {
                const isActive = spool.id === appData.activeSpoolId;
                const netInitial = spool.initialWeightGrams - spool.emptySpoolWeightGrams;
                const netCurrent = Math.max(0, spool.currentWeightGrams - spool.emptySpoolWeightGrams);
                const pct = netInitial > 0 ? Math.min(100, Math.max(0, (netCurrent / netInitial) * 100)) : 0;

                const card = document.createElement('div');
                card.className = \`bg-gray-800 border \${isActive ? 'border-indigo-500 ring-2 ring-indigo-500 ring-opacity-50' : 'border-gray-700'} rounded-xl p-6 shadow-lg flex flex-col justify-between space-y-4\`;
                card.innerHTML = \`
                    <div>
                        <div class="flex justify-between items-start mb-2">
                            <div class="flex items-center space-x-2">
                                <span class="w-4 h-4 rounded-full border border-gray-600 inline-block" style="background-color: \${spool.color || '#3b82f6'}"></span>
                                <h3 class="font-bold text-lg text-white">\${spool.name}</h3>
                            </div>
                            <span class="px-2.5 py-0.5 bg-indigo-900 text-indigo-300 text-xs font-bold rounded-full">\${spool.material}</span>
                        </div>
                        <p class="text-xs text-gray-400 mb-4">\${spool.notes || 'Sem observações'}</p>
                        <div class="space-y-1 mb-4">
                            <div class="flex justify-between text-sm">
                                <span class="text-gray-400">Restante:</span>
                                <strong class="text-white">\${netCurrent.toFixed(0)}g / \${netInitial.toFixed(0)}g</strong>
                            </div>
                            <div class="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                                <div class="bg-indigo-500 h-full rounded-full" style="width: \${pct}%"></div>
                            </div>
                        </div>
                        <div class="text-xs text-gray-400 flex justify-between">
                            <span>Preço: $\${spool.cost.toFixed(2)}</span>
                            <span>Diâmetro: \${spool.diameterMm}mm</span>
                        </div>
                    </div>
                    <div class="flex space-x-2 pt-3 border-t border-gray-700">
                        \${!isActive ? \`<button onclick="setActiveSpool('\${spool.id}')" class="flex-1 bg-indigo-600 hover:bg-indigo-500 py-1.5 rounded-lg text-xs font-semibold transition">Ativar</button>\` : \`<span class="flex-1 text-center py-1.5 text-xs font-bold text-indigo-400 bg-indigo-950 rounded-lg">Bobina Ativa</span>\`}
                        <button onclick="deleteSpool('\${spool.id}')" class="px-3 bg-red-900 hover:bg-red-800 text-red-200 py-1.5 rounded-lg text-xs font-semibold transition"><i class="fa-solid fa-trash"></i></button>
                    </div>
                \`;
                spoolsGrid.appendChild(card);
            });

            // Render History Table
            const historyBody = document.getElementById('history-table-body');
            historyBody.innerHTML = '';
            if (appData.history.length === 0) {
                historyBody.innerHTML = \`<tr><td colspan="6" class="p-6 text-center text-gray-500">Nenhum registro de consumo no histórico.</td></tr>\`;
            } else {
                appData.history.forEach(h => {
                    const spool = appData.spools.find(s => s.id === h.spoolId);
                    const row = document.createElement('tr');
                    row.className = 'hover:bg-gray-700 hover:bg-opacity-30 transition';
                    row.innerHTML = \`
                        <td class="p-4 text-gray-300 text-xs">\${new Date(h.timestamp).toLocaleString('pt-BR')}</td>
                        <td class="p-4 font-semibold text-white">\${h.printName}</td>
                        <td class="p-4 text-gray-300">\${spool ? spool.name : 'Bobina Removida'}</td>
                        <td class="p-4 text-blue-400 font-bold">+\${h.filamentUsedGrams} g</td>
                        <td class="p-4 text-gray-300">\${h.filamentUsedMeters} m</td>
                        <td class="p-4 text-green-400 font-bold">$\${(h.cost || 0).toFixed(2)}</td>
                    \`;
                    historyBody.appendChild(row);
                });
            }
        }

        // Modals
        function openAddSpoolModal() { document.getElementById('modal-add-spool').classList.remove('hidden'); }
        function closeAddSpoolModal() { document.getElementById('modal-add-spool').classList.add('hidden'); }
        function openSimulateModal() { document.getElementById('modal-simulate').classList.remove('hidden'); }
        function closeSimulateModal() { document.getElementById('modal-simulate').classList.add('hidden'); }

        // Color sync
        document.getElementById('spool-color').addEventListener('input', (e) => {
            document.getElementById('spool-color-hex').value = e.target.value;
        });

        function submitAddSpool(event) {
            event.preventDefault();
            const payload = {
                name: document.getElementById('spool-name').value,
                material: document.getElementById('spool-material').value,
                color: document.getElementById('spool-color').value,
                initialWeightGrams: parseFloat(document.getElementById('spool-initial').value),
                emptySpoolWeightGrams: parseFloat(document.getElementById('spool-empty').value),
                currentWeightGrams: parseFloat(document.getElementById('spool-initial').value),
                cost: parseFloat(document.getElementById('spool-cost').value),
                notes: document.getElementById('spool-notes').value
            };

            fetch('/api/spools', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    closeAddSpoolModal();
                    document.getElementById('form-add-spool').reset();
                    refreshData();
                } else {
                    alert('Erro ao salvar bobina: ' + data.error);
                }
            });
        }

        function setActiveSpool(spoolId) {
            fetch('/api/active-spool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ spoolId })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) refreshData();
            });
        }

        function deleteSpool(spoolId) {
            if (!confirm('Deseja realmente excluir esta bobina?')) return;
            fetch('/api/spools/' + spoolId, { method: 'DELETE' })
                .then(res => res.json())
                .then(data => {
                    if (data.success) refreshData();
                });
        }

        function submitConsume(event) {
            event.preventDefault();
            const payload = {
                printName: document.getElementById('sim-print-name').value,
                grams: parseFloat(document.getElementById('sim-grams').value),
                meters: parseFloat(document.getElementById('sim-meters').value) || 0
            };

            fetch('/api/consume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    closeSimulateModal();
                    refreshData();
                } else {
                    alert('Erro: ' + data.error);
                }
            });
        }

        // Auto refresh
        setInterval(refreshData, 5000);
        refreshData();
    </script>
</body>
</html>
`;
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Gerenciador de Filamento rodando em http://localhost:${PORT}`);
    console.log(`Conectado à impressora em: http://192.168.1.101:85`);
});
