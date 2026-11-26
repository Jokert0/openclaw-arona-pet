import { CubismFramework } from "cubism/live2dcubismframework";
import { CubismMatrix44 } from "cubism/math/cubismmatrix44";
import { CubismUserModel } from "cubism/model/cubismusermodel";

class PetModel extends CubismUserModel {
  settlePhysics() {
    this._physics?.stabilization(this.getModel());
  }
  updatePhysics(dt) {
    this._physics?.evaluate(this.getModel(), dt);
  }
}

async function asset(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `模型资源读取失败 (${response.status})：${decodeURIComponent(new URL(url).pathname)}`,
    );
  return response;
}

// Frame the visible neutral mesh once. The exported canvas may include an offset origin or padding.
function modelBounds(model) {
  let left = Infinity,
    right = -Infinity,
    bottom = Infinity,
    top = -Infinity;
  for (let i = 0; i < model.getDrawableCount(); i++) {
    // Reserve the heart's headroom so activating it never clips its top or zooms the pet.
    if (model.getDrawableOpacity(i) <= 0 && model.getDrawableId(i).getString().s !== "ArtMesh17") continue;
    const vertices = model.getDrawableVertexPositions(i);
    for (let j = 0; j < vertices.length; j += 2) {
      left = Math.min(left, vertices[j]);
      right = Math.max(right, vertices[j]);
      bottom = Math.min(bottom, vertices[j + 1]);
      top = Math.max(top, vertices[j + 1]);
    }
  }
  if (!(right > left && top > bottom)) throw new Error("模型缺少可见网格。");
  return {
    width: right - left,
    height: top - bottom,
    x: (left + right) / 2,
    y: (bottom + top) / 2,
  };
}

