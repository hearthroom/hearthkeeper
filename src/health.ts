import { createServer } from 'node:http';
import type { createRuntime } from './runtime.js';

export function createHealthServer(runtime: ReturnType<typeof createRuntime>) {
  return createServer(async (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET') {res.writeHead(405);res.end();return;}
    try {
      if(req.url==='/metrics') {
        res.setHeader('Content-Type',runtime.contentType);res.end(await runtime.metrics());return;
      }
      const result=runtime.health(req.url ?? '/');
      res.writeHead(result.status,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result.body));
    } catch {res.writeHead(500);res.end();}
  });
}
