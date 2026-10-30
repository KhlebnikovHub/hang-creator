'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../core.js');

function harness(gated = false) {
  const timers = new Map();
  const contexts = [];
  let now = 0, nextTimer = 0;
  const clock = {
    setTimeout(action, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, action }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.action();
      }
      now = target;
    },
    jump(milliseconds) { now += milliseconds; },
    get size() { return timers.size; }
  };
  class Context {
    constructor() {
      this.state = 'suspended'; this.origin = now; this.frozenTime = 0;
      this.starts = []; this.oscillators = []; this.destination = {};
      contexts.push(this);
    }
    get currentTime() { return this.state === 'running' ? (now - this.origin) / 1000 : this.frozenTime; }
    resume() {
      return new Promise((resolve, reject) => {
        this.release = () => { if (this.state !== 'closed') { this.origin = now; this.state = 'running'; } resolve(); };
        this.rejectResume = reject;
        if (!gated) this.release();
      });
    }
    close() {
      this.frozenTime = this.currentTime; this.state = 'closed';
      for (const oscillator of this.oscillators) if (oscillator.endTimer) clock.clearTimeout(oscillator.endTimer);
      return Promise.resolve();
    }
    createOscillator() {
      const context = this;
      const oscillator = {
        frequency: { value: 0, setValueAtTime(value) { this.value = value; } },
        connect() {}, disconnect() {}, onended: null,
        start(time) { context.starts.push({ time, frequency: this.frequency.value, type: this.type }); },
        stop(time = context.currentTime) {
          if (this.endTimer) clock.clearTimeout(this.endTimer);
          if (time <= context.currentTime) { if (this.onended) this.onended(); }
          else this.endTimer = clock.setTimeout(() => { if (this.onended) this.onended(); }, (time - context.currentTime) * 1000);
        }
      };
      this.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const window = { HangCore: Core, AudioContext: Context };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../playback.js'), 'utf8'), {
    window, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock)
  });
  const states = [], positions = [], progress = [], errors = [];
  const player = window.HangPlayback.create({
    onState: value => states.push(value), onPosition: value => positions.push(value),
    onProgress: value => progress.push(value), onError: value => errors.push(value)
  });
  return { player, clock, contexts, states, positions, progress, errors };
}

test('stop before resume cancels the pending session and never announces playback', async () => {
  const env = harness(true);
  const pending = env.player.play(Core.createTab());
  assert.equal(env.player.starting, true);
  assert.equal(env.player.playing, false);
  env.player.stop();
  env.contexts[0].release();
  await pending;
  assert.equal(env.player.starting, false);
  assert.equal(env.player.playing, false);
  assert.equal(env.states.includes(true), false);
  assert.equal(env.contexts[0].state, 'closed');
  assert.equal(env.contexts[0].starts.length, 0);
  assert.equal(env.clock.size, 0);
  assert.deepEqual(env.errors, []);
});

test('a superseding play owns its context and ignores late resume rejection from the old session', async () => {
  const env = harness(true);
  const tab = Core.createTab();
  tab.measures[0].rows.main[0] = ['D'];
  const first = env.player.play(tab);
  const second = env.player.play(tab, { measure: 0 });
  assert.equal(env.contexts.length, 2);
  assert.equal(env.contexts[0].state, 'closed');
  // The input is snapshotted before awaiting resume.
  tab.measures[0].rows.main[0] = ['S'];
  env.contexts[1].release();
  await second;
  assert.equal(env.player.playing, true);
  assert.equal(env.player.starting, false);
  assert.equal(env.contexts[1].starts[0].frequency, 146.83);
  env.contexts[0].rejectResume(new Error('Stale permission rejection'));
  await first;
  assert.equal(env.player.playing, true);
  assert.equal(env.contexts[0].starts.length, 0);
  assert.deepEqual(env.errors, []);
  env.player.stop();
  assert.equal(env.clock.size, 0);
});

test('selected-measure playback uses its own grid, both hands, quarter BPM and original measure index', async () => {
  const env = harness();
  const original = Core.createTab({ hands: 'split' });
  original.tempo = 120;
  const beats = Core.clone(original.beats); beats[0].division = 2;
  const tab = Core.setMeasureRhythm(original, 1, beats).tab;
  tab.measures[0].rows.R[0] = ['S'];
  tab.measures[1].rows.R[1] = ['D', '4'];
  tab.measures[1].rows.L[1] = ['6'];
  await env.player.play(tab, { measure: 1 });
  env.clock.advance(500);
  const starts = env.contexts[0].starts;
  assert.equal(starts.length, 3);
  starts.forEach(start => assert.ok(Math.abs(start.time - 0.37) < 1e-9));
  assert.equal(starts.some(start => start.frequency === 900), false);
  assert.ok(env.positions.some(position => position && position.measure === 1 && position.slot === 1));
  assert.ok(env.positions.filter(Boolean).every(position => position.measure === 1));
  env.clock.advance(1800);
  assert.equal(env.player.playing, false);
  assert.equal(env.contexts[0].state, 'closed');
  assert.equal(env.positions.at(-1), null);
  assert.equal(env.progress.at(-1), 0);
  assert.equal(env.clock.size, 0);
});

