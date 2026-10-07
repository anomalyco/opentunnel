#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"]

function run(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  child.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })
  const forwarders = {}
  for (const signal of forwardedSignals) {
    forwarders[signal] = () => {
      try {
        child.kill(signal)
      } catch {}
    }
    process.on(signal, forwarders[signal])
  }
  child.on("exit", (code, signal) => {
    for (const forwardedSignal of forwardedSignals) process.removeListener(forwardedSignal, forwarders[forwardedSignal])
    if (signal) return process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 0)
  })
}

const name = "@opentunnel/cli-" + os.platform() + "-" + os.arch()

function findBinary(startDir) {
  let current = startDir
  for (;;) {
    const candidate = path.join(current, "node_modules", name, "bin", "opentunnel")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

const resolved = process.env.OPENTUNNEL_BIN_PATH || findBinary(path.dirname(fs.realpathSync(__filename)))
if (!resolved) {
  console.error(
    `It seems that your package manager failed to install the right opentunnel CLI package. Try manually installing "${name}".`,
  )
  process.exit(1)
}
run(resolved)
