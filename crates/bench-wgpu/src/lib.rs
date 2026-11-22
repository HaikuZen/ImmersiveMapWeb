// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The wgpu half of the draw-call benchmark. It records the same frame as
//! the TypeScript half (`apps/playground/src/bench.ts`): one quad per draw,
//! each draw with its own dynamic offset into one uniform buffer, so the two
//! measure the cost of issuing commands from Rust through wgpu against
//! issuing them from TypeScript straight to WebGPU. Browser only: the crate
//! is empty on a native target, so the workspace's native checks skip it.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

const UNIFORM_STRIDE: u64 = 256;

const SHADER: &str = r#"
struct Quad { offset: vec2f, size: vec2f, color: vec4f }
@group(0) @binding(0) var<uniform> quad: Quad;

struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let corner = vec2f(f32(i & 1u), f32((i >> 1u) & 1u));
    var out: Out;
    out.position = vec4f(quad.offset + corner * quad.size, 0.0, 1.0);
    out.color = quad.color;
    return out;
}

@fragment fn fs(input: Out) -> @location(0) vec4f { return input.color; }
"#;

#[wasm_bindgen]
pub struct WgpuBench {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    capacity: u32,
}

#[wasm_bindgen]
impl WgpuBench {
    /// Sets up the device on `canvas` with room for `capacity` draws.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, capacity: u32) -> Result<WgpuBench, JsError> {
        let (width, height) = (canvas.width(), canvas.height());
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
        let instance = wgpu::Instance::new(descriptor);
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsError::new(&e.to_string()))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        let config = surface
            .get_default_config(&adapter, width, height)
            .ok_or_else(|| JsError::new("the canvas is not compatible with the adapter"))?;
        surface.configure(&device, &config);

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("bench"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(32),
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("bench"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(config.format.into())],
            }),
            multiview_mask: None,
            cache: None,
        });

        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("quads"),
            size: UNIFORM_STRIDE * capacity as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&buffer, 0, &quad_uniforms(capacity));
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(32),
                }),
            }],
        });

        Ok(WgpuBench { device, queue, surface, pipeline, bind_group, capacity })
    }

    /// Records, submits and presents one frame of `draws` draws.
    pub fn frame(&self, draws: u32) -> Result<(), JsError> {
        let draws = draws.min(self.capacity);
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            other => return Err(JsError::new(&format!("no surface texture: {other:?}"))),
        };
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.08, g: 0.08, b: 0.1, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            for i in 0..draws {
                pass.set_bind_group(0, &self.bind_group, &[i * UNIFORM_STRIDE as u32]);
                pass.draw(0..4, 0..1);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(texture);
        Ok(())
    }
}

/// The same deterministic grid of quads the TypeScript half writes.
fn quad_uniforms(count: u32) -> Vec<u8> {
    let columns = (count as f32).sqrt().ceil().max(1.0) as u32;
    let cell = 2.0 / columns as f32;
    let mut bytes = vec![0u8; (UNIFORM_STRIDE * count as u64) as usize];
    for i in 0..count {
        let (cx, cy) = ((i % columns) as f32, (i / columns) as f32);
        let t = i as f32 / count.max(1) as f32;
        let values = [
            -1.0 + cx * cell,
            -1.0 + cy * cell,
            cell * 0.8,
            cell * 0.8,
            0.3 + 0.7 * t,
            0.5,
            1.0 - 0.7 * t,
            1.0,
        ];
        let start = (i as u64 * UNIFORM_STRIDE) as usize;
        for (k, v) in values.iter().enumerate() {
            bytes[start + k * 4..start + k * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    bytes
}
