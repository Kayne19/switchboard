// The CPU time a piece of work takes on this thread, in milliseconds: the
// least of `runs` tries. Every budget test in this suite measures with it.
//
// A budget test is about the work: a layout that went quadratic, a note
// placement that routed every place it tried. The wall clock also counts
// every moment the scheduler gives the core to another process, so on a
// shared or busy runner it measures the machine. These budgets passed alone
// and failed with two or three copies of the suite running at once (load
// average 10 to 50): the dense bar chart's placement took 1394 ms of wall
// time against its 600 ms budget, for some 200 ms of work. The thread's own
// CPU time leaves the waiting out. A busy core still runs the work slower
// (a core shared with another thread, a lower clock): up to about 2x at load
// 50, measured. So each budget is at least twice what its work costs at that
// load on the machine they were measured on (a Ryzen 9 5900X), room for a
// slower runner, and, where the regression it was written to catch was
// measured, still under its cost. The least of a few tries leaves out a
// one-off pause in one of them: the first compile of the code, a major
// collection.
//
// The thread's figure, not the process's: V8 collects and compiles on
// threads of its own, which doubled the process's figure and made it noisy.
export function leastCpuMs(work: () => unknown, runs = 3): number {
  // Node 22.19 or later (README.md, "Building and testing"); package.json
  // allows 22.18, which the host agent runs on.
  if (typeof process.threadCpuUsage !== 'function') throw new Error('budget tests read the thread CPU time: run them on Node 22.19 or later');
  let least = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const before = process.threadCpuUsage();
    work();
    const spent = process.threadCpuUsage(before);
    least = Math.min(least, (spent.user + spent.system) / 1000);
  }
  return least;
}
