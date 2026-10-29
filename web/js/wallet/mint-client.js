// Run buildMint in a module worker, with a synchronous fallback for
// browsers/environments that cannot start one. Keeping the worker startup
// and protocol in one place makes the wallet's mint path read clearly.

const WORKER_TIMEOUT_MS = 120000;

function unavailable(message) {
  const err = new Error(message);
  err.workerUnavailable = true;
  return err;
}

export function buildMintOffThread(payload) {
  if (typeof Worker === 'undefined') {
    return Promise.reject(unavailable('module workers are not available'));
  }

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./mint-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(unavailable(err && err.message ? err.message : 'cannot start the mint worker'));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      worker.terminate();
      fn(value);
    };

    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.ok) finish(resolve, data.built);
      else finish(reject, new Error(data.error || 'the mint worker failed'));
    };
    worker.onerror = (event) => {
      finish(reject, unavailable(event.message || 'the mint worker failed to load'));
    };
    worker.onmessageerror = () => {
      finish(reject, unavailable('the mint worker returned an unreadable result'));
    };

    timer = setTimeout(() => {
      finish(reject, new Error('the mint worker timed out'));
    }, WORKER_TIMEOUT_MS);

    try {
      worker.postMessage(payload);
    } catch (err) {
      finish(reject, unavailable(err && err.message ? err.message : 'cannot send the mint job to the worker'));
    }
  });
}
