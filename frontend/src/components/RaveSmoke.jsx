import React, { useRef, useEffect } from "react";

/**
 * RaveSmoke — a GPU fluid simulation (Stam "Stable Fluids"), adapted from Pavel
 * Dobryakov's WebGL Fluid Simulation. The cursor injects velocity+dye "splats", so
 * the smoke genuinely trails and curls behind the pointer. Key robustness: WebGL2
 * float textures w/ linear filtering, falling back to a MANUAL-BILINEAR advection
 * shader on GPUs without float-linear — so it never renders as hard grid blocks.
 *
 * Adapted for our app FX: transparent overlay (display alpha from density, not an
 * opaque black bg), smoke-white dye, and a one-shot burst (seed a puff on mount,
 * fade out at the end, auto-remove).
 */
const SMOKE = [0.72, 0.78, 0.95];          // cool-white tint
const EMIT_COLOR = SMOKE.map((c) => c * 0.014);  // dye amount (thickness via display alpha)
const EMIT_RADIUS = 0.018;                  // BROAD source — a thick billow, not a spout
const EMIT_FROM_BOTTOM = 0.22;              // start a bit higher so it has room to fall
const EMIT_IN = 22;                         // inward flow — pushes smoke across the screen
const EMIT_DOWN = 12;                        // gentle downward lean toward the floor
const GRAVITY = 140;                         // heavy fog sinks (downward force ∝ density)
const CONFIG = {
  TEXTURE_DOWNSAMPLE: 1,
  DENSITY_DISSIPATION: 0.988,   // dye lingers → carried further into the screen
  VELOCITY_DISSIPATION: 0.975,  // flow persists/carries (fine turbulence too)
  PRESSURE_DISSIPATION: 0.8,
  PRESSURE_ITERATIONS: 25,
  CURL: 40,                     // strong vorticity → fractal folding (texture even when thick)
  SPLAT_RADIUS: 0.0035,
};

