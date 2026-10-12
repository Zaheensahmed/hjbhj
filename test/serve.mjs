// test/serve.mjs -- a static server so test/run.html can load ES modules over
// http, since Chrome blocks module imports over file://. Not part of the
// extension and not needed to use it.
//
//   node test/serve.mjs
//   open http://localhost:8731/test/run.html
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel || "index.html");
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(buf);
  });
}).listen(8731, () => console.log("serving on http://localhost:8731"));
