// Heap in use / the process's heap limit, e.g. "1432/2096MB". Printed in the
// hot loop's and the liquidation watcher's heartbeats so that an exported log
// shows memory as a curve: a leak climbs steadily toward the limit, an
// under-provisioned process sits just below it. (Both Base's and Arbitrum's
// watchers were dying with "JavaScript heap out of memory" every ~1.9h, and
// nothing in the log said so until the moment they died.)
import v8 from 'node:v8';

const limitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1e6);
export const heapMb = (): string => `${Math.round(process.memoryUsage().heapUsed / 1e6)}/${limitMb}MB`;
