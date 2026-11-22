// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// `remotelog=1`: sends what the page reports to the dev server, for a device
// whose console is out of reach (a phone): the browser, the WebGPU adapter
// with its features and limits, every error and warning on the console,
// uncaught errors and rejections, and then the map's state every two
// seconds with a still of what it draws. The dev server appends each record
// to fixtures/remote-log.jsonl (`/__log`). The records are kept on the page
// as well, in `window.remoteLog`, for a static host with no sink: a driver
// over WebDriver (safaridriver on an iPhone by cable) reads them there.
// Imported first by main.ts, so it hears the map's creation fail too.

import type { ImmersiveMap } from "@artembobkin/immersive-map";

const enabled = new URLSearchParams(location.search).get("remotelog") === "1";
const started = performance.now();
const records: Record<string, unknown>[] = [];
if (enabled) Object.assign(window, { remoteLog: records });

function send(kind: string, fields: Record<string, unknown>): void {
  if (!enabled) return;
  const record = { kind, t: Math.round(performance.now() - started), ...fields };
  records.push(record);
  const body = JSON.stringify(record);
  void fetch("/__log", { method: "POST", body, keepalive: body.length < 60_000 }).catch(() => undefined);
}

function text(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

if (enabled) {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      send(level, { message: args.map(text).join(" ") });
      original(...args);
    };
  }
  addEventListener("error", (event) => send("uncaught", { message: text(event.error ?? event.message), source: `${event.filename}:${event.lineno}:${event.colno}` }));
  addEventListener("unhandledrejection", (event) => send("rejection", { message: text(event.reason) }));
  // The GPU's own failures, by name: which shader module a pipeline that
  // fails to build was made from, with its compilation messages, and every
  // error the device does not hand to a scope.
  const moduleLabels = new WeakMap<GPUShaderModule, string>();
  const moduleCode = new WeakMap<GPUShaderModule, string>();
  const failures: Record<string, unknown>[] = [];
  Object.assign(window, { gpuFailures: failures });
  const device = GPUDevice.prototype;
  const createShaderModule = device.createShaderModule;
  device.createShaderModule = function (this: GPUDevice, descriptor: GPUShaderModuleDescriptor) {
    const module = createShaderModule.call(this, descriptor);
    moduleLabels.set(module, descriptor.label ?? "");
    moduleCode.set(module, descriptor.code);
    void module.getCompilationInfo().then((info) => {
      const messages = info.messages.filter((m) => m.type !== "info").map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
      if (messages.length > 0) send("shader", { label: descriptor.label, messages });
    });
    return module;
  };
  const describe = (descriptor: GPURenderPipelineDescriptor) => ({
    label: descriptor.label,
    vertexModule: moduleLabels.get(descriptor.vertex.module),
    vertexEntry: descriptor.vertex.entryPoint,
    fragmentModule: descriptor.fragment ? moduleLabels.get(descriptor.fragment.module) : undefined,
    fragmentEntry: descriptor.fragment?.entryPoint,
    constants: descriptor.vertex.constants,
  });
  const createRenderPipelineAsync = device.createRenderPipelineAsync;
  device.createRenderPipelineAsync = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
    return createRenderPipelineAsync.call(this, descriptor).catch((error: unknown) => {
      send("pipeline", { ...describe(descriptor), message: text(error) });
      // The whole failing descriptor, for a driver to rebuild the pipeline by parts (`window.gpuFailures`).
      failures.push({ ...describe(descriptor), code: moduleCode.get(descriptor.vertex.module), buffers: descriptor.vertex.buffers, targets: descriptor.fragment?.targets, fragmentConstants: descriptor.fragment?.constants, primitive: descriptor.primitive, depthStencil: descriptor.depthStencil, multisample: descriptor.multisample });
      throw error;
    });
  };
  const createRenderPipeline = device.createRenderPipeline;
  device.createRenderPipeline = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
    this.pushErrorScope("internal");
    this.pushErrorScope("validation");
    const pipeline = createRenderPipeline.call(this, descriptor);
    for (let i = 0; i < 2; i++) {
      void this.popErrorScope().then((error) => {
        if (error) send("pipeline", { ...describe(descriptor), message: error.message });
      });
    }
    return pipeline;
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
    const created = await requestDevice.call(this, descriptor);
    created.addEventListener("uncapturederror", (event) => send("gpu", { message: (event as GPUUncapturedErrorEvent).error.message }));
    void created.lost.then((info) => send("lost", { reason: info.reason, message: info.message }));
    return created;
  };
  send("page", { url: location.href, userAgent: navigator.userAgent, devicePixelRatio, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], webgpu: "gpu" in navigator });
  void (async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return send("adapter", { found: false });
    const limits: Record<string, number> = {};
    for (const key in adapter.limits) limits[key] = adapter.limits[key as keyof GPUSupportedLimits] as number;
    send("adapter", { found: true, info: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, features: [...adapter.features], limits });
  })().catch((error: unknown) => send("adapter", { found: false, message: text(error) }));
}

/** Reports the map's state every two seconds, and a still of it once it has drawn for a while. */
export function watchMapRemotely(map: ImmersiveMap): void {
  if (!enabled) return;
  let frames = 0;
  let last: Record<string, unknown> = {};
  map.onFrame((frame) => {
    frames++;
    last = { cpu: frame.cpuMilliseconds, gpu: frame.gpuMilliseconds, draws: frame.draws, visible: frame.visibleTiles, rendered: frame.renderedTiles, loading: frame.loadingTiles };
  });
  send("created", { view: map.view });
  setInterval(() => send("state", { frames, view: map.view, ...last }), 2000);
  setTimeout(() => {
    void map
      .captureStill({ type: "image/jpeg", quality: 0.7 })
      .then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        send("still", { type: blob.type, base64: btoa(binary) });
      })
      .catch((error: unknown) => send("still", { message: text(error) }));
  }, 10_000);
}
