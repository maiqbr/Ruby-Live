const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const exported = {};
const source = fs.readFileSync(path.join(__dirname, '../src/media.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exported });
const { cameraConstraints, exactCameraVideoConstraints, prepareScreenTrack, syncOutgoingTracks } = exported;
const constraints = cameraConstraints('device-2');
assert.equal(constraints.audio, false);
assert.equal(constraints.video.deviceId.exact, 'device-2');
assert.equal(constraints.video.width.max, 640);
assert.equal(constraints.video.height.max, 360);
assert.equal(constraints.video.frameRate.max, 15);
assert.equal(cameraConstraints('').video.deviceId, undefined);
for (const [quality, width] of [[360, 640], [480, 640], [720, 1280], [1080, 1920]]) {
  for (const fps of [15, 30, 60]) {
    const requested = cameraConstraints('device-2', quality, fps);
    assert.equal(requested.audio, false, 'quality changes never request microphone');
    assert.equal(requested.video.width.max, width);
    assert.equal(requested.video.height.max, quality);
    assert.equal(requested.video.frameRate.max, fps);
    const live = exported.cameraVideoConstraints(quality, fps);
    assert.equal(live.deviceId, undefined, 'live adjustments keep the same device');
    assert.equal(live.frameRate.max, fps);
    assert.equal(live.height.max, quality);
    const exact = exactCameraVideoConstraints(quality, fps);
    assert.equal(exact.width.exact, width, 'live quality changes request the selected resolution');
    assert.equal(exact.height.exact, quality, 'live quality changes request the selected resolution');
  }
}
function connection() {
  const senders = [];
  return { getSenders: () => senders, addTrack(track) { const sender = { track, parameters: { encodings: [{}] }, getParameters() { return this.parameters; }, setParameters(value) { this.parameters = value; return Promise.resolve(); } }; senders.push(sender); return sender; }, removeTrack(sender) { sender.track = null; } };
}
const screen = connection();
const camera = connection();
const stream = ids => ({ getTracks: () => ids.map(id => ({ id, readyState: 'live' })) });
syncOutgoingTracks(screen, stream(['screen-video', 'system-audio']), true);
syncOutgoingTracks(camera, stream(['camera-video']), false);
assert.equal(camera.getSenders().length, 0, 'no camera sent without subscription');
for (let i = 0; i < 10; i++) syncOutgoingTracks(camera, stream(['camera-video']), true);
assert.equal(camera.getSenders().length, 1, 'idempotent subscription creates no duplicate track');
syncOutgoingTracks(camera, stream(['other-device']), true);
assert.equal(camera.getSenders().filter(s => s.track).length, 1, 'device switch removes old track');
assert.equal(camera.getSenders().find(s => s.track).track.id, 'other-device');
syncOutgoingTracks(camera, null, false);
assert.equal(camera.getSenders().filter(s => s.track).length, 0);
assert.equal(screen.getSenders().filter(s => s.track).length, 2, 'stopping camera preserves screen and system audio');
const detailed = { id: 'detailed-screen', kind: 'video', readyState: 'live', contentHint: '' };
prepareScreenTrack(detailed);
assert.equal(detailed.contentHint, 'detail');
const preferred = connection();
syncOutgoingTracks(preferred, { getTracks: () => [detailed] }, true);
assert.equal(preferred.getSenders()[0].parameters.degradationPreference, 'maintain-resolution');
assert.equal(preferred.getSenders()[0].parameters.encodings[0].priority, 'high');
console.log('PASS: camera no microphone, 360p/15fps, device selection, opt-in, idempotency, independent tracks');