export default function RaveSmoke({ duration = 15000 }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    // ── context (transparent overlay) ──────────────────────────────────────
    const params = { alpha: true, premultipliedAlpha: false, depth: false, stencil: false, antialias: false };
    let gl = canvas.getContext("webgl2", params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);
    if (!gl) return undefined;
    const halfFloat = isWebGL2 ? null : gl.getExtension("OES_texture_half_float");
    let supportLinear = isWebGL2 ? gl.getExtension("OES_texture_float_linear") : gl.getExtension("OES_texture_half_float_linear");
    if (isWebGL2) gl.getExtension("EXT_color_buffer_float");
    if (!isWebGL2 && !halfFloat) return undefined;
    const internalFormat = isWebGL2 ? gl.RGBA16F : gl.RGBA;
    const internalFormatRG = isWebGL2 ? gl.RG16F : gl.RGBA;
    const formatRG = isWebGL2 ? gl.RG : gl.RGBA;
    const texType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;

    // ── shaders ─────────────────────────────────────────────────────────────
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const baseVert = compile(gl.VERTEX_SHADER,
      "precision highp float; precision mediump sampler2D; attribute vec2 aPosition; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform vec2 texelSize; void main(){ vUv=aPosition*0.5+0.5; vL=vUv-vec2(texelSize.x,0.0); vR=vUv+vec2(texelSize.x,0.0); vT=vUv+vec2(0.0,texelSize.y); vB=vUv-vec2(0.0,texelSize.y); gl_Position=vec4(aPosition,0.0,1.0); }");
    const clearShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uTexture; uniform float value; void main(){ gl_FragColor=value*texture2D(uTexture,vUv); }");
    // Overlay display: alpha from density brightness → transparent where no smoke.
    // Decouple THICKNESS (alpha) from BRIGHTNESS: opacity rises with density, but
    // the colour is a capped grey→soft-white ramp, so dense smoke reads thick/matte
    // instead of blowing out to a dodged pure-white blob.
    const displayShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uTexture; uniform float uEnvelope; uniform float uTime; void main(){ vec3 c=texture2D(uTexture,vUv).rgb; float d=max(c.r,max(c.g,c.b)); float a=clamp(d*1.5,0.0,1.0); float sheen=0.85+0.15*sin(vUv.x*5.0-vUv.y*3.0+uTime*0.8)+0.10*sin(vUv.x*17.0+vUv.y*13.0-uTime*1.6); vec3 tone=mix(vec3(0.50,0.53,0.60),vec3(0.80,0.84,0.94),clamp(d,0.0,1.0))*sheen; gl_FragColor=vec4(tone, a*uEnvelope); }");
    const splatShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius; void main(){ vec2 p=vUv-point.xy; p.x*=aspectRatio; vec3 splat=exp(-dot(p,p)/radius)*color; vec3 base=texture2D(uTarget,vUv).xyz; gl_FragColor=vec4(base+splat,1.0); }");
    const advectionManual = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation; vec4 bilerp(in sampler2D sam,in vec2 p){ vec4 st; st.xy=floor(p-0.5)+0.5; st.zw=st.xy+1.0; vec4 uv=st*texelSize.xyxy; vec4 a=texture2D(sam,uv.xy); vec4 b=texture2D(sam,uv.zy); vec4 c=texture2D(sam,uv.xw); vec4 d=texture2D(sam,uv.zw); vec2 f=p-st.xy; return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); } void main(){ vec2 coord=gl_FragCoord.xy - dt*texture2D(uVelocity,vUv).xy; gl_FragColor=dissipation*bilerp(uSource,coord); gl_FragColor.a=1.0; }");
    const advection = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation; void main(){ vec2 coord=vUv - dt*texture2D(uVelocity,vUv).xy*texelSize; gl_FragColor=dissipation*texture2D(uSource,coord); }");
    const divergenceShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uVelocity; vec2 sv(in vec2 uv){ vec2 m=vec2(1.0); if(uv.x<0.0){uv.x=0.0;m.x=-1.0;} if(uv.x>1.0){uv.x=1.0;m.x=-1.0;} if(uv.y<0.0){uv.y=0.0;m.y=-1.0;} if(uv.y>1.0){uv.y=1.0;m.y=-1.0;} return m*texture2D(uVelocity,uv).xy; } void main(){ float L=sv(vL).x,R=sv(vR).x,T=sv(vT).y,B=sv(vB).y; gl_FragColor=vec4(0.5*(R-L+T-B),0.0,0.0,1.0); }");
    const curlShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uVelocity; void main(){ float L=texture2D(uVelocity,vL).y,R=texture2D(uVelocity,vR).y,T=texture2D(uVelocity,vT).x,B=texture2D(uVelocity,vB).x; gl_FragColor=vec4(R-L-T+B,0.0,0.0,1.0); }");
    const vorticityShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt; void main(){ float L=texture2D(uCurl,vL).y,R=texture2D(uCurl,vR).y,T=texture2D(uCurl,vT).x,B=texture2D(uCurl,vB).x,C=texture2D(uCurl,vUv).x; vec2 force=vec2(abs(T)-abs(B),abs(R)-abs(L)); force*=1.0/length(force+0.00001)*curl*C; vec2 vel=texture2D(uVelocity,vUv).xy; gl_FragColor=vec4(vel+force*dt,0.0,1.0); }");
    const pressureShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uPressure; uniform sampler2D uDivergence; vec2 bnd(in vec2 uv){ return min(max(uv,0.0),1.0); } void main(){ float L=texture2D(uPressure,bnd(vL)).x,R=texture2D(uPressure,bnd(vR)).x,T=texture2D(uPressure,bnd(vT)).x,B=texture2D(uPressure,bnd(vB)).x,div=texture2D(uDivergence,vUv).x; gl_FragColor=vec4((L+R+B+T-div)*0.25,0.0,0.0,1.0); }");
    const gradientShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uPressure; uniform sampler2D uVelocity; vec2 bnd(in vec2 uv){ return min(max(uv,0.0),1.0); } void main(){ float L=texture2D(uPressure,bnd(vL)).x,R=texture2D(uPressure,bnd(vR)).x,T=texture2D(uPressure,bnd(vT)).x,B=texture2D(uPressure,bnd(vB)).x; vec2 v=texture2D(uVelocity,vUv).xy; v-=vec2(R-L,T-B); gl_FragColor=vec4(v,0.0,1.0); }");
    // Gravity: heavier-than-air fog sinks — a downward force where dye is present.
    const gravityShader = compile(gl.FRAGMENT_SHADER,
      "precision highp float; precision mediump sampler2D; varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uDensity; uniform float g; uniform float dt; void main(){ vec2 v=texture2D(uVelocity,vUv).xy; vec3 d=texture2D(uDensity,vUv).rgb; float m=max(d.r,max(d.g,d.b)); v.y -= g*m*dt; gl_FragColor=vec4(v,0.0,1.0); }");

    function Program(frag) {
      const program = gl.createProgram();
      gl.attachShader(program, baseVert); gl.attachShader(program, frag); gl.linkProgram(program);
      const uniforms = {}; const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(program, i).name; uniforms[nm] = gl.getUniformLocation(program, nm); }
      return { program, uniforms, bind() { gl.useProgram(program); } };
    }
    const clearProgram = Program(clearShader);
    const displayProgram = Program(displayShader);
    const splatProgram = Program(splatShader);
    const advectionProgram = Program(supportLinear ? advection : advectionManual);
    const divergenceProgram = Program(divergenceShader);
    const curlProgram = Program(curlShader);
    const vorticityProgram = Program(vorticityShader);
    const pressureProgram = Program(pressureShader);
    const gradientProgram = Program(gradientShader);
    const gravityProgram = Program(gravityShader);

    let tW, tH, density, velocity, divergence, curl, pressure;
    function createFBO(texId, w, h, iFmt, fmt, type, param) {
      gl.activeTexture(gl.TEXTURE0 + texId);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, iFmt, w, h, 0, fmt, type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
      return [tex, fbo, texId];
    }
    function createDoubleFBO(texId, w, h, iFmt, fmt, type, param) {
      let a = createFBO(texId, w, h, iFmt, fmt, type, param);
      let b = createFBO(texId + 1, w, h, iFmt, fmt, type, param);
      return { get first() { return a; }, get second() { return b; }, swap() { const t = a; a = b; b = t; } };
    }
    function initFramebuffers() {
      tW = gl.drawingBufferWidth >> CONFIG.TEXTURE_DOWNSAMPLE;
      tH = gl.drawingBufferHeight >> CONFIG.TEXTURE_DOWNSAMPLE;
      const filt = supportLinear ? gl.LINEAR : gl.NEAREST;
      density = createDoubleFBO(0, tW, tH, internalFormat, gl.RGBA, texType, filt);
      velocity = createDoubleFBO(2, tW, tH, internalFormatRG, formatRG, texType, filt);
      divergence = createFBO(4, tW, tH, internalFormatRG, formatRG, texType, gl.NEAREST);
      curl = createFBO(5, tW, tH, internalFormatRG, formatRG, texType, gl.NEAREST);
      pressure = createDoubleFBO(6, tW, tH, internalFormatRG, formatRG, texType, gl.NEAREST);
    }
    initFramebuffers();

    const blit = (() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);
      return (dest) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dest); gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0); };
    })();

    function splatVelocity(x, y, dx, dy, radius) {
      splatProgram.bind();
      gl.uniform1i(splatProgram.uniforms.uTarget, velocity.first[2]);
      gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
      gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
      gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
      gl.uniform1f(splatProgram.uniforms.radius, radius);
      blit(velocity.second[1]); velocity.swap();
    }
    function splatDensity(x, y, color, radius) {
      splatProgram.bind();
      gl.uniform1i(splatProgram.uniforms.uTarget, density.first[2]);
      gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
      gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
      gl.uniform3f(splatProgram.uniforms.color, color[0], color[1], color[2]);
      gl.uniform1f(splatProgram.uniforms.radius, radius);
      blit(density.second[1]); density.swap();
    }
    // Smoke pumped in from the lower LEFT and RIGHT, angled inward + down — the two
    // streams dive to the floor, collide at center, and the reflective bottom bounces
    // them UP into a central plume. (The real cursor only cuts; see below.)
    function emitSides(t) {
      const w = canvas.width, h = canvas.height, N = 3;
      for (let k = 0; k < N; k++) {
        const fb = EMIT_FROM_BOTTOM + k * 0.09;   // a tall stack of emitters → thick column
        const yL = h * (1.0 - fb) + h * 0.02 * Math.sin(t * 0.8 + k);
        const yR = h * (1.0 - fb) + h * 0.02 * Math.sin(t * 0.7 + k + 1.7);
        const dwob = 6 * Math.sin(t * 0.6 + k);
        // fluctuate emitted density so the stream injects uneven smoke → folds into
        // filaments/wisps rather than a uniform thick mass
        const nL = 0.4 + Math.abs(Math.sin(t * 2.7 + k * 1.7));
        const nR = 0.4 + Math.abs(Math.sin(t * 2.3 + k * 1.3 + 2.0));
        const cL = [EMIT_COLOR[0] * nL, EMIT_COLOR[1] * nL, EMIT_COLOR[2] * nL];
        const cR = [EMIT_COLOR[0] * nR, EMIT_COLOR[1] * nR, EMIT_COLOR[2] * nR];
        splatDensity(0.05 * w, yL, cL, EMIT_RADIUS);
        splatVelocity(0.05 * w, yL, EMIT_IN, EMIT_DOWN + dwob, EMIT_RADIUS);   // gentle right + down
        splatDensity(0.95 * w, yR, cR, EMIT_RADIUS);
        splatVelocity(0.95 * w, yR, -EMIT_IN, EMIT_DOWN - dwob, EMIT_RADIUS);  // gentle left + down
      }
    }

    // pointer-driven splats (window-level since the canvas is pointer-events:none)
    const pointer = { x: 0, y: 0, dx: 0, dy: 0, moved: false };
    function onMove(e) {
      pointer.dx = (e.clientX - pointer.x) * 8.0;
      pointer.dy = (e.clientY - pointer.y) * 8.0;
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true;
    }
    window.addEventListener("pointermove", onMove);

    function resizeCanvas() {
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; initFramebuffers();
      }
    }

    function envelope(elapsed) {   // quick fade-in, hold, slow fade-out (burst)
      const p = elapsed / duration;
      const inn = Math.min(1, elapsed / 500);
      const out = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3);
      return inn * out;
    }

    let lastTime = performance.now();
    const start = lastTime;
    let raf;
    function update(now) {
      resizeCanvas();
      const dt = Math.min((now - lastTime) / 1000, 0.016);
      lastTime = now;
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, tW, tH);

      // pump smoke in from the lower sides (stops part-way through the burst so it
      // can drift up and dissipate)
      if ((now - start) / duration < 0.62) emitSides(now / 1000);

      advectionProgram.bind();
      gl.uniform2f(advectionProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.first[2]);
      gl.uniform1i(advectionProgram.uniforms.uSource, velocity.first[2]);
      gl.uniform1f(advectionProgram.uniforms.dt, dt);
      gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.VELOCITY_DISSIPATION);
      blit(velocity.second[1]); velocity.swap();
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.first[2]);
      gl.uniform1i(advectionProgram.uniforms.uSource, density.first[2]);
      gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.DENSITY_DISSIPATION);
      blit(density.second[1]); density.swap();

      // cursor adds VELOCITY only — it cuts through / shoves the smoke, no new dye
      if (pointer.moved) { splatVelocity(pointer.x, pointer.y, pointer.dx, pointer.dy, CONFIG.SPLAT_RADIUS); pointer.moved = false; }

      // gravity — heavy fog sinks toward the floor (and pools denser there)
      gravityProgram.bind();
      gl.uniform1i(gravityProgram.uniforms.uVelocity, velocity.first[2]);
      gl.uniform1i(gravityProgram.uniforms.uDensity, density.first[2]);
      gl.uniform1f(gravityProgram.uniforms.g, GRAVITY);
      gl.uniform1f(gravityProgram.uniforms.dt, dt);
      blit(velocity.second[1]); velocity.swap();

      curlProgram.bind();
      gl.uniform2f(curlProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.first[2]);
      blit(curl[1]);
      vorticityProgram.bind();
      gl.uniform2f(vorticityProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.first[2]);
      gl.uniform1i(vorticityProgram.uniforms.uCurl, curl[2]);
      gl.uniform1f(vorticityProgram.uniforms.curl, CONFIG.CURL);
      gl.uniform1f(vorticityProgram.uniforms.dt, dt);
      blit(velocity.second[1]); velocity.swap();

      divergenceProgram.bind();
      gl.uniform2f(divergenceProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.first[2]);
      blit(divergence[1]);

      clearProgram.bind();
      let pid = pressure.first[2];
      gl.activeTexture(gl.TEXTURE0 + pid);
      gl.bindTexture(gl.TEXTURE_2D, pressure.first[0]);
      gl.uniform1i(clearProgram.uniforms.uTexture, pid);
      gl.uniform1f(clearProgram.uniforms.value, CONFIG.PRESSURE_DISSIPATION);
      blit(pressure.second[1]); pressure.swap();

      pressureProgram.bind();
      gl.uniform2f(pressureProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence[2]);
      pid = pressure.first[2];
      gl.activeTexture(gl.TEXTURE0 + pid);
      for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
        gl.bindTexture(gl.TEXTURE_2D, pressure.first[0]);
        gl.uniform1i(pressureProgram.uniforms.uPressure, pid);
        blit(pressure.second[1]); pressure.swap();
      }
      gradientProgram.bind();
      gl.uniform2f(gradientProgram.uniforms.texelSize, 1 / tW, 1 / tH);
      gl.uniform1i(gradientProgram.uniforms.uPressure, pressure.first[2]);
      gl.uniform1i(gradientProgram.uniforms.uVelocity, velocity.first[2]);
      blit(velocity.second[1]); velocity.swap();

      // display to the (transparent) screen
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      displayProgram.bind();
      gl.uniform1i(displayProgram.uniforms.uTexture, density.first[2]);
      gl.uniform1f(displayProgram.uniforms.uEnvelope, envelope(now - start));
      gl.uniform1f(displayProgram.uniforms.uTime, (now - start) / 1000);
      blit(null);

      if (now - start < duration) raf = requestAnimationFrame(update);
    }
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    };
  }, [duration]);

  return <canvas ref={ref} className="fx-rave-smoke" />;
}
