(function (root) {
  'use strict';

  function create(options = {}) {
    const callbacks = {};
    for (const name of ['onState', 'onPosition', 'onProgress', 'onError']) {
      callbacks[name] = typeof options[name] === 'function' ? options[name] : function () {};
    }
    let generation = 0;
    let session = null;

    function isCurrent(candidate) {
      return session === candidate && candidate.generation === generation;
    }
    function dispose(candidate) {
      if (!candidate) return;
      candidate.playing = false;
      for (const timer of candidate.timers) clearTimeout(timer);
      candidate.timers.clear();
      for (const voice of candidate.voices) {
        voice.oscillator.onended = null;
        try { voice.oscillator.stop(); } catch { /* A voice may already have ended. */ }
        voice.oscillator.disconnect();
        voice.gain.disconnect();
      }
      candidate.voices.clear();
      if (candidate.context.state !== 'closed') {
        try { candidate.context.close().catch(function () {}); } catch { /* Closing is best effort. */ }
      }
    }
    function stop() {
      generation++;
      const previous = session;
      session = null;
      dispose(previous);
      callbacks.onState(false);
      callbacks.onPosition(null);
      callbacks.onProgress(0);
    }
    function fail(candidate, error) {
      if (!isCurrent(candidate)) return;
      stop();
      callbacks.onError(error && error.message ? error.message : String(error));
    }
    function later(candidate, action, delay) {
      const timer = setTimeout(function () {
        candidate.timers.delete(timer);
        if (!isCurrent(candidate)) return;
        try { action(); } catch (error) { fail(candidate, error); }
      }, Math.max(0, delay));
      candidate.timers.add(timer);
    }
    function voice(candidate, frequency, type, time, volume, attack, decay, length) {
      const context = candidate.context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const entry = { oscillator, gain };
      candidate.voices.add(entry);
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, time);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(volume, time + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = function () {
        candidate.voices.delete(entry);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(time);
      oscillator.stop(time + length);
    }
    function sound(candidate, cell, time, quarterSeconds, isBeat) {
      if (!cell.length) return;
      const frequencies = { D: 146.83, S: 900, K: 600, T: 400 };
      const volume = (isBeat ? 0.14 : 0.1) / Math.sqrt(cell.length);
      for (const note of cell) {
        const symbol = note.toUpperCase();
        const number = Number(note);
        let frequency = frequencies[symbol];
        if (!frequency) {
          const numeric = Number.isFinite(number) ? 174.61 * 2 ** ((number - 1) * 2 / 12) : 220;
          frequency = Number.isFinite(numeric) ? Math.min(12000, Math.max(20, numeric)) : 220;
        }
        voice(candidate, frequency, ['S', 'K', 'T'].includes(symbol) ? 'triangle' : 'sine', time,
          volume, 0.008, Math.min(0.4, quarterSeconds * 0.85), 0.5);
      }
    }
    function click(candidate, time, accent) {
      voice(candidate, accent ? 2400 : 1600, 'square', time, accent ? 0.045 : 0.025, 0.003, 0.035, 0.045);
    }

    async function play(input, settings = {}) {
      stop();
      const token = generation;
      let candidate;
      try {
        const C = root.HangCore;
        const tab = C.validateTab(C.clone(input));
        const measure = settings.measure === undefined ? null : settings.measure;
        if (measure !== null && (!Number.isInteger(measure) || measure < 0 || measure >= tab.measures.length)) {
          throw new Error('Выберите существующий такт для прослушивания.');
        }
        const AudioContextClass = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Прослушивание не поддерживается этим браузером.');
        const context = new AudioContextClass();
        candidate = { generation: token, context, timers: new Set(), voices: new Set(), playing: false };
        session = candidate;
        await context.resume();
        if (!isCurrent(candidate)) { dispose(candidate); return; }

        const quarterSeconds = 60 / tab.tempo;
        const barQuarters = tab.meter.numerator * 4 / tab.meter.denominator;
        const indices = measure === null ? tab.measures.map(function (_, index) { return index; }) : [measure];
        const events = indices.flatMap(function (measureIndex, bar) {
          return C.slots(tab, measureIndex).map(function (slot, slotIndex) {
            return { measure: measureIndex, slot: slotIndex, beat: slot.beat, sub: slot.sub,
              offset: (bar * barQuarters + slot.offset) * quarterSeconds };
          });
        });
        const rows = tab.hands === 'split' ? ['R', 'L'] : ['main'];
        const cycleSeconds = indices.length * barQuarters * quarterSeconds;
        const loop = settings.loop === true;
        const metronome = settings.metronome === true;
        const start = context.currentTime + 0.12;
        let eventIndex = 0;
        let cycle = 0;
        let positionCycle = -1;
        let positionIndex = -1;

        function firstAfter(offset) {
          let low = 0, high = events.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (events[middle].offset <= offset) low = middle + 1;
            else high = middle;
          }
          return low;
        }
        function showPosition(index, eventCycle) {
          if (eventCycle < positionCycle || eventCycle === positionCycle && index <= positionIndex) return;
          positionCycle = eventCycle;
          positionIndex = index;
          const event = events[index];
          callbacks.onPosition({ measure: event.measure, slot: event.slot });
        }

        candidate.playing = true;
        callbacks.onState(true);
        if (!isCurrent(candidate)) return;

        function scheduleAhead() {
          if (!isCurrent(candidate)) return;
          const now = context.currentTime;
          const elapsed = Math.max(0, now - start);
          if (!loop && elapsed >= cycleSeconds) { stop(); return; }
          if (now >= start) {
            const currentCycle = loop ? Math.floor(elapsed / cycleSeconds) : 0;
            const currentOffset = elapsed - currentCycle * cycleSeconds;
            showPosition(Math.max(0, firstAfter(currentOffset) - 1), currentCycle);
            if (!isCurrent(candidate)) return;
          }
          callbacks.onProgress(loop ? (elapsed % cycleSeconds) / cycleSeconds : Math.min(1, elapsed / cycleSeconds));
          if (!isCurrent(candidate)) return;

          // Skip missed events after a stalled browser timer instead of playing a backlog.
          const currentCycle = loop ? Math.floor(elapsed / cycleSeconds) : 0;
          if (cycle < currentCycle) { cycle = currentCycle; eventIndex = 0; }
          if (loop || cycle === 0) {
            const cutoff = now - start - cycle * cycleSeconds - 0.03;
            eventIndex = Math.max(eventIndex, firstAfter(cutoff));
            if (eventIndex === events.length) { eventIndex = 0; cycle++; }
          }

          while (loop || cycle === 0) {
            const event = events[eventIndex];
            const time = start + cycle * cycleSeconds + event.offset;
            if (time > context.currentTime + 0.25) break;
            const soundTime = Math.max(time, context.currentTime + 0.005);
            for (const row of rows) sound(candidate, tab.measures[event.measure].rows[row][event.slot], soundTime, quarterSeconds, event.sub === 0);
            if (metronome && event.sub === 0) click(candidate, soundTime, event.beat === 0);
            const queuedIndex = eventIndex, queuedCycle = cycle;
            later(candidate, function () {
              if (context.currentTime - time <= 0.15) showPosition(queuedIndex, queuedCycle);
            }, (time - context.currentTime) * 1000);
            eventIndex++;
            if (eventIndex === events.length) { eventIndex = 0; cycle++; }
          }
          later(candidate, scheduleAhead, 50);
        }
        scheduleAhead();
      } catch (error) {
        if (candidate) fail(candidate, error);
        else if (token === generation) callbacks.onError(error && error.message ? error.message : String(error));
      }
    }

    return { play, stop,
      get playing() { return Boolean(session && session.playing); },
      get starting() { return Boolean(session && !session.playing); }
    };
  }

  root.HangPlayback = { create };
})(typeof window === 'undefined' ? globalThis : window);
