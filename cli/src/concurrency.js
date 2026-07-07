// Tiny concurrency limiter (no dependency). Runs at most `limit` tasks at once.
// Each task is a function returning a promise; results preserve input order.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, limit | 0);

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(n, items.length); i++) runners.push(run());
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { mapLimit, sleep };
