import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {model} from './contract-fixture.mjs';
const target=new URL('../../backend/internal/videoplan/contract.json',import.meta.url).href;
registerHooks({load(url,context,next){if(url!==target)return next(url,context);const catalog=JSON.parse(readFileSync(fileURLToPath(url),'utf8'));if(catalog.models.some(m=>m.apiModelId===model.apiModelId))throw Error('test model collision');catalog.models.push(model);return {format:'json',source:JSON.stringify(catalog),shortCircuit:true}}});
