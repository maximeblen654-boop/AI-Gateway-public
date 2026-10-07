import test from 'node:test';import assert from 'node:assert/strict';
import {CompilePlan} from '../../studio/api/video-request-builder.mjs';
test('ordinary entry rejects paused models and the isolated test product',()=>{
 for(const model of ['3.0-native','minimax-h3-1080p','phase5-local-reference-test'])assert.throws(()=>CompilePlan({ownerId:'1',model,prompt:'local',duration:5,resolution:'720p',ratio:'16:9',assets:[]}),/Unsupported or paused model/);
});
