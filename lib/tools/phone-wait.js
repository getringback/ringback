"use strict";

// Only phone network operations use this bound. Never use it for model calls.
async function phoneWait(fn, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The phone did not answer in time.")), Math.max(1, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const phoneConfig = (cfg) => ({ ...cfg, connect_ms: 1000, idle_grace_ms: 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { phoneWait, phoneConfig, sleep };
