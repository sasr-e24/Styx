// Runs the engine off the main thread so big logs don't freeze the page.
importScripts('catalog.js', 'engine.js');

const files = new Map();

self.onmessage = (e) => {
  const { cmd, id, seq } = e.data;
  try {
    if (cmd === 'load') {
      files.set(id, new Uint8Array(e.data.buf));
      self.postMessage({ seq, scan: self.StyxEngine.scan(files.get(id)) });
    } else if (cmd === 'run') {
      const r = self.StyxEngine.sanitize(files.get(id), e.data.policy);
      self.postMessage({ seq, report: r.report, bytes: r.bytes }, [r.bytes.buffer]);
    } else if (cmd === 'drop') {
      files.delete(id);
      self.postMessage({ seq });
    }
  } catch (err) {
    self.postMessage({ seq, error: err.message || String(err) });
  }
};