test('all-measure playback keeps absolute bar offsets when measures have different slot counts', async () => {
  const env = harness();
  const original = Core.createTab(); original.tempo = 120; original.measures = original.measures.slice(0, 2);
  const beats = Core.clone(original.beats); beats[0].division = 2;
  const tab = Core.setMeasureRhythm(original, 1, beats).tab;
  tab.measures[0].rows.main[0] = ['D'];
  tab.measures[1].rows.main[1] = ['S'];
  await env.player.play(tab, { measure: null });
  env.clock.advance(2500);
  assert.equal(env.contexts[0].starts.length, 2);
  assert.ok(Math.abs(env.contexts[0].starts[0].time - 0.12) < 1e-9);
  assert.ok(Math.abs(env.contexts[0].starts[1].time - 2.37) < 1e-9);
  assert.ok(env.positions.some(position => position && position.measure === 1 && position.slot === 1));
  env.player.stop();
});

test('metronome clicks on rest beats and accents the first compound beat without clicking subdivisions', async () => {
  const env = harness();
  const tab = Core.createTab({ meter: { numerator: 12, denominator: 8 } }); tab.tempo = 120;
  await env.player.play(tab, { measure: 0, metronome: true });
  env.clock.advance(2900);
  const starts = env.contexts[0].starts;
  assert.deepEqual(starts.map(start => start.frequency), [2400, 1600, 1600, 1600]);
  assert.deepEqual(starts.map(start => Number(start.time.toFixed(2))), [0.12, 0.87, 1.62, 2.37]);
  assert.ok(starts.every(start => start.type === 'square'));
  env.player.stop();
});

test('loop repeats a fixed event list, bounds timers, and skips missed cycles after a time jump', async () => {
  const env = harness();
  const tab = Core.createTab(); tab.tempo = 120; tab.measures[0].rows.main[0] = ['D'];
  await env.player.play(tab, { measure: 0, loop: true });
  env.clock.advance(5000);
  const context = env.contexts[0];
  assert.deepEqual(context.starts.map(start => Number(start.time.toFixed(2))), [0.12, 2.12, 4.12]);
  assert.equal(env.player.playing, true);
  assert.ok(env.clock.size <= 8);
  const countBeforeJump = context.starts.length;
  env.clock.jump(100000);
  env.clock.advance(0);
  assert.ok(context.starts.length - countBeforeJump <= 1, 'Missed cycles must not generate a burst of notes.');
  assert.ok(env.clock.size <= 8);
  env.clock.advance(1300);
  assert.ok(context.starts.length > countBeforeJump, 'The current loop must continue after the jump.');
  assert.ok(env.progress.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  env.player.stop();
  assert.equal(env.clock.size, 0);
  assert.equal(context.state, 'closed');
  assert.deepEqual(env.errors, []);
});

test('a subdivided offbeat plays sixteenths at their true times and keeps the metronome and loop duration', async () => {
  const env = harness();
  const original = Core.createTab({ division: 2, hands: 'split' });
  original.tempo = 120;
  const tab = Core.splitSlot(original, 0, 3).tab;
  tab.measures[0].rows.R[3] = ['D'];
  tab.measures[0].rows.L[4] = ['S'];
  await env.player.play(tab, { measure: 0, metronome: true, loop: true });
  env.clock.advance(3200);
  const starts = env.contexts[0].starts;
  assert.deepEqual(starts.filter(s => s.frequency === 146.83).map(s => Number(s.time.toFixed(3))), [.87, 2.87]);
  assert.deepEqual(starts.filter(s => s.frequency === 900).map(s => Number(s.time.toFixed(3))), [.995, 2.995]);
  assert.deepEqual(starts.filter(s => s.frequency === 2400).map(s => Number(s.time.toFixed(3))), [.12, 2.12]);
  assert.deepEqual(starts.filter(s => s.frequency === 1600).slice(0, 3).map(s => Number(s.time.toFixed(3))), [.62, 1.12, 1.62]);
  assert.deepEqual(env.errors, []);
  env.player.stop();
  assert.equal(env.clock.size, 0);
});

test('mixed single and two-hand cells all play once at their own times, including local subdivisions', async () => {
  const env = harness();
  const original = Core.createTab({ division: 2 });
  original.tempo = 120;
  original.measures[0].rows.main[0] = ['K'];
  original.measures[0].rows.main[2] = ['S'];
  let tab = Core.setCellHands(original, 0, 1, 'split');
  tab.measures[0].rows.R[1] = ['D'];
  tab.measures[0].rows.L[1] = ['D']; // Simultaneous identical pitches remain two attacks.
  tab = Core.splitSlot(tab, 0, 1).tab;
  tab.measures[0].rows.L[2] = ['K'];
  await env.player.play(tab, { measure: 0 });
  env.clock.advance(2300);
  const starts = env.contexts[0].starts;
  assert.deepEqual(starts.map(s => Number(s.time.toFixed(3))), [.12, .37, .37, .495, .62]);
  assert.deepEqual(starts.map(s => s.frequency), [600, 146.83, 146.83, 600, 900]);
  assert.equal(env.player.playing, false);
  assert.deepEqual(env.errors, []);
});

test('a local single cell in a two-hand document plays its main chord alongside surrounding hands', async () => {
  const env = harness();
  const original = Core.createTab({ hands: 'split' });
  original.tempo = 120;
  original.measures[0].rows.R[0] = ['D'];
  original.measures[0].rows.L[1] = ['S'];
  const tab = Core.setCellHands(original, 0, 1, 'single');
  tab.measures[0].rows.main[1].push('K');
  await env.player.play(tab, { measure: 0 });
  env.clock.advance(1000);
  assert.deepEqual(env.contexts[0].starts.map(s => Number(s.time.toFixed(3))), [.12, .62, .62]);
  assert.deepEqual(env.contexts[0].starts.map(s => s.frequency), [146.83, 900, 600]);
  env.player.stop();
  assert.deepEqual(env.errors, []);
});
