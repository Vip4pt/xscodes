// AES 解密配置
const AES_KEY = "my2ecret782ecret"; // ✅ 建议用环境变量 env.AES_KEY
const IV = new TextEncoder().encode(AES_KEY.slice(0, 16));

// MIME 类型快速映射表
const MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

// 全局密钥缓存（Promise 避免重复初始化）
let keyPromise = null;

async function getKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(AES_KEY),
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  }
  return keyPromise;
}

// AES-CBC 解密函数
async function decrypt(encData, keyMaterial) {
  try {
    return await crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, keyMaterial, encData);
  } catch (err) {
    throw new Error("解密失败：" + err.message);
  }
}

// 主图像处理逻辑
async function decryptImage(encImageUrl, keyMaterial, request) {
  const start = performance.now();

  // ✅ 构建最小请求头，避免带 Cookie 或 UA
  const fetchStart = performance.now();
  const res = await fetch(encImageUrl, {
    cf: { cacheEverything: true },
    headers: {
      "If-None-Match": request.headers.get("If-None-Match") || "",
      "If-Modified-Since": request.headers.get("If-Modified-Since") || "",
      Range: request.headers.get("Range") || "",
    },
  });

  // ✅ 直接处理缓存命中
  if (res.status === 304) {
    return new Response(null, {
      status: 304,
      headers: {
        "Cache-Control": "public, max-age=600",
        ETag: res.headers.get("ETag") || "",
      },
    });
  }

  if (!res.ok) throw new Error(`请求失败: ${res.status} ${res.statusText}`);

  // ✅ 获取 MIME
  const url = new URL(encImageUrl);
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  let contentType = MIME_MAP[ext] || res.headers.get("Content-Type") || "image/webp";

  const encData = await res.arrayBuffer();
  const decStart = performance.now();
  const decData = await decrypt(encData, keyMaterial);

  // ✅ 只在 debug 模式下记录性能
  if (request.headers.get("x-debug") === "1") {
    console.log(
      `fetch=${(decStart - fetchStart).toFixed(2)}ms, decrypt=${(
        performance.now() - decStart
      ).toFixed(2)}ms, total=${(performance.now() - start).toFixed(2)}ms, size=${
        encData.byteLength
      }B`
    );
  }

  return new Response(decData, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=600",
      "Content-Disposition": "inline",
      ETag: res.headers.get("ETag") || "",
      "Last-Modified": res.headers.get("Last-Modified") || "",
    },
  });
}

// 入口逻辑
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/") return new Response("Not Found", { status: 404 });

  const imageUrl = url.searchParams.get("imageUrl");
  if (!imageUrl) return new Response("缺少 imageUrl 参数", { status: 400 });

  try {
    const keyMaterial = await getKey();
    return await decryptImage(decodeURIComponent(imageUrl), keyMaterial, request);
  } catch (err) {
    console.error("请求错误:", err.message);
    return new Response(`出错: ${err.message}`, { status: 500 });
  }
}
