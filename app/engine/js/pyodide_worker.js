#!/usr/bin/env node
/**
 * pyodide_worker.js — Pyodide/WASM Python 沙箱的 Node 侧执行器。
 *
 * 协议（stdin/stdout 各一行 JSON）：
 *   启动参数：--index-url <pyodide 包目录>   （loadPyodide 的 indexURL）
 *   → 就绪帧：{"event":"ready"}
 *   ← 请求帧：{"id":1, "source":"..."}
 *   → 结果帧：{"id":1, "ok":true, "value":"<repr>", "stdout":"...", "error":""}
 *
 * 设计取舍：
 * - 常驻进程：Pyodide 冷启动数秒，逐请求起进程不可接受；由 Python 客户端
 *   负责生命周期（超时杀进程树、下次调用重新拉起——状态不跨超时保留）。
 * - stdout/stderr 经 setStdout/setStderr 捕获，不落宿主终端。
 * - 隔离边界如实声明：Pyodide 的 WASM 没有套接字层，Python stdlib 网络
 *   不可用；Node 版文件系统可达。曾试过 Node --permission 白名单，但它的
 *   进程内绑定禁令连 Pyodide 自身引导都拦（process.binding），不兼容是
 *   事实——所以隔离靠三层：调用方先做 AST review（禁 os/io/subprocess/
 *   下划线逃逸链），worker 以 --max-old-space-size 封顶堆内存，网络天然
 *   无出口。这是纵深防御，不是内核保证，诚实标注。
 */
"use strict";

const readline = require("readline");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  let indexURL = "";
  let modulePath = "";
  const ii = args.indexOf("--index-url");
  if (ii >= 0 && args[ii + 1]) indexURL = args[ii + 1];
  const mi = args.indexOf("--module");
  if (mi >= 0 && args[mi + 1]) modulePath = args[mi + 1];

  let pyodide = null;
  let stdoutBuf = [];

  function ensurePyodide() {
    if (pyodide) return null;
    try {
      // worker 位于 backend/js/，沿目录向上找不到 app/ui/node_modules ——
      // 所以调用方必须用 --module 传 pyodide 包的绝对路径。
      const mod = modulePath ? require(modulePath) : require("pyodide");
      const loader = mod.loadPyodide || (mod.default && mod.default.loadPyodide);
      if (!loader) throw new Error("pyodide module has no loadPyodide");
      return loader(indexURL ? { indexURL } : {})
        .then((py) => {
          pyodide = py;
          py.setStdout({ batched: (s) => stdoutBuf.push(s) });
          py.setStderr({ batched: (s) => stdoutBuf.push("[stderr] " + s) });
          emit({ event: "ready" });
        })
        .catch((e) => {
          emit({ event: "fatal", error: String(e && e.message || e) });
          process.exit(1);
        });
    } catch (e) {
      emit({ event: "fatal", error: "cannot require('pyodide'): "
        + String(e && e.message || e) });
      process.exit(1);
    }
  }

  const loading = ensurePyodide();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    (async () => {
      if (!line.trim()) return;
      let req;
      try { req = JSON.parse(line); } catch (e) {
        emit({ id: null, ok: false, error: "request is not valid JSON" });
        return;
      }
      try {
        if (loading) await loading;         // 首请求等加载完成
        stdoutBuf = [];
        const value = await pyodide.runPythonAsync(String(req.source || ""));
        let repr = "";
        if (value !== undefined && value !== null) {
          try { repr = value.toString(); } catch (e) { repr = "<unrepresentable>"; }
        }
        emit({ id: req.id === undefined ? null : req.id,
               ok: true, value: repr,
               stdout: stdoutBuf.join("\n"), error: "" });
      } catch (e) {
        emit({ id: req.id === undefined ? null : req.id,
               ok: false, value: "", stdout: stdoutBuf.join("\n"),
               error: String(e && e.message || e) });
      }
    })();
  });

  rl.on("close", () => process.exit(0));
}

main();
