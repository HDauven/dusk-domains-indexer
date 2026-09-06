const targetBlockSeconds = 10
const blockHeightPollMs = 5_000

export function denoCollectorSource(options = {}) {
  const decoderUrl = options.decoderUrl ?? './event-decoder.mjs'
  const cursorSummaryUrl = new URL('./cursor-summary.mjs', import.meta.url).href
  return `import { normalizeObservedEvent } from ${JSON.stringify(decoderUrl)};
import { summarizeEventLogText } from ${JSON.stringify(cursorSummaryUrl)};
import {
  Contract,
  Network,
  dataDrivers,
} from "@dusk/w3sper";

const args = parseArgs(Deno.args);
const contracts = JSON.parse(args.contractsJson);
const targetBlockSeconds = ${targetBlockSeconds};
const blockHeightPollMs = ${blockHeightPollMs};
const startedAt = new Date().toISOString();
const initialCursor = await readExistingEventLogCursor(args.eventLog);
let eventCount = initialCursor.eventCount;
let lastEventAt = initialCursor.lastEventAt;
let lastContract = initialCursor.lastContract;
let lastEventName = initialCursor.lastEventName;
let lastTxId = initialCursor.lastTxId;
let lastBlockHeight = initialCursor.lastBlockHeight;
let currentBlockHeight = initialCursor.currentBlockHeight ?? initialCursor.lastBlockHeight;
let writeChain = Promise.resolve();
let blockHeightTimer = null;

await Deno.mkdir(dirname(args.eventLog), { recursive: true });
await Deno.mkdir(dirname(args.cursorFile), { recursive: true });

const network = new Network(args.nodeUrl);
await network.rues.connect();
await refreshBlockHeight();

console.log(JSON.stringify({
  ok: true,
  mode: "collecting",
  contractStack: args.contractStack,
  nodeUrl: args.nodeUrl,
  eventLog: args.eventLog,
  cursorFile: args.cursorFile,
  contracts: contracts.map((contract) => ({ key: contract.key, events: contract.events })),
}));

for (const contract of contracts) {
  const driver = await dataDrivers.load(await Deno.readFile(new URL(contract.driverFile, pathUrl(args.publicDir))));
  driver.init?.();
  const facade = new Contract({
    contractId: contract.contractId,
    driver,
    network,
  });

  for (const eventName of contract.events) {
    await facade.events[eventName].on((event, error) => {
      if (error) {
        console.error(JSON.stringify({
          ok: false,
          eventName,
          contractKey: contract.key,
          error: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      enqueueEvent(contract, eventName, event);
    });
  }
}

await writeCursor({ status: "running" });
blockHeightTimer = setInterval(() => {
  void refreshBlockHeight();
}, blockHeightPollMs);

if (args.durationMs > 0) {
  await wait(args.durationMs);
  await shutdown("duration_elapsed");
} else {
  Deno.addSignalListener("SIGINT", () => {
    void shutdown("sigint");
  });
  Deno.addSignalListener("SIGTERM", () => {
    void shutdown("sigterm");
  });
}

function enqueueEvent(contract, eventName, event) {
  const observedAt = new Date().toISOString();
  const normalized = normalizeObservedEvent({ contract, eventName, event, observedAt, targetBlockSeconds, observedBlockHeight: currentBlockHeight });

  if (!normalized) {
    console.error(JSON.stringify({
      ok: false,
      contractKey: contract.key,
      eventName,
      error: "unsupported_event",
    }));
    return;
  }
  writeChain = writeChain
    .then(async () => {
      eventCount += 1;
      normalized.meta.eventId = "log:" + eventCount;
      lastEventAt = normalized.meta?.observedAt ?? observedAt;
      lastContract = normalized.meta?.contractKey ?? contract.key;
      lastEventName = normalized.event?.type ?? eventName;
      lastTxId = normalized.meta?.txId ?? null;
      lastBlockHeight = normalized.meta?.blockHeight ?? null;
      if (normalized.meta?.blockHeight !== null && normalized.meta?.blockHeight !== undefined) {
        currentBlockHeight = Math.max(currentBlockHeight ?? 0, normalized.meta.blockHeight);
      }
      await Deno.writeTextFile(args.eventLog, JSON.stringify(normalized) + "\\n", { append: true });
      await writeCursor({
        status: "running",
      });
      console.log(JSON.stringify({
        ok: true,
        appended: true,
        eventCount,
        contractKey: contract.key,
        eventName,
      }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
}

async function refreshBlockHeight() {
  try {
    const height = Number(await network.blockHeight);
    if (!Number.isFinite(height) || height < 0 || height === currentBlockHeight) return;
    currentBlockHeight = height;
    await writeCursor({ status: "running" });
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: "block_height_poll_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function writeCursor(extra = {}) {
  const cursorBody = JSON.stringify({
    version: 1,
    source: "w3sper-live-subscription",
    startedAt,
    updatedAt: new Date().toISOString(),
    eventCount,
    replayedEventCount: initialCursor.eventCount,
    lastEventAt,
    lastContract,
    lastEventName,
    lastTxId,
    lastBlockHeight,
    currentBlockHeight,
    scannedBlockHeight: currentBlockHeight,
    ...extra,
  }, null, 2) + "\\n";
  const tempFile = args.cursorFile + ".tmp-" + Deno.pid + "-" + Date.now();
  await Deno.writeTextFile(tempFile, cursorBody);
  await Deno.rename(tempFile, args.cursorFile);
}

async function shutdown(reason) {
  if (blockHeightTimer !== null) clearInterval(blockHeightTimer);
  await writeChain;
  await writeCursor({ status: "stopped", reason });
  console.log(JSON.stringify({ ok: true, stopped: true, reason, eventCount }));
  Deno.exit(0);
}

function dirname(path) {
  const normalized = path.replace(/\\\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

function pathUrl(path) {
  return new URL(path.endsWith("/") ? path : path + "/", "file://");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readExistingEventLogCursor(path) {
  try {
    return summarizeEventLogText(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return summarizeEventLogText("");
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {
    durationMs: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Invalid argument near " + arg);
    }
    parsed[arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
    index += 1;
  }
  parsed.durationMs = Number(parsed.durationMs ?? 0);
  return parsed;
}
`
}
