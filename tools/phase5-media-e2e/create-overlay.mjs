import fs from 'node:fs';
import {model} from './contract-fixture.mjs';
const catalog=JSON.parse(fs.readFileSync('backend/internal/videoplan/contract.json','utf8'));catalog.models.push(model);
const source=fs.readFileSync('backend/internal/videoplan/plan.go','utf8').replace('//go:embed contract.json\nvar contract []byte','var contract = []byte('+JSON.stringify(JSON.stringify(catalog))+')').replace('//go:embed contract.json\r\nvar contract []byte','var contract = []byte('+JSON.stringify(JSON.stringify(catalog))+')');
if(source.includes('//go:embed contract.json'))throw Error('overlay failed');
fs.mkdirSync('.evidence',{recursive:true});fs.writeFileSync('.evidence/overlay-plan.go',source);
fs.writeFileSync('.evidence/overlay.json',JSON.stringify({Replace:{'/app/backend/internal/videoplan/plan.go':'/tmp/phase5-plan.go'}}));
let docker=fs.readFileSync('Dockerfile','utf8').replace(/^# syntax=.*\r?\n/,'').replace('main.BuildType=release','main.BuildType=phase5-local-e2e');docker=docker.replace('# Build the binary (BuildType=release for CI builds, embed frontend)','COPY .evidence/overlay-plan.go /tmp/phase5-plan.go\nCOPY .evidence/overlay.json /tmp/phase5-overlay.json\n# Explicit isolated E2E build only').replace('-tags embed \\','-overlay /tmp/phase5-overlay.json -tags embed \\');fs.writeFileSync('.evidence/Dockerfile.e2e',docker);
console.log('Explicit test build overlay ready; production contract unchanged');