async function bindTexture(gl, renderer, slot, url) {
  const blob = await (await asset(url)).blob();
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "premultiply",
    colorSpaceConversion: "none",
  });
  try {
    if (Math.max(bitmap.width, bitmap.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error("当前显卡支持的纹理尺寸小于模型贴图。");
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    renderer.bindTexture(slot, texture);
    return texture;
  } finally {
    bitmap.close();
  }
}

export async function mount(canvas, url) {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) throw new Error("WebGL 不可用，请检查硬件加速。");
  const { FileReferences: files } = await (await asset(url)).json();
  const resolve = (name) => new URL(name, url).href;
  const moc = await (await asset(resolve(files.Moc))).arrayBuffer();
  if (!globalThis.Live2DCubismCore) throw new Error("本地脚本未提供 Cubism Core。");
  CubismFramework.startUp();
  CubismFramework.initialize();
  const owner = new PetModel();
  const textures = [];
  let frame;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    owner.release();
    for (const texture of textures) gl.deleteTexture(texture);
    CubismFramework.dispose();
    CubismFramework.cleanUp();
  }
  const matrix = new CubismMatrix44();
  let bounds;
  let viewport;
  function resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = width;
    canvas.height = height;
    const fit = 0.94 * Math.min(width / bounds.width, height / bounds.height);
    const sx = (2 * fit) / width,
      sy = (2 * fit) / height;
    matrix.scale(sx, sy);
    matrix.translate(-bounds.x * sx, -bounds.y * sy);
    viewport = [0, 0, width, height];
  }
  const observer = new ResizeObserver(resize);
  try {
    owner.loadModel(moc, true);
    const model = owner.getModel();
    if (!model) throw new Error("无法读取 MOC3，请检查模型与 Cubism 5 Core 版本。");
    if (files.Physics) {
      const data = await (await asset(resolve(files.Physics))).arrayBuffer();
      owner.loadPhysics(data, data.byteLength);
      owner.settlePhysics();
    }
    owner.createRenderer();
    const renderer = owner.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    for (const [slot, path] of files.Textures.entries()) {
      textures.push(await bindTexture(gl, renderer, slot, resolve(path)));
    }
    bounds = modelBounds(model);
    resize();
    observer.observe(canvas);
    const params = new Map();
    for (let i = 0; i < model.getParameterCount(); i++)
      params.set(model.getParameterId(i).getString().s, i);
    const set = (name, value) => {
      const index = params.get(name);
      if (index !== undefined) model.setParameterValueByIndex(index, value);
    };
    let time = 0,
      last = performance.now(),
      blinkAt = 2,
      pressAt = -Infinity,
      pressUntil = -Infinity,
      heartUntil = -Infinity;
    let squeeze = 0, heart = 0;
    const ids = CubismFramework.getIdManager();
    const haloMesh = model.getDrawableIndex(ids.getId("HitArea2"));
    const heartMesh = model.getDrawableIndex(ids.getId("ArtMesh17"));
    let x = 0,
      y = 0,
      targetX = 0,
      targetY = 0;

    function draw(now) {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      time += dt;
      const follow = 1 - Math.exp(-dt * 7);
      x += (targetX - x) * follow;
      y += (targetY - y) * follow;
      if (time > blinkAt + 0.22) blinkAt = time + 2.5 + Math.random() * 3;
      const lid = 1 - Math.sin(Math.PI * Math.max(0, Math.min(1, (time - blinkAt) / 0.22)));
      squeeze += ((time < pressUntil ? -30 : 0) - squeeze) * Math.min(1, dt * 10);
      const showingHeart = time < heartUntil;
      heart += ((showingHeart ? 30 : 0) - heart) * Math.min(1, dt * (showingHeart ? 14 : 6));
      set("Param5", squeeze);
      set("Param20", heart);
      const sway = Math.sin(time * 1.35);
      set("ParamBreath", 0.5 + 0.48 * sway);
      set("ParamAngleX", 19 * x + 2 * Math.sin(time * 0.71));
      set("ParamAngleY", 14 * y + 1.4 * sway);
      set("ParamAngleZ", 2 * sway);
      set("ParamBodyAngleX", 4 * x + sway);
      set("ParamEyeBallX", x * 0.86);
      set("ParamEyeBallY", y * 0.72);
      set("ParamEyeLOpen", lid);
      set("ParamEyeROpen", lid);
      owner.updatePhysics(dt);
      model.update();
      render();
      frame = requestAnimationFrame(draw);
    }
    function render() {
      gl.viewport(...viewport);
      // Cubism clears its mask framebuffer to white and leaves that clear color active.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.setRenderState(null, viewport);
      renderer.setMvpMatrix(matrix);
      renderer.drawModel();
    }
    draw(performance.now());
    return {
      stop,
      look(tx, ty) {
        targetX = tx;
        targetY = ty;
      },
      hit(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const u = (clientX - rect.left) / rect.width;
        const v = (clientY - rect.top) / rect.height;
        const mx = matrix.invertTransformX(2 * u - 1);
        const my = matrix.invertTransformY(1 - 2 * v);
        // The MOC contains the halo hit mesh even though the JSON omits HitAreas.
        for (const index of [haloMesh, heartMesh]) {
          if (index < 0 || model.getDrawableOpacity(index) < 0.15) continue;
          const vertices = model.getDrawableVertexPositions(index);
          let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
          for (let i = 0; i < vertices.length; i += 2) {
            left = Math.min(left, vertices[i]); right = Math.max(right, vertices[i]);
            bottom = Math.min(bottom, vertices[i + 1]); top = Math.max(top, vertices[i + 1]);
          }
          if (mx >= left && mx <= right && my >= bottom && my <= top) return "halo";
        }
        // Refresh only on press: WebGL can discard the buffer after compositing.
        render();
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.floor(u * canvas.width), canvas.height - 1 - Math.floor(v * canvas.height),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[3] > 20 ? "body" : null;
      },
      press() {
        pressAt = blinkAt = time;
        pressUntil = Infinity;
      },
      release(cancel = false) {
        pressUntil = !cancel && time - pressAt < 0.22 ? time + 0.12 : time;
      },
      pulseHalo() {
        heartUntil = time + 1.5;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
