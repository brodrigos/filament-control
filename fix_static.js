const fs = require('fs');
const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

const target = `    // Frontend HTML
    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTMLContent());
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});`;

const replacement = `    // Serve arquivos estáticos (index.html físico com Tailwind, etc.)
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
});`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed server.js to serve static index.html!');
} else {
    console.log('Target block not found.');
}
